#!/usr/bin/env node
/**
 * inspect.mjs — the URL Inspection lens for site-index-watch, running on Render.
 *
 * WHY THIS EXISTS (2026-07-30): the umbrella workspace's `GSC-IndexWatch-Jimmi-agent`
 * Windows task ran `gsc-watch.mjs`, which did TWO things per property — a live
 * declared-vs-served redirect check (LENS 1, ported here as-is) and a Search Console
 * URL Inspection sample (LENS 2, ported here as-is) — then cross-checked
 * `_ops/projects.json` and compared this run's indexed set against a snapshot file to
 * catch regressions. Moving the QUERYING off the PC means moving LENS 1 + LENS 2 here.
 * The other two pieces — the projects.json cross-check and the snapshot/regression
 * comparison — do NOT move: a Render cron job has NO persistent disk, so there is no
 * `_ops/watchdog/gsc-snapshots/` to compare against and no local registry to read. This
 * script emits the raw material (`propertyHosts[]`, `urlResults[]`) instead, and the
 * umbrella's `_ops/scripts/gsc-pull.mjs` does that stateful half locally.
 *
 * STATELESS SAMPLING (no disk, so no rotating cursor): each property's URL list is
 * split into K buckets by `sha1(url) % K`, where K = ceil(totalUrls / 60). Which
 * bucket is "live" this run is a function of wall-clock time alone
 * (`floor(now / 3.5 days) % K`), not of anything remembered between runs. A URL keeps
 * the SAME bucket for as long as the sitemap doesn't change size, so growing the
 * sitemap never reshuffles which URLs other buckets already covered, and the whole
 * property is covered again roughly every K runs (~K * 3.5 days). Hard-capped at 300
 * inspections/property regardless of K, well inside the 2,000/day/property quota.
 *
 * TRANSPORT: this cron has no way to write a file anyone else can read, so the wire IS
 * the Render log stream. The report is JSON → base64 → chunked lines (a single log
 * line has practical length limits) printed as `GSC_WATCH_JSON <runId> <i>/<n> <chunk>`,
 * followed by one `GSC_WATCH_SHA <runId> <sha256-of-the-json>` line so a corrupted or
 * partial chunk set is DETECTABLE, never silently trusted. `runId` is this process's
 * start time, so a puller reading a noisy, multi-run log window can group lines
 * correctly and never reconstruct a report by mixing chunks from two different runs.
 *
 * These lines are emitted AFTER watch.mjs's own `SITE_INDEX_WATCH_JSON=` line — this
 * script runs as a second step in the same cron invocation (see render.yaml), not
 * inside watch.mjs itself, so that line is untouched and this is simply later in the
 * same log.
 *
 * Auth: identical JWT-via-service-account flow as gsc.mjs's `accessToken()` in this
 * repo, vendored here (not imported) so this script has no cross-file coupling beyond
 * standard library — and reads the SAME `GOOGLE_SA_JSON` env var gsc.mjs already reads
 * successfully in this cron.
 *
 * ACCESS NOTE: URL Inspection requires the service account to be an OWNER or FULL user
 * on the property; a property we can only partly read is reported as a capability gap,
 * never silently skipped.
 *
 * Exit code: non-zero ONLY when `ok:false` (the run itself failed — no credential, auth
 * failure, cannot list properties). Findings (RED/YELLOW) do not affect the exit code;
 * they are read from the JSON payload by the local puller, exactly like the umbrella's
 * former gsc-watch.mjs never used its own exit code to carry findings either.
 */
import { createHash, createSign } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUN_ID = new Date().toISOString();

const findings = [];
const note = (level, site, msg, extra) => findings.push({ level, site, msg, ...(extra ? { extra } : {}) });

const LIVE_CONCURRENCY = 8;
const INSPECT_CONCURRENCY = 4;
const SAMPLE_BASE = 60; // K = ceil(totalUrls / SAMPLE_BASE)
const SAMPLE_CAP = 300; // hard cap per property regardless of K
const BUCKET_MS = 3.5 * 86_400_000; // bucket rotates every 3.5 days
const CHUNK_SIZE = 3000; // base64 chars per emitted log line

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

// ── auth: vendored from gsc.mjs's accessToken() — same GOOGLE_SA_JSON env var, same
// JWT-via-service-account flow. Not imported: this script must stand alone. ──────────
const b64url = (s) =>
  Buffer.from(s).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

