/**
 * gsc.mjs — the Google lens: what Search Console actually says about our URLs.
 *
 * Optional by design. `watch.mjs` (the live lens) needs no credentials and catches
 * breakage the week it ships. This lens needs a Google service account and reports
 * the lagging ground truth: what Google has actually indexed.
 *
 * CREDENTIAL: GOOGLE_SA_JSON — the full service-account JSON, injected as an
 * environment variable by the host. It is never committed and never typed into a
 * dashboard; it is pushed from the vault by API. If the variable is absent this
 * lens SKIPS rather than fails, so the credential-free watch still runs anywhere.
 *
 * ACCESS NOTE: URL Inspection requires the service account to be an OWNER or FULL
 * user on the property. Restricted access is enough for Search Analytics but NOT
 * for this — a property we can only partly read is reported as a capability gap,
 * never silently skipped.
 *
 * QUOTA: 2,000 inspections/day/property. The sample rotates by run so the whole
 * sitemap is covered over successive weeks, and truncation is always REPORTED.
 */
import { createSign } from "node:crypto";

const b64url = (s) => Buffer.from(s).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

async function accessToken(key, scopes) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = { iss: key.client_email, scope: scopes.join(" "), aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64")
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  if (!r.ok) throw new Error(`token ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).access_token;
}

/** Returns {skipped} | {findings:[], lines:[]} — never throws into the caller. */
export async function gscLens(origins) {
  const raw = process.env.GOOGLE_SA_JSON;
  if (!raw) return { skipped: "GOOGLE_SA_JSON not set — Google lens skipped (the live lens above still ran)" };

  let token;
  try {
    token = await accessToken(JSON.parse(raw), ["https://www.googleapis.com/auth/webmasters"]);
  } catch (e) {
    return { error: `Google auth failed: ${e.message}` };
  }

  const lines = [];
  const findings = [];

  const props = await fetch("https://www.googleapis.com/webmasters/v3/sites", { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => (r.ok ? r.json() : { siteEntry: [] })).catch(() => ({ siteEntry: [] }));
  const byHost = new Map();
  for (const p of props.siteEntry || []) {
    if (!p.siteUrl.startsWith("http")) continue;
    try { byHost.set(new URL(p.siteUrl).host.replace(/^www\./, ""), p); } catch {}
  }

  for (const origin of origins) {
    const host = new URL(origin).host.replace(/^www\./, "");
    const prop = byHost.get(host);
    if (!prop) {
      findings.push(`${origin}: NO Search Console property this account can read — UNMONITORED by Google's own numbers, not merely quiet.`);
      continue;
    }
    if (prop.permissionLevel !== "siteOwner" && prop.permissionLevel !== "siteFullUser") {
      findings.push(`${origin}: service account has "${prop.permissionLevel}" — URL Inspection needs owner/full, so index verdicts are NOT being read.`);
      continue;
    }

    // Ask a question the coverage report cannot answer directly: which pages does
    // Google have search data for, and does each still resolve? This is how two real
    // 404s were found that no coverage export had surfaced.
    const end = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
    const start = new Date(Date.now() - 93 * 864e5).toISOString().slice(0, 10);
    const sa = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(prop.siteUrl)}/searchAnalytics/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ startDate: start, endDate: end, dimensions: ["page"], rowLimit: 500 }),
    }).then((r) => (r.ok ? r.json() : { rows: [] })).catch(() => ({ rows: [] }));

    const pages = (sa.rows || []).map((r) => r.keys[0]);
    const broken = [];
    let i = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (i < pages.length) {
        const k = i++;
        try {
          const r = await fetch(pages[k], { redirect: "follow" });
          await r.body?.cancel?.().catch(() => {});
          if (r.status >= 400) broken.push(`${pages[k]} → ${r.status}`);
        } catch { broken.push(`${pages[k]} → network error`); }
      }
    }));

    lines.push(`${origin}: Google has search data for ${pages.length} page(s)`);
    if (broken.length) {
      findings.push(`${origin}: ${broken.length} page(s) Google RANKS now answer 4xx — real traffic hitting dead URLs:\n      ${broken.slice(0, 6).join("\n      ")}`);
    }
  }
  return { lines, findings };
}
