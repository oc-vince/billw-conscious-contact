import { getBundle } from "./bundles.mts";
import { update, logEvent } from "./supabase.mts";

/**
 * Transactional email via Resend.
 *
 * Raw fetch rather than the `resend` SDK, matching shippo.mts and
 * supabase.mts: two POSTs to one endpoint don't justify a dependency, and
 * the SDK's `{ data, error }` return (it does not throw) is an easy thing
 * to get wrong at a call site.
 *
 * ─── THE RULE THAT MATTERS ──────────────────────────────────────────────
 * Nothing in here may throw into the webhook. The payment is already taken
 * and the coupon already assigned by the time we are called; if Resend is
 * down, that must not turn into a 500, because Stripe would retry an event
 * whose real work is finished. Every failure is swallowed and written to
 * the order audit trail instead, so a missing email is visible and can be
 * resent by hand.
 */

const API = "https://api.resend.com/emails";

type SendArgs = {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  /** `<event-type>/<entity-id>`; Resend dedupes on it for 24h. */
  idempotencyKey: string;
  replyTo?: string;
};

async function send(args: SendArgs): Promise<{ id: string } | null> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!key || !from) {
    console.error("RESEND_API_KEY or EMAIL_FROM is not set — skipping email");
    return null;
  }

  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "Idempotency-Key": args.idempotencyKey,
    },
    body: JSON.stringify({
      from,
      to: Array.isArray(args.to) ? args.to : [args.to],
      subject: args.subject,
      html: args.html,
      text: args.text,
      ...(args.replyTo ? { reply_to: args.replyTo } : {}),
    }),
  });

  const body: any = await res.json().catch(() => null);

  if (!res.ok) {
    // 403 almost always means the EMAIL_FROM domain isn't verified yet.
    throw new Error(
      `Resend ${res.status}: ${body?.message ?? body?.name ?? "unknown error"}`
    );
  }

  return body?.id ? { id: body.id } : null;
}

// ── formatting ────────────────────────────────────────────────────────────

const money = (cents: number) =>
  `$${(cents / 100).toFixed(2)}`;

/** Escape anything that reaches HTML — customer name and address are user input. */
const esc = (v: unknown) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export type OrderForEmail = {
  id: string;
  order_reference: string;
  customer_name: string;
  customer_email: string;
  phone: string | null;
  shipping_address: Record<string, string>;
  product_type: string;
  product_price: number;
  film_coupon_selected: boolean;
  film_coupon_amount: number;
  shipping_cost: number;
  shipping_service: string;
  shipping_parcel: Record<string, string> | null;
  total_amount: number;
  confirmation_email_sent_at: string | null;
};

// The redemption URL is deliberately not carried here. The code is issued
// on its own; no link is shown to the customer anywhere.
export type CouponForEmail = { code: string };

function addressLines(a: Record<string, string>): string[] {
  return [
    a.name,
    a.street1,
    a.street2 || "",
    [a.city, a.state, a.zip].filter(Boolean).join(", "),
    a.country === "US" ? "United States" : a.country,
  ].filter((l) => l && l.trim());
}

// ── customer confirmation ─────────────────────────────────────────────────

