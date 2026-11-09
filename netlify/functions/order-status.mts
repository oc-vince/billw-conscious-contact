import type { Config, Context } from "@netlify/functions";
import { getBundle } from "./_shared/bundles.mts";
import { select } from "./_shared/supabase.mts";
import { hashToken } from "./_shared/orders.mts";

/**
 * GET /api/order-status?t=<access token>
 *
 * Backs the order confirmation page.
 *
 * SECURITY MODEL
 * - The only key is the 32-byte token handed to the customer in the success
 *   URL. The database stores its SHA-256, so the lookup is by hash and a
 *   database leak yields nothing that can read an order back.
 * - The token is not sequential and not derived from the order, so it can't
 *   be guessed or enumerated.
 * - The response is a curated subset. No Stripe ids, no payment intent, no
 *   internal uuids, no access token hash, no shipping rate id.
 * - The coupon code is returned ONLY once the coupon is actually assigned,
 *   which only happens after the webhook verifies payment. A pending order
 *   never leaks a code.
 */

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      // Never let a CDN or browser keep a page keyed by someone's token.
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      "Referrer-Policy": "no-referrer",
    },
  });

type OrderRow = {
  id: string;
  order_reference: string;
  customer_name: string;
  customer_email: string;
  shipping_address: Record<string, string>;
  product_type: string;
  product_price: number;
  film_coupon_selected: boolean;
  film_coupon_amount: number;
  shipping_cost: number;
  shipping_service: string;
  total_amount: number;
  payment_status: string;
  tracking_number: string | null;
  tracking_url: string | null;
};

type CouponRow = { code: string; redemption_link: string | null; status: string };

export default async (req: Request, _ctx: Context) => {
  if (req.method !== "GET") return json(405, { error: "Method not allowed" });

  const token = new URL(req.url).searchParams.get("t")?.trim() ?? "";

  // Length check first — a malformed token should not reach the database.
  if (!token || token.length < 20 || token.length > 200) {
    return json(400, { error: "Missing or malformed order link." });
  }

  let order: OrderRow | undefined;
  try {
    const rows = await select<OrderRow>("orders", {
      access_token_hash: hashToken(token),
    });
    order = rows[0];
  } catch (err: any) {
    console.error("order-status lookup failed:", err?.message ?? err);
    return json(502, { error: "We couldn't load your order. Please try again." });
  }

  if (!order) {
    // Deliberately identical to a malformed token: no signal about whether
    // a given token ever existed.
    return json(404, { error: "We couldn't find that order." });
  }

  // ── coupon, only once genuinely assigned ──
  let coupon: { code: string; redemptionLink: string | null } | null = null;
  if (order.film_coupon_selected && order.payment_status === "paid") {
    try {
      const rows = await select<CouponRow>("film_coupons", {
        assigned_order_id: order.id,
        status: "assigned",
      });
      if (rows[0]) {
        coupon = { code: rows[0].code, redemptionLink: rows[0].redemption_link };
      }
    } catch (err: any) {
      // The order still renders; the email carries the code too.
      console.error("coupon lookup failed:", err?.message ?? err);
    }
  }

  const bundle = getBundle(order.product_type);
  const a = order.shipping_address ?? {};

  return json(200, {
    reference: order.order_reference,
    status: order.payment_status,
    firstName: (order.customer_name || "").split(" ")[0],
    email: order.customer_email,
    bundle: { id: order.product_type, name: bundle?.name ?? order.product_type },
    filmSelected: order.film_coupon_selected,
    amounts: {
      product: order.product_price,
      film: order.film_coupon_amount,
      shipping: order.shipping_cost,
      total: order.total_amount,
      currency: "usd",
    },
    shipping: {
      service: order.shipping_service,
      address: {
        name: a.name ?? order.customer_name,
        street1: a.street1 ?? "",
        street2: a.street2 ?? "",
        city: a.city ?? "",
        state: a.state ?? "",
        zip: a.zip ?? "",
        country: a.country ?? "US",
      },
      trackingNumber: order.tracking_number,
      trackingUrl: order.tracking_url,
    },
    coupon,
  });
};

export const config: Config = {
  path: "/api/order-status",
};
