-- ============================================================
-- 003 — Row Level Security + privilege lockdown
--
-- Deliberately NO policies are created. RLS with zero policies denies
-- everything to anon and authenticated roles, while the service_role
-- used by Netlify Functions bypasses RLS entirely.
--
-- Net effect: the coupon inventory and all order data are unreachable
-- from the browser even though the anon/publishable key is public by
-- design. Every access goes through a Netlify Function.
--
-- The Supabase linter will report "RLS enabled, no policy" as INFO on
-- all three tables. That is intentional here, not a gap.
-- ============================================================

alter table public.film_coupons enable row level security;
alter table public.orders       enable row level security;
alter table public.order_events enable row level security;

-- Belt and braces: revoke the default grants from the public API roles
-- so a future accidental policy cannot silently expose these tables.
revoke all on public.film_coupons from anon, authenticated;
revoke all on public.orders       from anon, authenticated;
revoke all on public.order_events from anon, authenticated;

-- ── IMPORTANT ──────────────────────────────────────────────
-- Postgres grants EXECUTE on new functions to PUBLIC by default, and
-- anon/authenticated inherit through it. Revoking from those two roles
-- alone is NOT sufficient — without the lines below, anyone holding the
-- public anon key could call reserve_film_coupon() repeatedly via
-- PostgREST and drain the coupon pool, or call release_film_coupon()
-- to free a coupon belonging to a paid order.
revoke all on function public.reserve_film_coupon(uuid, interval) from public;
revoke all on function public.assign_film_coupon(uuid)            from public;
revoke all on function public.release_film_coupon(uuid)           from public;
revoke all on function public.release_expired_reservations()      from public;
revoke all on function public.available_coupon_count()            from public;
revoke all on function public.set_updated_at()                    from public;

grant execute on function public.reserve_film_coupon(uuid, interval) to service_role;
grant execute on function public.assign_film_coupon(uuid)            to service_role;
grant execute on function public.release_film_coupon(uuid)           to service_role;
grant execute on function public.release_expired_reservations()      to service_role;
grant execute on function public.available_coupon_count()            to service_role;

-- future functions in this schema should not be world-executable either
alter default privileges in schema public revoke execute on functions from public;
