import type { Config, Context } from "@netlify/functions";
import Stripe from "stripe";
import { rpc, select, update, logEvent } from "./_shared/supabase.mts";
import { sendOrderEmails, type OrderForEmail, type CouponForEmail } from "./_shared/email.mts";

/**
 * POST /api/stripe-webhook
 *
 * The ONLY place an order becomes `paid` and a coupon becomes `assigned`.
 * A browser redirect to the success page proves nothing and never triggers
 * either — only a signature-verified Stripe event does.
 *
 * ─── SCOPE GUARD ────────────────────────────────────────────────────────
 * This Stripe account also sells the Paperback, Kitchen Table and Legacy
 * editions through Payment Links, so this endpoint receives their events
 * too. A previous Supabase webhook on this same account counted EVERY
 * payment and ended up deactivating the Legacy Edition Payment Link.
 * Every handler below therefore ignores anything without
 * metadata.source === "christmas_bundle".
 *
 * ─── ASYNC PAYMENT METHODS ──────────────────────────────────────────────
 * Bank (us_bank_account) and Klarna are enabled on this account and settle
 * asynchronously: checkout.session.completed can arrive with
 * payment_status "unpaid". We only finalise on a genuinely paid status,
 * and additionally handle async_payment_succeeded / async_payment_failed.
 */

const SOURCE = "christmas_bundle";

