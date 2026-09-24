// ============================================================
// LEGACY EDITION — Supabase Edge Function: stripe-webhook
// Path: supabase/functions/stripe-webhook/index.ts
// ============================================================
// DISABLED 2026-09-23 — automatic sold-count tracking is OFF.
//
// Why: this function incremented `book_sales.sold_count` on EVERY
// successful payment on the Stripe account (Kitchen Table, Paperback,
// merch — not just Legacy Edition), and deactivated the Legacy Edition
// Payment Link once that inflated count hit BOOK_LIMIT. That is what
// deactivated buy.stripe.com/6oU28r8s46ABfbm5xgaIM02.
//
// Remaining stock is now tracked MANUALLY: update the "Only N Left"
// copy in index.html / book.html / purchase.html by hand, and
// activate or deactivate the Payment Link in the Stripe Dashboard.
//
// This function now only acknowledges events so Stripe does not retry
// or flag the endpoint as failing. It never writes to the database and
// never calls the Stripe API. The previous behaviour is preserved in
// index.ts.bak-autocount if it is ever needed again.
//
// Environment variables still required:
//   STRIPE_SECRET_KEY       — used only to verify webhook signatures
//   STRIPE_WEBHOOK_SECRET   — Stripe Dashboard → Webhooks → signing secret
//
// STRIPE_PAYMENT_LINK_ID is no longer used and can be removed from the
// Edge Function secrets.
// ============================================================

import Stripe from "https://esm.sh/stripe@12.18.0?target=deno&no-check";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2022-11-15",
  httpClient: Stripe.createFetchHttpClient(),
});

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  const body = await req.text();

  // Still verify the signature so this endpoint can't be used as an open
  // POST target, but take no action on the event.
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      Deno.env.get("STRIPE_WEBHOOK_SECRET")!
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  // ── Automatic sold-count tracking is disabled. ──
  // No increment_sold_count() call. No paymentLinks.update() call.
  // Stock is managed by hand in Stripe and in the page copy.
  console.log(`Received ${event.type} (${event.id}) — sold-count tracking disabled, no action taken.`);

  return new Response(JSON.stringify({ received: true, action: "none" }), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
});