async function getAccessToken(key, scopes) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: key.client_email,
    scope: scopes.join(" "),
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const sig = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(key.private_key, "base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${sig}`,
    }),
  });
  if (!r.ok) throw new Error(`token ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).access_token;
}

// ── property discovery (ported from _ops/scripts/gsc-watch.mjs) ─────────────────────
// Returns the DISCARDED sc-domain: count alongside the usable properties. Throwing that
// number away is what let "0 crawlable properties" look identical to "0 properties at
// all" — see zeroPropertiesReason() below.
async function listProperties(token) {
  const r = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`sites list ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const entries = (await r.json()).siteEntry || [];
  const properties = entries
    .filter((s) => s.siteUrl.startsWith("http")) // skip sc-domain: properties (no URL prefix to crawl)
    .map((s) => ({ siteUrl: s.siteUrl, permission: s.permissionLevel }));
  const domainOnlyCount = entries.filter((s) => !s.siteUrl.startsWith("http")).length;
  return { properties, domainOnlyCount };
}

// ── sitemap discovery: robots.txt is the authority, never a guess ───────────────────
async function discoverSitemaps(origin) {
  const found = [];
  try {
    const r = await fetch(`${origin}/robots.txt`, { redirect: "follow" });
    if (r.ok) {
      const body = await r.text();
      for (const m of body.matchAll(/^\s*Sitemap:\s*(\S+)/gim)) found.push(m[1].trim());
    }
  } catch {
    /* fall through to the conventional path */
  }
  if (!found.length) found.push(`${origin}/sitemap.xml`);
  return found;
}

async function expandSitemap(url, depth = 0, seen = new Set()) {
  if (depth > 2 || seen.has(url)) return [];
  seen.add(url);
  let xml;
  try {
    const r = await fetch(url, { redirect: "follow", headers: { "User-Agent": "site-index-watch-inspect/1.0" } });
    if (!r.ok) return [];
    xml = await r.text();
  } catch {
    return [];
  }
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  if (/<sitemapindex/i.test(xml)) {
    const nested = [];
    for (const child of locs) nested.push(...(await expandSitemap(child, depth + 1, seen)));
    return nested;
  }
  return locs;
}

// ── LENS 1: what we DECLARE vs what the host SERVES (ported, unchanged logic) ───────
async function liveCheck(url, maxHops = 8) {
  const chain = [];
  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    let r;
    try {
      r = await fetch(current, { redirect: "manual", headers: { "User-Agent": "site-index-watch-inspect/1.0" } });
    } catch (e) {
      return { declared: url, status: 0, error: String(e.message || e), chain };
    }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) return { declared: url, status: r.status, error: "redirect with no Location", chain };
      const next = new URL(loc, current).toString();
      chain.push(next);
      if (chain.filter((c) => c === next).length > 1) {
        return { declared: url, status: r.status, loop: true, chain, served: null };
      }
      current = next;
      continue;
    }
    return { declared: url, status: r.status, served: current, hops: chain.length, chain };
  }
  return { declared: url, status: 310, loop: true, chain, served: null };
}

function classifyLive(results, site) {
  const loops = results.filter((r) => r.loop);
  const dead = results.filter((r) => !r.loop && (r.status === 0 || r.status >= 400));
  const redirecting = results.filter((r) => !r.loop && r.status === 200 && r.hops > 0);
  const ok = results.filter((r) => !r.loop && r.status === 200 && !r.hops);

  if (loops.length)
    note(
      "RED",
      site,
      `${loops.length} sitemap URL(s) are in an INFINITE REDIRECT LOOP — permanently unreachable to users and crawlers`,
      loops.slice(0, 5).map((r) => `${r.declared} ⇄ ${r.chain[1] || r.chain[0]}`),
    );
  if (dead.length)
    note(
      "RED",
      site,
      `${dead.length} sitemap URL(s) do not resolve (4xx/5xx/network)`,
      dead.slice(0, 5).map((r) => `${r.declared} → ${r.error || r.status}`),
    );
  if (redirecting.length)
    note(
      "RED",
      site,
      `${redirecting.length} sitemap URL(s) REDIRECT — Google indexes these as "Page with redirect, not indexed" and DISCARDS any hreflang pointing at them`,
      redirecting.slice(0, 5).map((r) => `${r.declared} → ${r.served}`),
    );

  return { total: results.length, ok: ok.length, redirecting: redirecting.length, dead: dead.length, loops: loops.length };
}