const ok = (body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const bad = (status: number, message: string) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// select() fetches "*", so the row already carries every column the email
// templates need — OrderForEmail just names them for TypeScript.
type OrderRow = OrderForEmail & {
  currency: string;
  payment_status: string;
};

async function findOrder(session: any): Promise<OrderRow | null> {
  const byId = session?.metadata?.order_id;
  if (byId) {
    const rows = await select<OrderRow>("orders", { id: byId });
    if (rows.length) return rows[0];
  }
  if (session?.id) {
    const rows = await select<OrderRow>("orders", { stripe_session_id: session.id });
    if (rows.length) return rows[0];
  }
  return null;
}

/** Finalise a verified payment. Idempotent at every step. */
async function markPaid(stripeObj: any, order: OrderRow, eventType: string) {
  // ── amount + currency must match what WE calculated ──
  const amount = stripeObj.amount_total ?? stripeObj.amount ?? null;
  const currency = String(stripeObj.currency ?? "").toLowerCase();

  if (amount !== order.total_amount) {
    console.error(
      `AMOUNT MISMATCH ${order.order_reference}: stripe=${amount} expected=${order.total_amount}`
    );
    await logEvent(order.id, "amount_mismatch", "Paid amount did not match the order", {
      stripe_amount: amount,
      expected_amount: order.total_amount,
    });
    return; // do NOT assign a coupon or mark paid
  }

  if (currency !== (order.currency ?? "usd")) {
    console.error(
      `CURRENCY MISMATCH ${order.order_reference}: stripe=${currency} expected=${order.currency}`
    );
    await logEvent(order.id, "currency_mismatch", "Paid currency did not match the order", {
      stripe_currency: currency,
      expected_currency: order.currency,
    });
    return;
  }

  // ── claim the order, atomically ──
  // Stripe can deliver checkout.session.completed and
  // payment_intent.succeeded for the same order in the same second.
  // They are different events, so the event-id dedupe lets both through
  // by design — but both would otherwise read payment_status 'pending'
  // and run the whole confirmation path twice. The UPDATE inside
  // claim_order_payment takes a row lock, so exactly one caller gets
  // TRUE and everything below runs once. (See migration 007.)
  const paymentIntentId =
    typeof stripeObj.payment_intent === "string"
      ? stripeObj.payment_intent
      : stripeObj.payment_intent?.id ?? stripeObj.id ?? null;

  const won = await rpc<boolean>("claim_order_payment", {
    p_order_id: order.id,
    p_payment_intent: paymentIntentId,
  });

  if (won !== true) {
    await logEvent(
      order.id,
      "payment_already_confirmed",
      `Duplicate confirmation via ${eventType}; ignored`
    );
    return;
  }

  await logEvent(order.id, "payment_confirmed", `Verified via ${eventType}`, {
    amount,
    currency,
  });

  // ── coupon: reserved -> assigned, only now ──
  let coupon: CouponForEmail | null = null;

  if (order.film_coupon_selected) {
    const assigned = await rpc<
      Array<{ coupon_id: string; code: string; redemption_link: string | null }>
    >("assign_film_coupon", { p_order_id: order.id });
    const row = Array.isArray(assigned) ? assigned[0] : null;
    if (row?.coupon_id) {
      coupon = { code: row.code, redemption_link: row.redemption_link };
      await logEvent(order.id, "coupon_assigned", "Coupon finalised after payment", {
        coupon_id: row.coupon_id,
      });
    } else {
      console.error(`No coupon could be assigned for ${order.order_reference}`);
      await logEvent(order.id, "coupon_assign_failed", "No reserved coupon found");
    }
  }

  // ── emails ──
  // sendOrderEmails never throws: the money is taken and the coupon is
  // issued, so an email outage must not turn into a 500 and a Stripe retry.
  // A failure lands in order_events as confirmation_email_failed instead.
  await sendOrderEmails(order, coupon);
}

/** Give a held coupon back and mark the order dead. */
async function releaseOrder(order: OrderRow, status: "expired" | "failed", why: string) {
  if (order.payment_status === "paid") return; // never undo a paid order
  await rpc("release_film_coupon", { p_order_id: order.id });
  await update("orders", { id: order.id }, { payment_status: status });
  await logEvent(order.id, `checkout_${status}`, why);
}

export default async (req: Request, _ctx: Context) => {
  if (req.method !== "POST") return bad(405, "Method not allowed");

  const secret = process.env.STRIPE_SECRET_KEY;
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !whSecret) {
    console.error("STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET is not set");
    return bad(500, "Webhook not configured");
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) return bad(400, "Missing stripe-signature header");

  // Raw body — constructEvent must see the exact bytes Stripe signed.
  const raw = await req.text();

  const stripe = new Stripe(secret);
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, signature, whSecret);
  } catch (err: any) {
    console.error("Signature verification failed:", err?.message ?? err);
    return bad(400, "Invalid signature");
  }

  const obj: any = event.data.object;

  // ── scope guard ──
  if (obj?.metadata?.source !== SOURCE) {
    return ok({ ignored: true, reason: "not a christmas_bundle event" });
  }

  try {
    const order = await findOrder(obj);
    if (!order) {
      console.error(`No order for event ${event.id} (${event.type})`);
      // 200 so Stripe stops retrying something we can never resolve
      return ok({ ignored: true, reason: "order not found" });
    }

    // ── idempotency: first caller wins ──
    const claimed = await rpc<boolean>("claim_stripe_event", {
      p_event_id: event.id,
      p_event_type: event.type,
      p_order_id: order.id,
    });
    if (claimed !== true) {
      return ok({ duplicate: true, event: event.id });
    }

    switch (event.type) {
      case "checkout.session.completed": {
        // async methods can complete the session while still unpaid
        if (obj.payment_status === "paid") {
          await markPaid(obj, order, event.type);
        } else {
          await logEvent(
            order.id,
            "checkout_completed_unpaid",
            `Session completed with payment_status=${obj.payment_status}; awaiting settlement`
          );
        }
        break;
      }

      case "checkout.session.async_payment_succeeded":
        await markPaid(obj, order, event.type);
        break;

      case "checkout.session.async_payment_failed":
        await releaseOrder(order, "failed", "Asynchronous payment failed");
        break;

      case "checkout.session.expired":
        await releaseOrder(order, "expired", "Checkout session expired");
        break;

      case "payment_intent.payment_failed":
        await releaseOrder(order, "failed", "Payment failed");
        break;

      case "payment_intent.succeeded":
        // Belt and braces — the session events are authoritative, but if a
        // PI succeeds and the order is somehow still pending, record it.
        if (order.payment_status !== "paid") {
          await markPaid(obj, order, event.type);
        }
        break;

      default:
        await logEvent(order.id, "stripe_event_ignored", event.type);
    }

    return ok({ received: true, event: event.id, type: event.type });
  } catch (err: any) {
    console.error(`Webhook handling failed for ${event.id}:`, err?.message ?? err);

    // The claim is taken BEFORE processing so two concurrent deliveries
    // can't both assign a coupon. But that means a failure here would make
    // Stripe's retry short-circuit as a duplicate and lose the event, so
    // hand the claim back before asking for a retry.
    try {
      await rpc("release_stripe_event", { p_event_id: event.id });
    } catch (releaseErr: any) {
      console.error("Could not release event claim:", releaseErr?.message ?? releaseErr);
    }

    return bad(500, "Handler error");
  }
};

export const config: Config = {
  path: "/api/stripe-webhook",
};
