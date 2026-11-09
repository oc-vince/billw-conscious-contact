import type { Config, Context } from "@netlify/functions";
import Stripe from "stripe";
import {
  getBundle,
  priceOrder,
  FILM_ADDON_CENTS,
  FILM_ADDON_NAME,
} from "./_shared/bundles.mts";
import { revalidateRate } from "./_shared/shippo.mts";
import { insert, update, rpc, logEvent } from "./_shared/supabase.mts";
import { newOrderReference, newAccessToken, hashToken } from "./_shared/orders.mts";

/**
 * POST /api/create-checkout
 *
 * The single place an order and a Stripe session are created.
 *
 * SECURITY MODEL
 * - The browser sends: bundle id, film flag, contact, address, rateId.
 * - It never sends a price. Product and add-on amounts come from
 *   bundles.mts; the shipping amount is re-read from Shippo via
 *   revalidateRate(), so a tampered rateId or amount changes nothing.
 * - A coupon is RESERVED here, never assigned. Assignment happens only in
 *   the webhook after Stripe confirms payment.
 */

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const str = (v: unknown, max = 100) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default async (req: Request, _ctx: Context) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    console.error("STRIPE_SECRET_KEY is not set");
    return json(500, { error: "Checkout is not configured." });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  // ── 1. product (server-authoritative) ────────────────────
  const bundle = getBundle(payload?.bundle);
  if (!bundle) return json(400, { error: "Unknown bundle" });

  const wantsFilm = payload?.film === true || payload?.film === "1";

  // ── 2. contact ───────────────────────────────────────────
  const firstName = str(payload?.firstName, 60);
  const lastName = str(payload?.lastName, 60);
  const email = str(payload?.email, 254).toLowerCase();
  const phone = str(payload?.phone, 32);

  if (!firstName || !lastName) return json(400, { error: "Name is required", fields: ["firstName", "lastName"] });
  if (!EMAIL_RE.test(email)) return json(400, { error: "A valid email is required", fields: ["email"] });

  // ── 3. address ───────────────────────────────────────────
  const a = payload?.address ?? {};
  const address = {
    name: `${firstName} ${lastName}`.trim(),
    street1: str(a.street1),
    street2: str(a.street2),
    city: str(a.city),
    state: str(a.state, 32).toUpperCase(),
    zip: str(a.zip, 16),
    country: (str(a.country, 2) || "US").toUpperCase(),
  };
  const missing = (["street1", "city", "state", "zip"] as const).filter((k) => !address[k]);
  if (missing.length) return json(400, { error: "Incomplete address", fields: missing });
  if (address.country !== "US") {
    return json(400, { error: "We can only ship within the United States at this time." });
  }

  // ── 4. shipping — re-read from Shippo, never trusted ─────
  const rateId = str(payload?.rateId, 64);
  if (!rateId) return json(400, { error: "Please choose a shipping service." });

  const rate = await revalidateRate(rateId);
  if (!rate) {
    return json(409, {
      error: "That shipping quote has expired. Please recalculate shipping and try again.",
      code: "RATE_EXPIRED",
    });
  }

  // ── 5. totals — the only place money is computed ─────────
  const totals = priceOrder(bundle, wantsFilm, rate.amountCents);

  let orderId: string | null = null;

  try {
    // ── 6. order record (pending) ──────────────────────────
    const accessToken = newAccessToken();
    const order = await insert("orders", {
      order_reference: newOrderReference(),
      customer_name: address.name,
      customer_email: email,
      phone: phone || null,
      shipping_address: address,
      product_type: bundle.id,
      product_price: totals.productCents,
      film_coupon_selected: wantsFilm,
      film_coupon_amount: totals.filmCents,
      shipping_cost: totals.shippingCents,
      shipping_service: rate.service,
      shipping_rate_id: rate.rateId,
      shipping_parcel: bundle.parcel,
      total_amount: totals.totalCents,
      currency: "usd",
      payment_status: "pending",
      access_token_hash: hashToken(accessToken),
    });
    orderId = order.id;

    await logEvent(order.id, "order_created", "Checkout started", {
      bundle: bundle.id,
      film: wantsFilm,
      shipping_service: rate.service,
      total_cents: totals.totalCents,
    });

    // ── 7. reserve a coupon (never assign) ─────────────────
    if (wantsFilm) {
      const couponId = await rpc<string | null>("reserve_film_coupon", {
        p_order_id: order.id,
      });

      if (!couponId) {
        await update("orders", { id: order.id }, { payment_status: "failed" });
        await logEvent(order.id, "coupon_sold_out", "No film coupons remained");
        return json(409, {
          error:
            "The film coupon has just sold out. Please uncheck it and continue, or contact us.",
          code: "COUPON_SOLD_OUT",
        });
      }

      await update("orders", { id: order.id }, { film_coupon_id: couponId });
      await logEvent(order.id, "coupon_reserved", "Coupon held pending payment", {
        coupon_id: couponId,
      });
    }

    // ── 8. Stripe Checkout Session ─────────────────────────
    // No apiVersion override: the SDK pins the version it was built against,
    // which is safer than hardcoding a string that may not exist.
    const stripe = new Stripe(secret);

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: totals.productCents,
          product_data: {
            name: `Christmas Bundle — ${bundle.name}`,
            description: "Bill W. Conscious Contact",
          },
        },
      },
    ];

    if (wantsFilm) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: FILM_ADDON_CENTS,
          product_data: {
            name: FILM_ADDON_NAME,
            description: "Digital access code, emailed after purchase",
          },
        },
      });
    }

    // Shipping is a line item rather than a shipping_option: shipping_options
    // are tied to Stripe collecting the address, and we already have it. This
    // keeps the total exact and avoids asking the customer twice.
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: totals.shippingCents,
        product_data: {
          name: `Shipping — ${rate.service}`,
          description: "USPS, calculated for your address",
        },
      },
    });

    const origin = new URL(req.url).origin;
    const metadata = {
      order_id: order.id,
      order_reference: order.order_reference,
      bundle: bundle.id,
      film: wantsFilm ? "1" : "0",
      // lets the webhook ignore events from other products on this Stripe
      // account — the exact failure mode that broke the Legacy Edition link
      source: "christmas_bundle",
    };

    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        line_items: lineItems,
        customer_email: email,
        client_reference_id: order.order_reference,
        metadata,
        payment_intent_data: { metadata },
        // We already collected the address — do not ask again.
        billing_address_collection: "auto",
        success_url: `${origin}/christmas-bundle/order-confirmation?t=${accessToken}`,
        cancel_url: `${origin}/christmas-bundle/checkout?bundle=${bundle.id}${wantsFilm ? "&film=1" : ""}`,
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60, // matches the coupon hold
      },
      { idempotencyKey: `order-${order.id}` }
    );

    await update("orders", { id: order.id }, { stripe_session_id: session.id });
    await logEvent(order.id, "stripe_session_created", "Redirecting to Stripe", {
      session_id: session.id,
      amount_total: session.amount_total,
    });

    // Last line of defence: Stripe's own total must equal ours.
    if (session.amount_total !== totals.totalCents) {
      console.error(
        `Total mismatch on ${order.id}: stripe=${session.amount_total} expected=${totals.totalCents}`
      );
    }

    return json(200, { url: session.url, orderReference: order.order_reference });
  } catch (err: any) {
    console.error("create-checkout failed:", err?.message ?? err);

    // Release the hold so an error does not silently burn a coupon.
    if (orderId) {
      try {
        await rpc("release_film_coupon", { p_order_id: orderId });
        await update("orders", { id: orderId }, { payment_status: "failed" });
        await logEvent(orderId, "checkout_error", err?.message ?? "unknown");
      } catch (cleanupErr: any) {
        console.error("cleanup failed:", cleanupErr?.message ?? cleanupErr);
      }
    }

    return json(502, { error: "We couldn't start checkout. Please try again." });
  }
};

export const config: Config = {
  path: "/api/create-checkout",
};