function customerHtml(order: OrderForEmail, coupon: CouponForEmail | null): string {
  const bundle = getBundle(order.product_type);
  const bundleName = bundle?.name ?? order.product_type;
  const addr = addressLines(order.shipping_address).map(esc).join("<br>");

  const row = (label: string, note: string, amount: number) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #eee;">
        <div style="color:#1a1a1a;font-size:15px;">${esc(label)}</div>
        <div style="color:#777;font-size:13px;">${esc(note)}</div>
      </td>
      <td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right;color:#1a1a1a;font-size:15px;white-space:nowrap;">
        ${money(amount)}
      </td>
    </tr>`;

  const couponBlock = coupon
    ? `
    <div style="margin:28px 0;padding:20px;background:#faf6ec;border:1px solid #e2d3ab;border-radius:4px;">
      <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8a6d2f;margin-bottom:8px;">
        Your Film Access Code
      </div>
      <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:22px;font-weight:600;color:#1a1a1a;letter-spacing:.04em;">
        ${esc(coupon.code)}
      </div>
      <div style="margin-top:12px;color:#6b5a38;font-size:13px;line-height:1.5;">
        Keep this email — the code is yours and can be redeemed at any time.
      </div>
    </div>`
    : "";

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f2ed;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2ed;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:560px;background:#ffffff;border-radius:6px;overflow:hidden;font-family:Georgia,'Times New Roman',serif;">

        <tr><td style="background:#141414;padding:28px 32px;text-align:center;">
          <div style="color:#d8bd86;font-size:19px;letter-spacing:.06em;">Bill W. Conscious Contact</div>
        </td></tr>

        <tr><td style="padding:32px;">
          <h1 style="margin:0 0 6px;font-size:23px;color:#1a1a1a;font-weight:normal;">Thank you, ${esc(
            order.customer_name.split(" ")[0]
          )}.</h1>
          <p style="margin:0 0 4px;color:#555;font-size:15px;line-height:1.6;">
            Your order is confirmed and payment has been received.
          </p>
          <p style="margin:0 0 24px;color:#777;font-size:14px;">
            Order reference <strong style="color:#1a1a1a;">${esc(order.order_reference)}</strong>
          </p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:Helvetica,Arial,sans-serif;">
            ${row(`Christmas Bundle — ${bundleName}`, "Bill W. Conscious Contact", order.product_price)}
            ${
              order.film_coupon_selected
                ? row("Film Access Coupon", "Digital access code", order.film_coupon_amount)
                : ""
            }
            ${row(`Shipping — ${order.shipping_service}`, "USPS", order.shipping_cost)}
            <tr>
              <td style="padding:14px 0 0;font-size:16px;color:#1a1a1a;font-weight:bold;">Total</td>
              <td style="padding:14px 0 0;font-size:16px;color:#1a1a1a;font-weight:bold;text-align:right;">
                ${money(order.total_amount)}
              </td>
            </tr>
          </table>

          ${couponBlock}

          <div style="margin-top:28px;font-family:Helvetica,Arial,sans-serif;">
            <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8a8a8a;margin-bottom:8px;">
              Shipping to
            </div>
            <div style="color:#1a1a1a;font-size:15px;line-height:1.6;">${addr}</div>
            <p style="margin:16px 0 0;color:#666;font-size:14px;line-height:1.6;">
              Your parcel ships by USPS ${esc(order.shipping_service)}. We'll email tracking
              details as soon as it leaves us.
            </p>
          </div>
        </td></tr>

        <tr><td style="background:#faf9f6;padding:22px 32px;border-top:1px solid #ececec;font-family:Helvetica,Arial,sans-serif;">
          <p style="margin:0;color:#777;font-size:13px;line-height:1.6;">
            Questions about this order? Just reply to this email and we'll help.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

function customerText(order: OrderForEmail, coupon: CouponForEmail | null): string {
  const bundle = getBundle(order.product_type);
  const lines = [
    `Thank you, ${order.customer_name.split(" ")[0]}.`,
    ``,
    `Your order is confirmed and payment has been received.`,
    `Order reference: ${order.order_reference}`,
    ``,
    `Christmas Bundle - ${bundle?.name ?? order.product_type}   ${money(order.product_price)}`,
  ];
  if (order.film_coupon_selected) {
    lines.push(`Film Access Coupon                      ${money(order.film_coupon_amount)}`);
  }
  lines.push(
    `Shipping - ${order.shipping_service} (USPS)   ${money(order.shipping_cost)}`,
    `Total                                   ${money(order.total_amount)}`,
    ``
  );
  if (coupon) {
    lines.push(
      `YOUR FILM ACCESS CODE: ${coupon.code}`,
      `Keep this email - the code is yours and can be redeemed at any time.`,
      ``
    );
  }
  lines.push(
    `Shipping to:`,
    ...addressLines(order.shipping_address),
    ``,
    `Your parcel ships by USPS ${order.shipping_service}. We'll email tracking details`,
    `as soon as it leaves us.`,
    ``,
    `Questions? Just reply to this email.`,
    `Bill W. Conscious Contact`
  );
  return lines.filter((l) => l !== undefined).join("\n");
}

// ── internal fulfilment alert ─────────────────────────────────────────────

