-- ============================================================
-- 007 — Serialise payment confirmation on the order row
--
-- WHY THIS EXISTS (found in live testing, 9 Nov 2026)
--
-- Stripe delivered checkout.session.completed and
-- payment_intent.succeeded for the same order in the same second.
-- Both are distinct events, so claim_stripe_event() let both through
-- (it dedupes by event id, which is correct — they ARE different
-- events). Both handlers then read the order row before either wrote
-- to it, so both saw payment_status = 'pending' and both ran the
-- whole confirmation path:
--
--   • two payment_confirmed rows in order_events
--   • assign_film_coupon() called twice — one won, one logged
--     coupon_assign_failed
--   • two confirmation emails attempted; Resend's idempotency key
--     rejected the second with a 409
--
-- Nothing was double-charged and no second coupon was issued, but
-- only because the SQL function and Resend each caught it downstream.
-- That is luck, not design: the order row itself was never the
-- serialisation point.
--
-- claim_order_payment() makes it one. The UPDATE takes a row lock, so
-- a concurrent caller blocks until the first commits, then re-evaluates
-- its WHERE clause under READ COMMITTED, sees 'paid', updates zero rows
-- and gets FALSE. Exactly one caller is ever told to proceed.
-- ============================================================

create or replace function public.claim_order_payment(
  p_order_id       uuid,
  p_payment_intent text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_rows integer;
begin
  update public.orders
     set payment_status           = 'paid',
         stripe_payment_intent_id = coalesce(p_payment_intent, stripe_payment_intent_id)
   where id = p_order_id
     and payment_status is distinct from 'paid';

  get diagnostics v_rows = row_count;
  return v_rows > 0;          -- true for exactly one caller
end;
$$;

-- ── LOCKDOWN — both halves are required ───────────────────
-- Postgres grants EXECUTE to PUBLIC by default, AND Supabase grants it
-- explicitly to anon/authenticated on new functions in the public
-- schema. Revoking only one leaves the function callable via PostgREST.
--
-- If anon could call this, it could mark any order paid without paying.
revoke all on function public.claim_order_payment(uuid, text)
  from public, anon, authenticated;

grant execute on function public.claim_order_payment(uuid, text) to service_role;

-- Verify after running — both columns must be false:
--   select proname,
--          has_function_privilege('anon', oid, 'execute') as anon,
--          has_function_privilege('authenticated', oid, 'execute') as auth
--     from pg_proc where proname = 'claim_order_payment';
