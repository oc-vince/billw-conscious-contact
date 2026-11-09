-- ============================================================
-- 004 — Scheduled sweep of lapsed coupon reservations
--
-- reserve_film_coupon() also sweeps lazily on each call, so this is a
-- safety net for long idle periods rather than the primary mechanism.
--
-- If pg_cron is unavailable on your plan, this migration can be skipped
-- without breaking checkout — expired holds are still released on the
-- next reservation attempt.
-- ============================================================

create extension if not exists pg_cron with schema extensions;

select cron.schedule(
  'release-expired-coupon-reservations',
  '*/5 * * * *',
  $$select public.release_expired_reservations();$$
);

-- To confirm it registered:
--   select jobname, schedule from cron.job;
