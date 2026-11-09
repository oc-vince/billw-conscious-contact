/**
 * Minimal Shippo REST client.
 *
 * Deliberately no SDK: the three calls we need are small, and avoiding a
 * dependency keeps the function cold-start fast and the supply chain short.
 *
 * API version 2018-02-08. Test keys (shippo_test_) and live keys
 * (shippo_live_) hit the same endpoints; the key decides the mode.
 */

const SHIPPO_BASE = "https://api.goshippo.com";

export interface ShippoAddress {
  name?: string;
  company?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
  email?: string;
}

export interface UspsRate {
  rateId: string;
  service: string;
  serviceToken: string;
  amountCents: number;
  currency: string;
  estimatedDays: number | null;
  durationTerms: string | null;
}

function token(): string {
  const t = process.env.SHIPPO_API_TOKEN;
  if (!t) throw new Error("SHIPPO_API_TOKEN is not set");
  return t;
}

async function shippo(path: string, body?: unknown, method = "POST"): Promise<any> {
  const res = await fetch(`${SHIPPO_BASE}${path}`, {
    method,
    headers: {
      Authorization: `ShippoToken ${token()}`,
      "Content-Type": "application/json",
      "Shippo-API-Version": "2018-02-08",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Shippo returned non-JSON (${res.status})`);
  }

  if (!res.ok) {
    const detail = json?.detail || json?.message || `HTTP ${res.status}`;
    throw new Error(`Shippo ${method} ${path} failed: ${detail}`);
  }
  return json;
}

/**
 * Validate a destination address against USPS via Shippo.
 * Returns the normalised address plus any validation messages.
 */
export async function validateAddress(addr: ShippoAddress) {
  const created = await shippo("/addresses/", { ...addr, validate: true });
  const results = created?.validation_results ?? {};
  const messages: string[] = (results.messages ?? [])
    .map((m: any) => m?.text)
    .filter(Boolean);

  return {
    isValid: results.is_valid !== false, // undefined => Shippo did not dispute it
    messages,
    normalised: {
      name: created.name,
      street1: created.street1,
      street2: created.street2,
      city: created.city,
      state: created.state,
      zip: created.zip,
      country: created.country,
    },
    addressId: created.object_id as string,
  };
}

/**
 * Create a shipment and return USPS rates only.
 *
 * `async: false` makes Shippo compute rates inline rather than returning an
 * empty array to be polled.
 */
export async function getUspsRates(
  addressFrom: ShippoAddress,
  addressTo: ShippoAddress,
  parcel: Record<string, string>
): Promise<{ shipmentId: string; rates: UspsRate[] }> {
  const shipment = await shippo("/shipments/", {
    address_from: addressFrom,
    address_to: addressTo,
    parcels: [parcel],
    async: false,
  });

  if (shipment.status === "ERROR") {
    throw new Error("Shippo could not rate this shipment");
  }

  const all = Array.isArray(shipment.rates) ? shipment.rates : [];

  // USPS ONLY. The business rule is explicit: no UPS, FedEx, DHL or others
  // may ever reach the customer, even if the Shippo account enables them.
  const rates: UspsRate[] = all
    .filter((r: any) => String(r?.provider ?? "").toUpperCase() === "USPS")
    .map((r: any) => ({
      rateId: r.object_id,
      service: r?.servicelevel?.name ?? "USPS",
      serviceToken: r?.servicelevel?.token ?? "",
      amountCents: Math.round(parseFloat(r.amount) * 100),
      currency: String(r.currency ?? "USD").toUpperCase(),
      estimatedDays: typeof r.estimated_days === "number" ? r.estimated_days : null,
      durationTerms: r.duration_terms ?? null,
    }))
    .filter((r: UspsRate) => Number.isFinite(r.amountCents) && r.amountCents >= 0)
    .sort((a: UspsRate, b: UspsRate) => a.amountCents - b.amountCents);

  return { shipmentId: shipment.object_id, rates };
}

/**
 * Re-read a rate straight from Shippo immediately before payment.
 *
 * This is the guard against a tampered or stale shipping amount: whatever the
 * browser claims, the price charged comes from this call. Returns null if the
 * rate has expired or does not exist.
 */
export async function revalidateRate(rateId: string): Promise<UspsRate | null> {
  if (!/^[A-Za-z0-9]+$/.test(rateId)) return null;

  let r: any;
  try {
    r = await shippo(`/rates/${rateId}`, undefined, "GET");
  } catch {
    return null;
  }

  if (!r?.object_id) return null;
  if (String(r?.provider ?? "").toUpperCase() !== "USPS") return null;

  const amountCents = Math.round(parseFloat(r.amount) * 100);
  if (!Number.isFinite(amountCents) || amountCents < 0) return null;

  return {
    rateId: r.object_id,
    service: r?.servicelevel?.name ?? "USPS",
    serviceToken: r?.servicelevel?.token ?? "",
    amountCents,
    currency: String(r.currency ?? "USD").toUpperCase(),
    estimatedDays: typeof r.estimated_days === "number" ? r.estimated_days : null,
    durationTerms: r.duration_terms ?? null,
  };
}
