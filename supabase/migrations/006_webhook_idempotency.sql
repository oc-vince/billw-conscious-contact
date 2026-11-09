-- ============================================================
-- 006 — Stripe webhook idempotency
--
-- Stripe retries a webhook until it receives a 2xx, and may deliver the
-- same event more than once or out of order. Without a dedupe record a
-- retry could assign a second coupon to one order.
--
-- claim_stripe_event() inserts-or-fails atomically: the first caller gets
-- TRUE and processes, every later caller gets FALSE and skips.
--
-- release_stripe_event() exists because the claim is taken BEFORE
-- processing (so two concurrent deliveries can't both assign a coupon).
-- If processing then fails, the claim would make Stripe's retry
-- short-circuit as a duplicate and the event would be lost — so the
-- handler hands the claim back before returning 500.
-- ============================================================

create table public.processed_stripe_events (
  event_id     text primary key,
  event_type   text not null,
  order_id     uuid references public.orders(id) on delete set null,
  processed_at timestamptz not null default now()
);

create index processed_stripe_events_order_idx
  on public.processed_stripe_events (order_id);

alter table public.processed_stripe_events enable row level security;
revoke all on public.processed_stripe_events from anon, authenticated;

-- ── claim ──────────────────────────────────────────────────
create or replace function public.claim_stripe_event(
  p_event_id   text,
  p_event_type text,
  p_order_id   uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.processed_stripe_events (event_id, event_type, order_id)
  values (p_event_id, p_event_type, p_order_id);
  return true;                       -- first time: caller should process
exception when unique_violation then
  return false;                      -- already handled: caller must skip
end;
$$;

-- ── release (for retry after a failed handler) ─────────────
create or replace function public.release_stripe_event(p_event_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_rows integer;
begin
  delete from public.processed_stripe_events where event_id = p_event_id;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- Same PUBLIC-grant trap as migration 003 — revoke from PUBLIC, not just
-- from anon/authenticated, or these remain callable via PostgREST.
revoke all on function public.claim_stripe_event(text, text, uuid) from public;
revoke all on function public.release_stripe_event(text)            from public;

grant execute on function public.claim_stripe_event(text, text, uuid) to service_role;
grant execute on function public.release_stripe_event(text)            to service_role;
