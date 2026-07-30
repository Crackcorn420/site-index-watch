#!/usr/bin/env node
/**
 * watch.mjs — always-on URL health watch. No credentials, no local machine.
 *
 * ASSERTS THE DECLARED-URL LAW: every URL a site declares in its sitemap must be
 * byte-identical to the URL the host actually serves. A declared URL that redirects
 * is filed by Google as "Page with redirect — not indexed", and any hreflang
 * alternate pointing at it is DISCARDED — silently unlinking a whole locale cluster.
 *
 * Static hosts normalise silently and differently: some lowercase paths, some append
 * a trailing slash, some do both. When a redirect rule then fights that
 * normalisation, the two can bounce forever and the page becomes permanently
 * unreachable to users AND crawlers while every other check still reports green.
 * Those three failure kinds — LOOP, DEAD, REDIRECTING — are what this reports.
 *
 * Deliberately credential-free: it needs nothing but internet, so it can run
 * anywhere on a schedule instead of on one person's machine.
 *
 * Alerting with no secrets: exits NON-ZERO when a site is broken. A cron host that
 * emails on failed runs is then the entire alerting stack — no token, no webhook.
 *
 * Config: WATCH_SITES = comma-separated origins. That is all.
 */

const SITES = (process.env.WATCH_SITES || "")
  .split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);

if (!SITES.length) {
  console.error("FATAL: WATCH_SITES is empty. A watch with nothing to watch reports GREEN forever — refusing to run.");
  process.exitCode = 2;
  // No sockets open yet at this point, so exiting immediately is safe here.
  process.exit(2);
}

const UA = { "User-Agent": "site-index-watch/1.0 (+url-health)" };

/** Release a response we are not going to read. An undangled body keeps its socket
 *  alive; at exit that produced a libuv assertion and a 127 instead of our verdict. */
const drain = (r) => r?.body?.cancel?.().catch(() => {});

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/** robots.txt is the authority for where the sitemap lives — never guess. */
async function discoverSitemaps(origin) {
  const found = [];
  try {
    const r = await fetch(`${origin}/robots.txt`, { redirect: "follow", headers: UA });
    if (r.ok) { for (const m of (await r.text()).matchAll(/^\s*Sitemap:\s*(\S+)/gim)) found.push(m[1].trim()); }
    else await drain(r);
  } catch { /* fall through */ }
  if (!found.length) found.push(`${origin}/sitemap.xml`);
  return found;
}

async function expand(url, depth = 0, seen = new Set()) {
  if (depth > 2 || seen.has(url)) return [];
  seen.add(url);
  let xml;
  try {
    const r = await fetch(url, { redirect: "follow", headers: UA });
    if (!r.ok) { await drain(r); return []; }
    xml = await r.text();
  } catch { return []; }
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  if (/<sitemapindex/i.test(xml)) {
    const out = [];
    for (const child of locs) out.push(...(await expand(child, depth + 1, seen)));
    return out;
  }
  return locs;
}

/**
 * Follow redirects MANUALLY. `redirect: "follow"` throws an opaque error on a loop,
 * and `curl -L` hides one by following until it gives up — both of which is how three
 * permanently-dead pages can sit unnoticed for weeks. We need the chain so the
 * two URLs that bounce can be NAMED in the alert.
 */
async function check(url, maxHops = 8) {
  const chain = [];
  let cur = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    let r;
    try { r = await fetch(cur, { redirect: "manual", headers: UA }); }
    catch (e) { return { url, kind: "dead", detail: String(e.message || e) }; }
    await drain(r); // we only ever inspect status + Location, never the body
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) return { url, kind: "dead", detail: `${r.status} with no Location` };
      const next = new URL(loc, cur).toString();
      if (chain.includes(next)) return { url, kind: "loop", detail: `${url} ⇄ ${next}` };
      chain.push(next); cur = next; continue;
    }
    if (r.status === 200) {
      return chain.length ? { url, kind: "redirect", detail: `${url} → ${cur}` } : { url, kind: "ok" };
    }
    return { url, kind: "dead", detail: `HTTP ${r.status}` };
  }
  return { url, kind: "loop", detail: `${url} — exceeded ${maxHops} hops` };
}

let worst = 0;
// Structured mirror of everything printed below. Emitted as one JSON line at the
// end so a consumer never has to scrape the human prose — see the note by
// SITE_INDEX_WATCH_JSON at the bottom of this file.
const sites = [];
const googleLines = [];
const findings = [];
const stamp = new Date().toISOString();
console.log(`site-index-watch — ${stamp}`);
console.log(`watching ${SITES.length} site(s): ${SITES.join(", ")}\n`);