// ── LENS 2: what Google actually did (ported, classifies on verdict — languageCode
// pins the locale so a zh-HK response can never be misread as "not indexed") ────────
async function inspectUrl(token, url, property) {
  const r = await fetch("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inspectionUrl: url, siteUrl: property, languageCode: "en" }),
  });
  if (!r.ok) return { url, error: `HTTP ${r.status}` };
  const idx = (await r.json()).inspectionResult?.indexStatusResult || {};
  return {
    url,
    indexed: idx.verdict === "PASS",
    verdict: idx.verdict || "UNKNOWN",
    coverageState: idx.coverageState || "",
    lastCrawlTime: idx.lastCrawlTime || "",
  };
}

// ── ABSENCE MUST NOT READ AS HEALTH ─────────────────────────────────────────────────
// Ported from _ops/scripts/gsc-watch.mjs on 2026-07-31. The umbrella's local copy of
// this lens was hardened on 2026-07-30; this cloud copy — the one that actually runs
// now — still had all three defects. Vendored rather than imported, matching this
// file's standing rule that it depends on nothing but the standard library.
//
// DEFECT 1. `inspectUrl` returns `{url, error}` instead of throwing, and the caller
// did `inspected.filter(r => !r.error)` before counting. A property where all 60 calls
// returned HTTP 403 therefore produced inspected:0 / indexed:0 / notIndexed:0, raised
// no finding, still incremented sitesSucceeded, and emitted an empty `urlResults` —
// so the local puller had nothing to compare and also stayed silent. Total failure of
// the lens rendered as GREEN.
export const INSPECTION_ERROR_THRESHOLD = 0.5;

export function classifyInspectionBatch(inspected, threshold = INSPECTION_ERROR_THRESHOLD) {
  const errorRows = inspected.filter((r) => r.error);
  const notIndexedRows = inspected.filter((r) => !r.error && !r.indexed);
  const indexedRows = inspected.filter((r) => r.indexed);
  const errRatio = inspected.length ? errorRows.length / inspected.length : (errorRows.length ? 1 : 0);
  const unavailable = inspected.length > 0 && errRatio >= threshold;
  const successfullyInspected = inspected.length - errorRows.length;
  const notIndexedRatio = successfullyInspected ? notIndexedRows.length / successfullyInspected : 0;
  return {
    inspected: inspected.length,
    indexed: indexedRows.length,
    notIndexed: notIndexedRows.length,
    errors: errorRows.length,
    errRatio,
    unavailable,
    successfullyInspected,
    notIndexedRatio,
    sampleErrors: [...new Set(errorRows.map((r) => r.error))].slice(0, 3),
    notIndexedRows,
    indexedRows,
    errorRows,
  };
}

// DEFECT 2. Zero usable properties left the per-property loop body unexecuted: nothing
// threw, no finding was appended, jobErrors stayed empty → ok:true, findings:[] →
// worst GREEN. A service account that had lost its grants, or one that can only see
// sc-domain: properties (which this sitemap-origin watch cannot crawl), reported
// perfect health while inspecting nothing at all.
export function zeroPropertiesReason({ propertiesLength, domainOnlyCount }) {
  if (propertiesLength) return null;
  if (domainOnlyCount)
    return `0 crawlable (http-prefix) properties are visible to this service account, but ${domainOnlyCount} sc-domain: propert${domainOnlyCount === 1 ? "y" : "ies"} exist and are NOT covered by this sitemap-origin watch`;
  return "0 Search Console properties of any kind are visible to this service account";
}

// DEFECT 3. Findings rendered as `<url> — <verdict>`, e.g. "https://landlord.com.hk/en
// — NEUTRAL", which reads as "Google dropped a live page, act now". On 2026-07-27 the
// truth was the opposite: the verdict had been crawled DURING that day's URL-shape fix
// and simply had not been re-crawled since. `lastCrawlTime` is the one fact that
// separates "re-crawled since our fix and still dropped" (act) from "verdict predates
// our fix" (wait), and the API already returns it. Resolving that ambiguity by hand
// cost four probes — a finding must be triageable from its own text.
export function formatIndexRow(r) {
  const state = r.coverageState || r.verdict || "UNKNOWN";
  return `${r.url} — ${state} (last crawled ${r.lastCrawlTime || "never"})`;
}

