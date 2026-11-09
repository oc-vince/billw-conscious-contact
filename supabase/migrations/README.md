# Christmas Bundle — database setup

Apply these to the Supabase project whose URL and secret key you put in
Netlify. **Run them in numerical order** — later files depend on earlier ones.

## How to run

1. Open the project in the Supabase Dashboard
2. **SQL Editor → New query**
3. Paste the contents of one file, click **Run**
4. Repeat for each file in order

| # | File | What it does |
|---|------|--------------|
| 001 | `001_christmas_bundle_schema.sql` | `film_coupons`, `orders`, `order_events` + indexes and constraints |
| 002 | `002_coupon_reservation_functions.sql` | reserve / assign / release / sweep / count |
| 003 | `003_security_lockdown.sql` | RLS + revokes **(do not skip)** |
| 004 | `004_schedule_reservation_cleanup.sql` | pg_cron sweep every 5 min (optional) |
| 005 | `005_import_film_coupons.sql` | the 100 film coupon codes |
| 006 | `006_webhook_idempotency.sql` | `processed_stripe_events` + claim/release **(do not skip)** |
| 007 | `007_order_payment_claim.sql` | `claim_order_payment` — one confirmation per order **(do not skip)** |

## After running, verify

```sql
-- expect: 100 / 100 / 100 / 0 / 0
select count(*)                                   as total,
       count(distinct code)                       as unique_codes,
       count(*) filter (where status='available')  as available,
       count(*) filter (where status='reserved')   as reserved,
       count(*) filter (where status='assigned')   as assigned
  from public.film_coupons;

-- expect: 3 tables, all with rowsecurity = true
select tablename, rowsecurity
  from pg_tables
 where schemaname = 'public'
   and tablename in ('film_coupons','orders','order_events');

-- expect: no rows — anon must not be able to execute these
select p.proname
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('reserve_film_coupon','assign_film_coupon',
                     'release_film_coupon','available_coupon_count')
   and has_function_privilege('anon', p.oid, 'execute');
```

## Notes

**003 is security-critical.** Postgres grants `EXECUTE` on new functions to
`PUBLIC` by default, and `anon`/`authenticated` inherit through it. Without
003, anyone holding the public anon key could call `reserve_film_coupon()`
via PostgREST and drain all 100 coupons, or call `release_film_coupon()` to
free a coupon already belonging to a paid order.

**The "RLS enabled, no policy" linter warning is expected.** Zero policies
means deny-all to browser roles; `service_role` bypasses RLS and is only
ever used server-side inside Netlify Functions.

**005 is safe to re-run.** `ON CONFLICT (code) DO NOTHING` means a second
execution imports nothing rather than duplicating.

**Money is stored as integer cents** throughout, matching Stripe's
`unit_amount` and avoiding floating-point rounding.