for (const origin of SITES) {
  const sitemaps = await discoverSitemaps(origin);
  const urls = [...new Set((await Promise.all(sitemaps.map((s) => expand(s)))).flat())];

  if (!urls.length) {
    // Zero URLs must never read as healthy — that is indistinguishable from a clean site.
    console.error(`✗ ${origin}: NO sitemap URLs discoverable (tried ${sitemaps.join(", ")}). Google is being handed nothing.`);
    worst = 1;
    sites.push({ origin, total: 0, ok: 0, redirecting: 0, dead: 0, loops: 0, error: "no sitemap URLs discoverable" });
    findings.push(`${origin}: NO sitemap URLs discoverable`);
    continue;
  }

  const res = await pool(urls, 8, check);
  const loops = res.filter((r) => r.kind === "loop");
  const dead = res.filter((r) => r.kind === "dead");
  const reds = res.filter((r) => r.kind === "redirect");
  const ok = res.filter((r) => r.kind === "ok");

  console.log(`${origin}: ${ok.length}/${urls.length} clean · ${reds.length} redirecting · ${dead.length} dead · ${loops.length} LOOPS`);
  sites.push({
    origin,
    total: urls.length,
    ok: ok.length,
    redirecting: reds.length,
    dead: dead.length,
    loops: loops.length,
  });

  const show = (label, rows, note) => {
    if (!rows.length) return;
    worst = 1;
    findings.push(`${origin}: ${label} (${rows.length})`);
    console.error(`  ✗ ${label} (${rows.length}) — ${note}`);
    for (const r of rows.slice(0, 8)) console.error(`      ${r.detail || r.url}`);
    if (rows.length > 8) console.error(`      … and ${rows.length - 8} more`);
  };
  show("INFINITE REDIRECT LOOP", loops, "permanently unreachable to users AND crawlers");
  show("DEAD", dead, "4xx/5xx/network — the sitemap promises a page that does not exist");
  show("REDIRECTING", reds, 'Google files these as "Page with redirect, not indexed" and DISCARDS hreflang pointing at them');
}

// ── Google lens (optional; skips cleanly when no credential is present) ──────
// Separate module so the credential-free watch above still runs on any host, even
// one with no secret store at all.
try {
  const { gscLens } = await import("./gsc.mjs");
  const g = await gscLens(SITES);
  console.log("");
  if (g.skipped) { console.log(`google lens: ${g.skipped}`); googleLines.push(`skipped: ${g.skipped}`); }
  else if (g.error) { console.error(`google lens: ${g.error}`); findings.push(`google lens: ${g.error}`); worst = 1; }
  else {
    for (const l of g.lines || []) { console.log(`google: ${l}`); googleLines.push(l); }
    for (const f of g.findings || []) { console.error(`  ✗ ${f}`); findings.push(f); worst = 1; }
  }
} catch (e) {
  // A crashed lens must never read as a clean bill of health.
  console.error(`google lens crashed: ${e.message}`);
  findings.push(`google lens crashed: ${e.message}`);
  worst = 1;
}

console.log(`\nverdict: ${worst ? "BROKEN — see above" : "all clean"}`);

// ── machine-readable mirror ─────────────────────────────────────────────────
// One line, one JSON object, stable prefix. This exists so the workspace's local
// state-watchdog can consume this cron's result THROUGH THE RENDER LOG API and
// the local GSC-IndexWatch scheduled task can be deleted — moving the querying
// off the owner's PC while the alert it feeds still reaches him.
//
// Deliberately NOT scraped from the prose above: parsing human output is how you
// build the next false alarm. The prose is for people; this line is the contract.
// If you change a field here, update _ops/scripts/state-watchdog.mjs in the same
// commit — it is the only consumer.
console.log(
  "SITE_INDEX_WATCH_JSON=" +
    JSON.stringify({
      v: 1,
      generatedAt: stamp,
      ok: worst === 0,
      sitesRequested: SITES.length,
      sitesSucceeded: sites.filter((s) => !s.error).length,
      sites,
      google: googleLines,
      findings,
    }),
);

// Deterministic exit is the entire alert signal, so it must not depend on teardown.
// (On Windows + Node 24 this can abort in the platform-specific libuv path with
// sockets still closing, replacing the verdict with 127. The program prints
// correctly first, and the host that matters here is Linux.)
process.exitCode = worst;
