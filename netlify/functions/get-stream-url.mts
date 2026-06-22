import type { Context, Config } from "@netlify/functions";
import { SignJWT, importJWK, type JWK } from "jose";

/**
 * GET /api/get-stream-url
 *
 * Verifies the caller is a signed-in Memberstack member with the Film Access plan,
 * then mints a short-lived signed Cloudflare Stream URL and returns it.
 *
 * The signed URL is the only thing that authorizes playback — the video itself is
 * marked requireSignedURLs=true on Cloudflare, so unsigned URLs return 401.
 *
 * Env vars (set in Netlify → Site configuration → Environment variables):
 *   MEMBERSTACK_SECRET_KEY              — Memberstack admin API key (sk_...)
 *   CLOUDFLARE_ACCOUNT_ID               — Cloudflare account ID (32-char hex)
 *   CLOUDFLARE_STREAM_SIGNING_KEY_ID    — Stream signing key ID (kid)
 *   CLOUDFLARE_STREAM_SIGNING_JWK       — Stream signing key JWK (base64-encoded)
 */

// Constants — not secrets, safe to hardcode
const FILM_VIDEO_UID = "0e0c8562873dadf73a989319fb612bfe";
const REQUIRED_PLAN_ID = "pln_unlimited-streaming-2bw0niy";
const TOKEN_TTL_SECONDS = 60 * 60 * 4; // 4 hours — long enough to watch the 58-min film with pauses
const CUSTOMER_SUBDOMAIN = "customer-" + "49d69bfe83fd011c99cdb2b81d000465" + ".cloudflarestream.com";

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export default async (req: Request, _context: Context) => {
  // Only POST is accepted
  if (req.method !== "POST") {
    return json(405, { message: "Method not allowed" });
  }

  // Read env vars
  const {
    MEMBERSTACK_SECRET_KEY,
    CLOUDFLARE_STREAM_SIGNING_KEY_ID,
    CLOUDFLARE_STREAM_SIGNING_JWK,
  } = process.env;

  if (!MEMBERSTACK_SECRET_KEY || !CLOUDFLARE_STREAM_SIGNING_KEY_ID || !CLOUDFLARE_STREAM_SIGNING_JWK) {
    console.error("get-stream-url: missing required environment variables");
    return json(500, { message: "Server configuration error" });
  }

  // 1) Extract the Memberstack token from the Authorization header
  const authHeader = req.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return json(401, { message: "Missing or malformed Authorization header" });
  }
  const memberToken = authHeader.slice("Bearer ".length).trim();
  if (!memberToken) {
    return json(401, { message: "Empty token" });
  }

  // 2) Verify the token with Memberstack's admin REST API and grab the member ID
  let memberId: string;
  try {
    const verifyRes = await fetch("https://admin.memberstack.com/members/verify-token", {
      method: "POST",
      headers: {
        "X-API-KEY": MEMBERSTACK_SECRET_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: memberToken }),
    });

    if (!verifyRes.ok) {
      console.warn("get-stream-url: token verification failed", verifyRes.status);
      return json(401, { message: "Invalid or expired session" });
    }

    const verifyBody = (await verifyRes.json()) as { data?: { id?: string } };
    if (!verifyBody.data?.id) {
      return json(401, { message: "Invalid token payload" });
    }
    memberId = verifyBody.data.id;
  } catch (err) {
    console.error("get-stream-url: error verifying token", err);
    return json(500, { message: "Could not verify session" });
  }

  // 3) Fetch the member's record and confirm they have the required plan
  try {
    const memberRes = await fetch(`https://admin.memberstack.com/members/${memberId}`, {
      method: "GET",
      headers: { "X-API-KEY": MEMBERSTACK_SECRET_KEY },
    });

    if (!memberRes.ok) {
      console.warn("get-stream-url: member lookup failed", memberRes.status);
      return json(403, { message: "Could not load member record" });
    }

    const memberBody = (await memberRes.json()) as {
      data?: { planConnections?: Array<{ planId?: string; status?: string; active?: boolean }> };
    };

    const planConnections = memberBody.data?.planConnections || [];
    const hasFilmAccess = planConnections.some(
      (pc) => pc.planId === REQUIRED_PLAN_ID && (pc.active === true || pc.status === "ACTIVE")
    );

    if (!hasFilmAccess) {
      return json(403, { message: "Active film access plan is required to watch" });
    }
  } catch (err) {
    console.error("get-stream-url: error checking plan", err);
    return json(500, { message: "Could not verify plan access" });
  }

  // 4) Mint a signed Cloudflare Stream token
  let signedToken: string;
  try {
    // The JWK env var is base64-encoded — decode and parse it
    const jwkJson = Buffer.from(CLOUDFLARE_STREAM_SIGNING_JWK, "base64").toString("utf-8");
    const jwk = JSON.parse(jwkJson) as JWK;

    const privateKey = await importJWK(jwk, "RS256");
    const now = Math.floor(Date.now() / 1000);

    signedToken = await new SignJWT({
      sub: FILM_VIDEO_UID,
      kid: CLOUDFLARE_STREAM_SIGNING_KEY_ID,
      exp: now + TOKEN_TTL_SECONDS,
      nbf: now - 30, // small backdate to tolerate clock drift
    })
      .setProtectedHeader({ alg: "RS256", kid: CLOUDFLARE_STREAM_SIGNING_KEY_ID })
      .sign(privateKey);
  } catch (err) {
    console.error("get-stream-url: error signing token", err);
    return json(500, { message: "Could not generate playback token" });
  }

  // 5) Return the signed iframe URL — the front-end uses this as the src
  const signedUrl = `https://${CUSTOMER_SUBDOMAIN}/${signedToken}/iframe`;

  return json(200, { signedUrl, expiresIn: TOKEN_TTL_SECONDS });
};

export const config: Config = {
  path: "/api/get-stream-url",
};
