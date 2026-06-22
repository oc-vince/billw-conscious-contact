// ============================================================
// LEGACY EDITION — Supabase Edge Function: check-availability
// Path: supabase/functions/check-availability/index.ts
// ============================================================
// Called by your purchase page on load.
// Returns: { available: boolean, remaining: number, sold: number }
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOOK_LIMIT = 190;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const { data, error } = await supabase
    .from("book_sales")
    .select("sold_count")
    .eq("id", 1)
    .single();

  if (error || !data) {
    console.error("DB error:", error?.message);
    // Fail open — show buy button if DB is unreachable
    return new Response(
      JSON.stringify({ available: true, remaining: BOOK_LIMIT, sold: 0 }),
      { headers: corsHeaders, status: 200 }
    );
  }

  const sold = data.sold_count as number;
  const remaining = Math.max(0, BOOK_LIMIT - sold);

  return new Response(
    JSON.stringify({ available: remaining > 0, remaining, sold }),
    { headers: corsHeaders, status: 200 }
  );
});