function adminHtml(order: OrderForEmail, coupon: CouponForEmail | null): string {
  const bundle = getBundle(order.product_type);
  const p = order.shipping_parcel ?? {};
  const addr = addressLines(order.shipping_address).map(esc).join("<br>");

  const cell = (label: string, value: string) => `
    <tr>
      <td style="padding:7px 12px 7px 0;color:#777;font-size:13px;vertical-align:top;white-space:nowrap;">${esc(label)}</td>
      <td style="padding:7px 0;color:#1a1a1a;font-size:14px;">${value}</td>
    </tr>`;

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f6f6;font-family:Helvetica,Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;margin:0 auto;background:#fff;border-radius:6px;">
    <tr><td style="padding:24px;">
      <h1 style="margin:0 0 4px;font-size:18px;color:#1a1a1a;">New order — ${esc(order.order_reference)}</h1>
      <p style="margin:0 0 20px;color:#777;font-size:14px;">
        ${esc(bundle?.name ?? order.product_type)}${order.film_coupon_selected ? " + film coupon" : ""}
        · ${money(order.total_amount)} paid
      </p>

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
        ${cell("Ship to", addr)}
        ${cell("Service", `USPS ${esc(order.shipping_service)}`)}
        ${cell(
          "Parcel",
          `${esc(p.length)} × ${esc(p.width)} × ${esc(p.height)} ${esc(p.distance_unit)}, ${esc(
            p.weight
          )} ${esc(p.mass_unit)}`
        )}
        ${cell("Email", esc(order.customer_email))}
        ${cell("Phone", esc(order.phone || "—"))}
        ${coupon ? cell("Coupon issued", esc(coupon.code)) : ""}
      </table>

      <p style="margin:20px 0 0;color:#999;font-size:12px;">
        Payment confirmed by Stripe. Pack and ship this parcel, then record the tracking number.
      </p>
    </td></tr>
  </table>
</body></html>`;
}

function adminText(order: OrderForEmail, coupon: CouponForEmail | null): string {
  const bundle = getBundle(order.product_type);
  const p = order.shipping_parcel ?? {};
  return [
    `New order - ${order.order_reference}`,
    `${bundle?.name ?? order.product_type}${order.film_coupon_selected ? " + film coupon" : ""} - ${money(
      order.total_amount
    )} paid`,
    ``,
    `Ship to:`,
    ...addressLines(order.shipping_address),
    ``,
    `Service: USPS ${order.shipping_service}`,
    `Parcel:  ${p.length} x ${p.width} x ${p.height} ${p.distance_unit}, ${p.weight} ${p.mass_unit}`,
    `Email:   ${order.customer_email}`,
    `Phone:   ${order.phone || "-"}`,
    coupon ? `Coupon:  ${coupon.code}` : ``,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// ── entry point ───────────────────────────────────────────────────────────

/**
 * Send the customer confirmation and the internal fulfilment alert.
 * Safe to call more than once: a non-null confirmation_email_sent_at short
 * circuits, and Resend's idempotency key catches the race where two
 * webhook deliveries get past that check at the same moment.
 */
export async function sendOrderEmails(
  order: OrderForEmail,
  coupon: CouponForEmail | null
): Promise<void> {
  if (order.confirmation_email_sent_at) {
    return; // already sent
  }

  // ── customer ──
  try {
    const sent = await send({
      to: order.customer_email,
      subject: `Your order is confirmed — ${order.order_reference}`,
      html: customerHtml(order, coupon),
      text: customerText(order, coupon),
      idempotencyKey: `order-confirmation/${order.id}`,
      replyTo: process.env.EMAIL_REPLY_TO || undefined,
    });

    await update("orders", { id: order.id }, {
      confirmation_email_sent_at: new Date().toISOString(),
    });

    await logEvent(order.id, "confirmation_email_sent", "Customer confirmation sent", {
      email_id: sent?.id ?? null,
      to: order.customer_email,
      coupon_included: Boolean(coupon),
    });
  } catch (err: any) {
    console.error(`Confirmation email failed for ${order.order_reference}:`, err?.message ?? err);
    await logEvent(
      order.id,
      "confirmation_email_failed",
      err?.message ?? "unknown error",
      { to: order.customer_email }
    );
  }

  // ── internal alert — independent of the customer send ──
  const alertTo = process.env.ORDER_ALERT_EMAIL;
  if (!alertTo) return;

  try {
    const sent = await send({
      to: alertTo.split(",").map((s) => s.trim()).filter(Boolean),
      subject: `New order ${order.order_reference} — ${
        getBundle(order.product_type)?.name ?? order.product_type
      }`,
      html: adminHtml(order, coupon),
      text: adminText(order, coupon),
      idempotencyKey: `order-alert/${order.id}`,
      replyTo: order.customer_email,
    });
    await logEvent(order.id, "order_alert_sent", "Fulfilment alert sent", {
      email_id: sent?.id ?? null,
    });
  } catch (err: any) {
    console.error(`Order alert failed for ${order.order_reference}:`, err?.message ?? err);
    await logEvent(order.id, "order_alert_failed", err?.message ?? "unknown error");
  }
}