// ── stateless sampling: no disk, so no cursor. A fixed hash bucket per URL means list
// growth never reshuffles another URL's bucket; full coverage returns every K runs. ──
function selectSample(urls) {
  const K = Math.max(1, Math.ceil(urls.length / SAMPLE_BASE));
  const slot = Math.floor(Date.now() / BUCKET_MS) % K;
  const selected = urls.filter((u) => {
    const h = createHash("sha1").update(u).digest("hex").slice(0, 8);
    return parseInt(h, 16) % K === slot;
  });
  return { selected: selected.slice(0, SAMPLE_CAP), K, slot };
}

// ── emission: JSON → base64 → chunked lines, plus a sha256 the puller verifies before
// trusting ANY chunk set. No persistent disk on this cron — the Render log API IS the
// transport. Wire format consumed by _ops/scripts/gsc-pull.mjs in the umbrella; change
// it there in the same commit as here. ────────────────────────────────────────────────
function emit(report) {
  const json = JSON.stringify(report);
  const b64 = Buffer.from(json, "utf8").toString("base64");
  const chunks = [];
  for (let i = 0; i < b64.length; i += CHUNK_SIZE) chunks.push(b64.slice(i, i + CHUNK_SIZE));
  if (!chunks.length) chunks.push("");
  const n = chunks.length;
  chunks.forEach((c, i) => console.log(`GSC_WATCH_JSON ${RUN_ID} ${i + 1}/${n} ${c}`));
  const sha = createHash("sha256").update(json, "utf8").digest("hex");
  console.log(`GSC_WATCH_SHA ${RUN_ID} ${sha}`);
}

function finish(partial) {
  const worst = findings.some((f) => f.level === "RED") ? "RED" : findings.some((f) => f.level === "YELLOW") ? "YELLOW" : "GREEN";
  const report = {
    generatedAt: new Date().toISOString(),
    worst,
    sites: partial.sites,
    findings,
    ok: partial.ok,
    errors: partial.errors,
    sitesRequested: partial.sitesRequested,
    sitesSucceeded: partial.sitesSucceeded,
    propertyHosts: partial.propertyHosts,
    urlResults: partial.urlResults,
    runId: RUN_ID,
  };
  emit(report);
  process.exitCode = report.ok ? 0 : 2;
}

