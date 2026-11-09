-- ============================================================
-- 001 — Christmas Bundle schema
--
-- All monetary values are stored as INTEGER CENTS (USD) to match
-- Stripe's unit_amount and avoid floating-point rounding.
--
-- Run in: Supabase Dashboard -> SQL Editor -> New query
-- ============================================================

create extension if not exists pgcrypto;

-- ── film_coupons ───────────────────────────────────────────
create table public.film_coupons (
  id                uuid primary key default gen_random_uuid(),
  code              text        not null unique,
  redemption_link   text        not null,
  active            boolean     not null default true,
  status            text        not null default 'available'
                      check (status in ('available','reserved','assigned')),
  reserved_order_id uuid,
  reserved_until    timestamptz,
  assigned_order_id uuid,
  assigned_at       timestamptz,
  created_at        timestamptz not null default now(),

  -- a reserved row must carry both order and expiry; an assigned row must
  -- carry both order and timestamp. Guards against half-written states.
  constraint reserved_fields_consistent check (
    (status <> 'reserved')
    or (reserved_order_id is not null and reserved_until is not null)
  ),
  constraint assigned_fields_consistent check (
    (status <> 'assigned')
    or (assigned_order_id is not null and assigned_at is not null)
  )
);

-- one coupon can never be assigned to two orders
create unique index film_coupons_assigned_order_uniq
  on public.film_coupons (assigned_order_id)
  where assigned_order_id is not null;

-- fast pick of the next free coupon
create index film_coupons_available_idx
  on public.film_coupons (created_at)
  where status = 'available' and active = true;

create index film_coupons_reserved_until_idx
  on public.film_coupons (reserved_until)
  where status = 'reserved';

-- ── orders ─────────────────────────────────────────────────
create table public.orders (
  id                       uuid primary key default gen_random_uuid(),
  order_reference          text not null unique,

  stripe_session_id        text unique,
  stripe_payment_intent_id text,

  customer_name            text,
  customer_email           text,
  phone                    text,
  shipping_address         jsonb,

  product_type             text not null
                             check (product_type in ('paperback_2','kit_paperback')),
  product_price            integer not null check (product_price >= 0),

  film_coupon_selected     boolean not null default false,
  film_coupon_id           uuid references public.film_coupons(id),
  film_coupon_amount       integer not null default 0 check (film_coupon_amount >= 0),

  shipping_cost            integer check (shipping_cost >= 0),
  shipping_service         text,
  shipping_rate_id         text,
  shipping_parcel          jsonb,

  total_amount             integer check (total_amount >= 0),
  currency                 text not null default 'usd',

  payment_status           text not null default 'pending'
                             check (payment_status in ('pending','paid','failed','expired','refunded')),
  fulfillment_status       text not null default 'unfulfilled'
                             check (fulfillment_status in ('unfulfilled','fulfilled','cancelled')),

  tracking_number          text,
  tracking_url             text,

  -- SHA-256 of the token handed to the customer in the success URL.
  -- The raw token is never stored, so a DB leak cannot grant order access.
  access_token_hash        text,

  confirmation_email_sent_at timestamptz,
  shipping_email_sent_at     timestamptz,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index orders_stripe_session_idx on public.orders (stripe_session_id);
create index orders_access_token_idx   on public.orders (access_token_hash);
create index orders_email_idx          on public.orders (customer_email);
create index orders_created_idx        on public.orders (created_at desc);

-- ── order_events (audit trail) ─────────────────────────────
create table public.order_events (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references public.orders(id) on delete cascade,
  event_type        text not null,
  event_description text,
  event_data        jsonb,
  created_at        timestamptz not null default now()
);

create index order_events_order_idx on public.order_events (order_id, created_at desc);

-- ── updated_at maintenance ─────────────────────────────────
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();
