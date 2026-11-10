/**
 * Single source of truth for Christmas Bundle products, pricing and parcels.
 *
 * NOTHING monetary may be accepted from the browser. The frontend sends only
 * a bundle id and a film flag; every amount below is resolved here, server
 * side, and re-derived again at Checkout Session creation.
 *
 * All money is in INTEGER CENTS (USD) to match Stripe's unit_amount and the
 * integer columns in Supabase.
 */

export type BundleId = "paperback_2" | "kit_paperback";

export interface Parcel {
  length: string;
  width: string;
  height: string;
  distance_unit: "in";
  weight: string;
  mass_unit: "lb";
}

export interface Bundle {
  id: BundleId;
  name: string;
  /** Promotional price actually charged, in cents. */
  priceCents: number;
  /** Combined retail value, for display/receipts only. */
  retailCents: number;
  /** Single parcel — neither bundle ships in more than one box. */
  parcel: Parcel;
}

/** Optional digital add-on. Digital: never affects parcels or shipping. */
export const FILM_ADDON_CENTS = 500;
export const FILM_ADDON_NAME = "Film Access Coupon";

export const BUNDLES: Record<BundleId, Bundle> = {
  paperback_2: {
    id: "paperback_2",
    name: "Two Paperbacks",
    priceCents: 4900,
    retailCents: 5800,
    parcel: {
      length: "19",
      width: "12",
      height: "2",
      distance_unit: "in",
      weight: "2.5",
      mass_unit: "lb",
    },
  },
  kit_paperback: {
    id: "kit_paperback",
    name: "Kitchen Table + Paperback",
    priceCents: 9700,
    retailCents: 11600,
    parcel: {
      length: "14",
      width: "12",
      height: "2.5",
      distance_unit: "in",
      weight: "2.5",
      mass_unit: "lb",
    },
  },
};

/** Narrowing guard — rejects anything not an exact known bundle id. */
export function isBundleId(value: unknown): value is BundleId {
  return value === "paperback_2" || value === "kit_paperback";
}

export function getBundle(value: unknown): Bundle | null {
  return isBundleId(value) ? BUNDLES[value] : null;
}

/**
 * The four purchasable combinations, named distinctly for analytics.
 *
 * GA4 sees one of these on the confirmation URL, so each option reports
 * separately rather than the two film variants collapsing into their base
 * bundle. Hyphenated rather than spaced so the value survives a query
 * string intact — "+" would decode back to a space.
 *
 *   paperback_2   + film → two-paperbacks-plus-film
 *   paperback_2          → two-paperbacks
 *   kit_paperback + film → kitchen-table-paperback-plus-film
 *   kit_paperback        → kitchen-table-paperback
 */
const VARIANT_BASE: Record<BundleId, string> = {
  paperback_2: "two-paperbacks",
  kit_paperback: "kitchen-table-paperback",
};

export function variantName(bundle: Bundle, withFilm: boolean): string {
  return VARIANT_BASE[bundle.id] + (withFilm ? "-plus-film" : "");
}

/**
 * Server-side order maths. The only place a total is ever computed.
 */
export function priceOrder(bundle: Bundle, withFilm: boolean, shippingCents: number) {
  const productCents = bundle.priceCents;
  const filmCents = withFilm ? FILM_ADDON_CENTS : 0;
  return {
    productCents,
    filmCents,
    shippingCents,
    totalCents: productCents + filmCents + shippingCents,
  };
}

/** Ship-from address, from environment — never hardcoded, never sent to the browser. */
export function shipFromAddress() {
  const required = [
    "SHIP_FROM_NAME",
    "SHIP_FROM_STREET1",
    "SHIP_FROM_CITY",
    "SHIP_FROM_STATE",
    "SHIP_FROM_ZIP",
    "SHIP_FROM_COUNTRY",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing ship-from environment variables: ${missing.join(", ")}`);
  }
  return {
    name: process.env.SHIP_FROM_NAME!,
    street1: process.env.SHIP_FROM_STREET1!,
    street2: process.env.SHIP_FROM_STREET2 ?? "",
    city: process.env.SHIP_FROM_CITY!,
    state: process.env.SHIP_FROM_STATE!,
    zip: process.env.SHIP_FROM_ZIP!,
    country: process.env.SHIP_FROM_COUNTRY!,
  };
}