// ── main ──────────────────────────────────────────────────────────────────────────
async function main() {
  const raw = process.env.GOOGLE_SA_JSON;
  const propertyHosts = [];
  const urlResults = [];
  const sites = [];

  if (!raw) {
    const msg = "GOOGLE_SA_JSON not set — the URL Inspection watch is NOT running";
    note("RED", "-", msg);
    return finish({ ok: false, errors: [{ site: "-", message: msg }], sitesRequested: 0, sitesSucceeded: 0, sites, propertyHosts, urlResults });
  }

  let token;
  try {
    token = await getAccessToken(JSON.parse(raw), ["https://www.googleapis.com/auth/webmasters"]);
  } catch (e) {
    const msg = `Google auth failed: ${e.message}`;
    note("RED", "-", msg);
    return finish({ ok: false, errors: [{ site: "-", message: msg }], sitesRequested: 0, sitesSucceeded: 0, sites, propertyHosts, urlResults });
  }

  let properties, domainOnlyCount;
  try {
    ({ properties, domainOnlyCount } = await listProperties(token));
  } catch (e) {
    const msg = `cannot list Search Console properties: ${e.message}`;
    note("RED", "-", msg);
    return finish({ ok: false, errors: [{ site: "-", message: msg }], sitesRequested: 0, sitesSucceeded: 0, sites, propertyHosts, urlResults });
  }

  for (const p of properties) {
    try {
      propertyHosts.push(new URL(p.siteUrl).host.replace(/^www\./, ""));
    } catch {
      /* unparseable siteUrl — skip, LENS work below will still surface it via the crash path */
    }
  }

  const jobErrors = [];
  let sitesSucceeded = 0;

  // DEFECT 2 fix — zero properties must never fall through as a silent GREEN.
  const zeroReason = zeroPropertiesReason({ propertiesLength: properties.length, domainOnlyCount });
  if (zeroReason) {
    note("RED", "-", `${zeroReason} — the index watch covered NOTHING this run`);
    jobErrors.push({ site: "-", message: zeroReason });
  }

  for (const prop of properties) {
    let inspectionUnavailable = false;
    const origin = prop.siteUrl.replace(/\/$/, "");
    const entry = { property: prop.siteUrl, permission: prop.permission };
    try {
      const sitemaps = await discoverSitemaps(origin);
      entry.sitemaps = sitemaps;
      const urls = [...new Set((await Promise.all(sitemaps.map((s) => expandSitemap(s)))).flat())];
      entry.sitemapUrls = urls.length;

      if (!urls.length) {
        note("RED", origin, `no sitemap URLs discoverable (tried: ${sitemaps.join(", ")}) — Google is being handed nothing`);
      } else {
        // LENS 1 — every URL, every run. Cheap and immediate.
        const live = await pool(urls, LIVE_CONCURRENCY, (u) => liveCheck(u));
        entry.live = classifyLive(live, origin);

        // LENS 2 — GSC ground truth, stateless hash-bucket sample within quota.
        if (prop.permission !== "siteOwner" && prop.permission !== "siteFullUser") {
          note(
            "YELLOW",
            origin,
            `service account has "${prop.permission}" on this property — URL Inspection needs owner/full. Index verdicts are NOT being read for this site.`,
          );
        } else {
          const { selected, K, slot } = selectSample(urls);
          entry.sampleNote = `stateless hash-bucket sample: ${selected.length} of ${urls.length} sitemap URLs this run (K=${K}, slot=${slot}); full coverage returns roughly every ${K} run(s) (~${(K * 3.5).toFixed(1)} days)`;
          const inspected = await pool(selected, INSPECT_CONCURRENCY, (u) => inspectUrl(token, u, prop.siteUrl));
          const cls = classifyInspectionBatch(inspected);
          entry.gsc = {
            inspected: cls.inspected,
            indexed: cls.indexed,
            notIndexed: cls.notIndexed,
            errors: cls.errors,
          };

          // DEFECT 1 fix — errored inspections are COUNTED and reported, never filtered
          // into oblivion. Above the threshold the lens is unavailable for this property
          // this run: "we could not tell", which is not a successful check.
          if (cls.errors) {
            const sampleErrors = cls.sampleErrors.join(", ");
            if (cls.unavailable) {
              inspectionUnavailable = true;
              note("RED", origin, `${cls.errors}/${cls.inspected} URL Inspection calls FAILED (${Math.round(cls.errRatio * 100)}%) — the GSC index-status lens is UNAVAILABLE for this property this run, not clean (${sampleErrors})`);
              jobErrors.push({ site: prop.siteUrl, message: `URL Inspection failing for ${cls.errors}/${cls.inspected} URLs: ${sampleErrors}` });
            } else {
              note("YELLOW", origin, `${cls.errors}/${cls.inspected} URL Inspection calls failed this run — those URLs' index status is UNKNOWN, not "indexed" (${sampleErrors})`);
            }
          }

          // Only successfully-inspected rows go on the wire: an errored row has no
          // verdict, and letting one through as `indexed:false` would make the local
          // puller's regression comparison read a 403 as "Google dropped this page".
          // DEFECT 3 fix — coverageState + lastCrawlTime travel with every row so the
          // puller's findings are triageable without a fresh investigation.
          for (const r of [...cls.indexedRows, ...cls.notIndexedRows])
            urlResults.push({
              url: r.url,
              indexed: r.indexed,
              verdict: r.verdict,
              coverageState: r.coverageState || "",
              lastCrawlTime: r.lastCrawlTime || "",
            });
        }
      }
      if (!inspectionUnavailable) sitesSucceeded++;
    } catch (error) {
      const message = String(error?.message || error);
      jobErrors.push({ site: prop.siteUrl, message });
      note("RED", origin, `property check crashed and did not complete: ${message}`);
      entry.error = message;
    }
    sites.push(entry);
  }

  finish({
    ok: jobErrors.length === 0,
    errors: jobErrors,
    sitesRequested: properties.length,
    sitesSucceeded,
    sites,
    propertyHosts,
    urlResults,
  });
}

// Run only when executed directly. The selftest imports the exported classifiers from
// this file, and an unguarded top-level `await main()` would fire a live Google run on
// every `npm test` — the classic "the test suite is the thing that hits production".
function isDirectRun() {
  try {
    return Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) await main();
