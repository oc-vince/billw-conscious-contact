import type { Config, Context } from "@netlify/functions";
import { getBundle, shipFromAddress } from "./_shared/bundles.mts";
import { validateAddress, getUspsRates, type ShippoAddress } from "./_shared/shippo.mts";

/**
 * POST /api/shipping-rates
 *
 * Body: { bundle: "paperback_2" | "kit_paperback", address: {...} }
 * Returns: { rates: [...], address: <normalised> }
 *
 * The parcel is chosen here from the bundle id — the browser cannot specify
 * dimensions or weight. Only USPS rates are ever returned. No price of any
 * kind is accepted from the request.
 */

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const str = (v: unknown, max = 100) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  // ── product ──────────────────────────────────────────────
  const bundle = getBundle(payload?.bundle);
  if (!bundle) {
    return json(400, { error: "Unknown bundle" });
  }

  // ── destination ──────────────────────────────────────────
  const a = payload?.address ?? {};
  const addressTo: ShippoAddress = {
    name: str(a.name),
    street1: str(a.street1),
    street2: str(a.street2),
    city: str(a.city),
    state: str(a.state, 32),
    zip: str(a.zip, 16),
    country: (str(a.country, 2) || "US").toUpperCase(),
    phone: str(a.phone, 32),
    email: str(a.email, 254),
  };

  const missing = (["street1", "city", "state", "zip"] as const).filter(
    (k) => !addressTo[k]
  );
  if (missing.length) {
    return json(400, { error: "Incomplete address", fields: missing });
  }

  if (addressTo.country !== "US") {
    // USPS-only, shipping from Arizona. International is out of scope for
    // this campaign and would need customs declarations.
    return json(400, {
      error: "We can only ship within the United States at this time.",
      fields: ["country"],
    });
  }

  try {
    // ── validate against USPS ──────────────────────────────
    const validation = await validateAddress(addressTo);
    if (!validation.isValid) {
      return json(422, {
        error: "We couldn't verify that address.",
        messages: validation.messages,
      });
    }

    // Use Shippo's normalised form for rating — it corrects casing, ZIP+4
    // and unit designators, which gives more accurate rates.
    const normalised: ShippoAddress = {
      ...addressTo,
      ...validation.normalised,
    };

    // ── rate ───────────────────────────────────────────────
    const { shipmentId, rates } = await getUspsRates(
      shipFromAddress(),
      normalised,
      bundle.parcel as unknown as Record<string, string>
    );

    if (!rates.length) {
      return json(422, {
        error: "No USPS services are available for that address.",
      });
    }

    return json(200, {
      shipmentId,
      bundle: bundle.id,
      parcel: bundle.parcel,
      address: validation.normalised,
      addressMessages: validation.messages,
      rates: rates.map((r) => ({
        rateId: r.rateId,
        service: r.service,
        amountCents: r.amountCents,
        amountDisplay: `$${(r.amountCents / 100).toFixed(2)}`,
        currency: r.currency,
        estimatedDays: r.estimatedDays,
        durationTerms: r.durationTerms,
      })),
    });
  } catch (err: any) {
    // Never leak Shippo internals or the token to the browser.
    console.error("shipping-rates failed:", err?.message ?? err);
    return json(502, {
      error: "Shipping rates are temporarily unavailable. Please try again.",
    });
  }
};

export const config: Config = {
  path: "/api/shipping-rates",
};
