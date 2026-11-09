/**
 * Thin Supabase REST helper.
 *
 * Uses the service-role key, which bypasses RLS. That key must never reach
 * the browser — every call here happens inside a Netlify Function.
 *
 * Raw fetch rather than @supabase/supabase-js: the handful of operations we
 * need are simple, and this keeps the function bundle small and auditable.
 */

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function base(): string {
  return env("SUPABASE_URL").replace(/\/+$/, "");
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function handle(res: Response, what: string) {
  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const detail = body?.message || body?.hint || `HTTP ${res.status}`;
    throw new Error(`Supabase ${what} failed: ${detail}`);
  }
  return body;
}

/** Call a Postgres function (SECURITY DEFINER, service-role only). */
export async function rpc<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${base()}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(args),
  });
  return handle(res, `rpc ${fn}`);
}

/** Insert a row and return it. */
export async function insert<T = any>(table: string, row: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${base()}/rest/v1/${table}`, {
    method: "POST",
    headers: headers({ Prefer: "return=representation" }),
    body: JSON.stringify(row),
  });
  const body = await handle(res, `insert ${table}`);
  return Array.isArray(body) ? body[0] : body;
}

/** Patch rows matching an eq filter. */
export async function update<T = any>(
  table: string,
  match: Record<string, string>,
  patch: Record<string, unknown>
): Promise<T> {
  const qs = Object.entries(match)
    .map(([k, v]) => `${encodeURIComponent(k)}=eq.${encodeURIComponent(v)}`)
    .join("&");
  const res = await fetch(`${base()}/rest/v1/${table}?${qs}`, {
    method: "PATCH",
    headers: headers({ Prefer: "return=representation" }),
    body: JSON.stringify(patch),
  });
  const body = await handle(res, `update ${table}`);
  return Array.isArray(body) ? body[0] : body;
}

/** Select rows matching an eq filter. */
export async function select<T = any>(
  table: string,
  match: Record<string, string>,
  columns = "*"
): Promise<T[]> {
  const qs = Object.entries(match)
    .map(([k, v]) => `${encodeURIComponent(k)}=eq.${encodeURIComponent(v)}`)
    .join("&");
  const res = await fetch(
    `${base()}/rest/v1/${table}?${qs}&select=${encodeURIComponent(columns)}`,
    { headers: headers() }
  );
  const body = await handle(res, `select ${table}`);
  return Array.isArray(body) ? body : [];
}

/** Append to the order audit trail. Never throws — logging must not break checkout. */
export async function logEvent(
  orderId: string,
  eventType: string,
  description?: string,
  data?: Record<string, unknown>
): Promise<void> {
  try {
    await insert("order_events", {
      order_id: orderId,
      event_type: eventType,
      event_description: description ?? null,
      event_data: data ?? null,
    });
  } catch (err: any) {
    console.error("order_events insert failed:", err?.message ?? err);
  }
}
