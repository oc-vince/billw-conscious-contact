-- ============================================================
-- 002 — Coupon lifecycle: available -> reserved -> assigned
--
-- Concurrency model: FOR UPDATE SKIP LOCKED means two simultaneous
-- checkouts take different rows rather than blocking or colliding.
--
-- The reservation deliberately does NOT return the code or link —
-- those are only released by assign_film_coupon() after a verified
-- payment, so an abandoned checkout can never leak a code.
-- ============================================================

-- Release any reservation whose hold has lapsed. Returns how many.
create or replace function public.release_expired_reservations()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with released as (
    update public.film_coupons
       set status            = 'available',
           reserved_order_id = null,
           reserved_until    = null
     where status = 'reserved'
       and reserved_until < now()
    returning 1
  )
  select count(*) into v_count from released;

  return coalesce(v_count, 0);
end;
$$;

-- Reserve exactly one coupon for an order. Returns the coupon id, or
-- NULL when inventory is exhausted.
create or replace function public.reserve_film_coupon(
  p_order_id uuid,
  p_ttl      interval default '30 minutes'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- an order may hold at most one reservation; return the existing one
  -- so a retried checkout is idempotent rather than consuming two codes
  select id into v_id
    from public.film_coupons
   where reserved_order_id = p_order_id
     and status = 'reserved'
   limit 1;

  if v_id is not null then
    update public.film_coupons
       set reserved_until = now() + p_ttl
     where id = v_id;
    return v_id;
  end if;

  perform public.release_expired_reservations();

  select id into v_id
    from public.film_coupons
   where status = 'available'
     and active = true
   order by created_at
   for update skip locked
   limit 1;

  if v_id is null then
    return null;                       -- sold out
  end if;

  update public.film_coupons
     set status            = 'reserved',
         reserved_order_id = p_order_id,
         reserved_until    = now() + p_ttl
   where id = v_id;

  return v_id;
end;
$$;

-- Finalise after verified payment. Idempotent: calling twice for the
-- same order returns the same code and never consumes another.
create or replace function public.assign_film_coupon(p_order_id uuid)
returns table (coupon_id uuid, code text, redemption_link text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- already finalised? hand back the same one
  select c.id into v_id
    from public.film_coupons c
   where c.assigned_order_id = p_order_id
     and c.status = 'assigned'
   limit 1;

  if v_id is null then
    select c.id into v_id
      from public.film_coupons c
     where c.reserved_order_id = p_order_id
       and c.status = 'reserved'
     for update
     limit 1;

    if v_id is null then
      return;                          -- nothing held for this order
    end if;

    update public.film_coupons
       set status            = 'assigned',
           assigned_order_id = p_order_id,
           assigned_at       = now(),
           reserved_order_id = null,
           reserved_until    = null
     where id = v_id;
  end if;

  return query
    select c.id, c.code, c.redemption_link
      from public.film_coupons c
     where c.id = v_id;
end;
$$;

-- Hand a reservation back when a checkout expires or fails.
-- Never touches an already-assigned coupon.
create or replace function public.release_film_coupon(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.film_coupons
     set status            = 'available',
         reserved_order_id = null,
         reserved_until    = null
   where reserved_order_id = p_order_id
     and status = 'reserved';

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- Remaining inventory, for the sold-out check.
create or replace function public.available_coupon_count()
returns integer
language sql
security definer
set search_path = public
as $$
  select count(*)::integer
    from public.film_coupons
   where status = 'available' and active = true;
$$;
