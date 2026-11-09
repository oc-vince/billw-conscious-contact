/**
 * Order reference + access token helpers.
 *
 * The customer receives a long random token in the success URL. Only its
 * SHA-256 is stored, so a database leak cannot be used to read orders, and
 * the token cannot be guessed or enumerated from a sequential id.
 */

import { randomBytes, createHash } from "node:crypto";

/** Human-readable reference shown to the customer, e.g. BWCC-7K2P4M9Q. */
export function newOrderReference(): string {
  // Crockford-ish alphabet: no I, L, O, U — avoids misreading over the phone.
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return `BWCC-${out}`;
}

/** 32 random bytes, URL-safe. Shown once, never stored in plain text. */
export function newAccessToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time compare of a presented token against a stored hash. */
export function tokenMatchesHash(token: string, hash: string): boolean {
  if (!token || !hash) return false;
  const a = hashToken(token);
  if (a.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}
