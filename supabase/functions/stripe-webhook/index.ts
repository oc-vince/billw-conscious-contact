// ============================================================
// LEGACY EDITION — Supabase Edge Function: stripe-webhook
// Path: supabase/functions/stripe-webhook/index.ts
// ============================================================
// Environment variables required (set in Supabase Dashboard →
// Project Settings → Edge Functions → Secrets):
//
//   STRIPE_SECRET_KEY       — your Stripe live secret key (sk_live_...)
//   STRIPE_WEBHOOK_SECRET   — from Stripe Dashboard → Webhooks → signing secret
//   STRIPE_PAYMENT_LINK_ID  — e.g. plink_1ABC123... (NOT the URL, the ID)
//   SUPABASE_URL            — auto-set by Supabase
//   SUPABASE_SERVICE_ROLE_KEY — auto-set by Supabase
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@12.18.0?target=deno&no-check";

const BOOK_LIMIT = 135;

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2022-11-15",
  httpClient: Stripe.createFetchHttpClient(),
});

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req: Request) => {
  // Only accept POST
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  const body = await req.text();

  // Verify webhook signature
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      Deno.env.get("STRIPE_WEBHOOK_SECRET")!
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  // Only process completed checkouts
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    console.log("Checkout completed:", session.id);

    // Increment sold count atomically
    const { data: newCount, error } = await supabase.rpc("increment_sold_count");

    if (error) {
      console.error("Failed to increment sold_count:", error.message);
      return new Response("Database error", { status: 500 });
    }

    console.log(`Books sold: ${newCount} / ${BOOK_LIMIT}`);

    // Disable the Payment Link once limit is reached
    if (newCount >= BOOK_LIMIT) {
      const paymentLinkId = Deno.env.get("STRIPE_PAYMENT_LINK_ID");
      if (paymentLinkId) {
        try {
          await stripe.paymentLinks.update(paymentLinkId, { active: false });
          console.log("Payment Link deactivated — 135 books sold.");
        } catch (err) {
          console.error("Failed to deactivate Payment Link:", err.message);
          // Non-fatal: the page JS will still show SOLD OUT via the DB check
        }
      }
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
});
