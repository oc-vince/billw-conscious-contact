-- ============================================================
-- LEGACY EDITION — Supabase SQL Setup
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- 1. Create the sales tracking table
CREATE TABLE IF NOT EXISTS book_sales (
  id          INT PRIMARY KEY DEFAULT 1,
  sold_count  INT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Insert the single tracking row
INSERT INTO book_sales (id, sold_count)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

-- 3. Atomic increment function (thread-safe)
CREATE OR REPLACE FUNCTION increment_sold_count()
RETURNS INT AS $$
DECLARE
  new_count INT;
BEGIN
  UPDATE book_sales
  SET sold_count = sold_count + 1,
      updated_at = NOW()
  WHERE id = 1
  RETURNING sold_count INTO new_count;
  RETURN new_count;
END;
$$ LANGUAGE plpgsql;

-- 4. Disable Row Level Security for service-role access
--    (Edge Functions use the service role key, so this is fine)
ALTER TABLE book_sales DISABLE ROW LEVEL SECURITY;
