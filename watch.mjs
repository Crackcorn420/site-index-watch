#!/usr/bin/env node
/**
 * watch.mjs — always-on URL health watch. Runs anywhere, needs NO credentials.
 *
 * WHY THIS EXISTS: on 2026-07-27 the owner opened Google Search Console, saw "57
 * pages not indexed", and asked about it. The cause had been live for weeks.
 * A watch was built the same day — but as a Windows Scheduled Task, so it only ran
 * when that one PC happened to be on AND logged in. A monitor whose uptime depends
 * on a laptop lid is a monitor you cannot trust to catch the next one.
 *
 * THE SPLIT THAT MAKES THIS POSSIBLE: the original watch had two lenses. The Google
 * lens needs the service-account key (vault-bound, therefore PC-bound). The LIVE
 * lens needs nothing but internet — and the live lens is the one that found
 * everything: 89 of 90 broken URLs on landlord.com.hk and all three infinite
 * redirect loops. So the valuable half runs free, in the cloud, with no secrets.
 *
 * WHAT IT ASSERTS — the declared-URL law: every URL a site DECLARES in its sitemap
 * must be byte-identical to the URL the host actually SERVES. A declared URL that
 * redirects is filed by Google as "Page with redirect — not indexed", and any
 * hreflang alternate pointing at it is DISCARDED.
 *
 * HOW IT REPORTS, with no extra secrets: it exits NON-ZERO when a site is broken.
 * Render emails the account on a failed cron run, so the alarm needs no token, no
 * webhook and no inbox integration. Findings are printed to the run log.
 *
 * Config: WATCH_SITES = comma-separated origins. Nothing else.
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
 * permanently-dead pages sat unnoticed on landlord.com.hk. We need the chain so the
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
    continue;
  }

  const res = await pool(urls, 8, check);
  const loops = res.filter((r) => r.kind === "loop");
  const dead = res.filter((r) => r.kind === "dead");
  const reds = res.filter((r) => r.kind === "redirect");
  const ok = res.filter((r) => r.kind === "ok");

  console.log(`${origin}: ${ok.length}/${urls.length} clean · ${reds.length} redirecting · ${dead.length} dead · ${loops.length} LOOPS`);

  const show = (label, rows, note) => {
    if (!rows.length) return;
    worst = 1;
    console.error(`  ✗ ${label} (${rows.length}) — ${note}`);
    for (const r of rows.slice(0, 8)) console.error(`      ${r.detail || r.url}`);
    if (rows.length > 8) console.error(`      … and ${rows.length - 8} more`);
  };
  show("INFINITE REDIRECT LOOP", loops, "permanently unreachable to users AND crawlers");
  show("DEAD", dead, "4xx/5xx/network — the sitemap promises a page that does not exist");
  show("REDIRECTING", reds, 'Google files these as "Page with redirect, not indexed" and DISCARDS hreflang pointing at them');
}

console.log(`\nverdict: ${worst ? "BROKEN — see above" : "all clean"}`);
process.exit(worst);
