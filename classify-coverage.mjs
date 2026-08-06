/**
 * classify-coverage.mjs — turn one Google coverage verdict into an ACTIONABLE/BENIGN ruling.
 *
 * WHY THIS EXISTS (owner, 2026-08-06). He opened Search Console, saw "57 pages not
 * indexed" on smallclaims.com.hk, and asked whether anything was watching. Something
 * was — the Monday cron had run three days earlier and reported GREEN. Both were true.
 * The cron's universe is SITEMAP URLs; his is every URL Google has ever discovered. A
 * raw count of "not indexed" is not a defect count, and nothing in the workspace could
 * tell those apart, so he became the detector. That is the exact failure the 2026-07-27
 * ruling forbade, arriving a second time by a different door.
 *
 * So: a number is not a finding. 54 of his 57 were correct behaviour — historical
 * redirects, a font file, pages queued for first crawl. One was real and buried inside
 * the same number: a blog post published 2026-07-20, live and in the sitemap, that
 * Google crawled and declined to index in all three languages.
 *
 * DESIGN RULES, each paid for by a past incident:
 *
 *   1. PURE FUNCTION. No network, no clock, no disk. `now` is injected. The whole point
 *      is that the selftest can drive every branch from fixtures — the cron runs
 *      unattended and its classifier must be provable without touching Google.
 *
 *   2. AN UNRECOGNISED coverageState IS LOUD, NEVER BENIGN. `coverageState` is a free-text,
 *      LOCALISED string (Google types it as string, not enum) and Google adds new states
 *      without notice. A default-benign switch would silently swallow every future
 *      failure mode — "absence read as health" in its newest costume.
 *
 *   3. NO VERDICT WITHOUT THE EVIDENCE IT DEPENDS ON. Several rules downgrade a scary
 *      Google state to BENIGN *because the live check rebuts it*. If the live check did
 *      not run, the rebuttal does not exist and the row stays ACTIONABLE — an unverified
 *      claim is not a benign one. This is the guard against the tempting-but-wrong
 *      "Google says 404, therefore stale, therefore fine".
 *
 *   4. LIVE 200 IS NOT PROOF OF A GOOD PAGE. A soft 404 answers 200 with an error body,
 *      and hosts serve Googlebot differently from us. So a live 2xx rebutting a Google
 *      404 is reported as BENIGN *with the disagreement named*, never silently.
 */

/** Severity ladder. Only the ACTIONABLE_* rungs may ever wake a human. */
export const SEVERITY = {
  OK: "OK",                             // indexed and serving — nothing to say
  NOISE: "NOISE",                       // not a page at all (assets); never counted as a defect
  BENIGN: "BENIGN",                     // explained non-indexing: correct behaviour or stale Google data
  ACTIONABLE_YELLOW: "ACTIONABLE_YELLOW", // real, worth a human's attention, not urgent
  ACTIONABLE_RED: "ACTIONABLE_RED",     // we are contradicting ourselves; fix now
};

const RANK = { OK: 0, NOISE: 1, BENIGN: 2, ACTIONABLE_YELLOW: 3, ACTIONABLE_RED: 4 };

/** Worst severity in a list — used to roll per-URL rulings up into a site verdict. */
export function worstSeverity(severities) {
  let worst = SEVERITY.OK;
  for (const s of severities) if ((RANK[s] ?? 0) > RANK[worst]) worst = s;
  return worst;
}

/**
 * Assets are crawled and reported exactly like pages, and Google files them under
 * "Crawled - currently not indexed" forever. `/fonts/noto-serif-sc.woff2` sat in the
 * owner's 57 as though it were a broken article. A font is not a page; not indexing one
 * is correct. Extension list, not MIME — we are classifying a URL, not a response.
 */
const ASSET_EXT = /\.(woff2?|ttf|otf|eot|css|m?js|mjs|cjs|json|xml|txt|png|jpe?g|gif|webp|avif|svg|ico|bmp|pdf|zip|gz|mp4|webm|mp3|wav|map)$/i;

export function isAssetUrl(url) {
  try {
    return ASSET_EXT.test(new URL(url).pathname);
  } catch {
    return ASSET_EXT.test(String(url).split("?")[0]);
  }
}

/**
 * A page Google has DISCOVERED but never crawled is normal for a while and a problem
 * after a while. 60 days is the line: past that, "not crawled yet" has stopped being a
 * queue and started being a crawl-budget or internal-linking failure.
 */
export const DISCOVERED_GRACE_DAYS = 60;

const norm = (s) => String(s || "").trim().toLowerCase();

/**
 * Did the live lens actually resolve this URL to a working page? Four-state on purpose.
 *
 * ⚠ `UNREACHABLE` added 2026-08-06 (adversarial review). It used to collapse into the
 * same branch as a real 4xx, so `finalStatus: 0` — which `inspect.mjs:179` returns for a
 * DNS blip or a socket error on OUR side — produced ACTIONABLE_RED "does not exist (live
 * 0)". A transient network failure on the watcher's machine is not evidence that the
 * page is gone, and under the delivery rules RED wakes the owner. Failing to reach a URL
 * and proving it dead are different facts and must not share a verdict.
 */
function liveOutcome(live) {
  if (!live || typeof live.finalStatus !== "number") return "UNKNOWN"; // rule 3: no evidence
  if (live.finalStatus === 0) return "UNREACHABLE";                    // our side failed, not theirs
  if (live.finalStatus >= 200 && live.finalStatus < 300) return "OK";
  if (live.finalStatus >= 400) return "DEAD";
  return "UNREACHABLE"; // an unresolved 3xx: the lens follows hops, so this never landed
}

/**
 * @param {object} row
 * @param {string} row.url                 absolute URL inspected
 * @param {string} row.coverageState       free-text state from URL Inspection
 * @param {boolean} row.inSitemap          does OUR sitemap declare it (authority: our fetch, not Google's `sitemap[]`)
 * @param {string[]} [row.referringUrls]   pages Google saw linking to it
 * @param {string|null} [row.lastCrawlTime] ISO
 * @param {{finalStatus:number, hops?:number}|null} [row.live] live-lens result, or null if not checked
 * @param {string|null} [row.firstSeenAt]  ISO, when WE first recorded this URL (for the discovered grace)
 * @param {number} [row.now]               ms since epoch; injected so the selftest owns the clock
 * @returns {{severity:string, code:string, reason:string}}
 */
export function classifyCoverage(row) {
  const {
    url = "",
    coverageState = "",
    inSitemap = false,
    referringUrls = [],
    lastCrawlTime = null,
    live = null,
    firstSeenAt = null,
    now = Date.now(),
  } = row || {};

  const state = norm(coverageState);
  const outcome = liveOutcome(live);
  const crawlAge = lastCrawlTime ? Math.floor((now - Date.parse(lastCrawlTime)) / 86_400_000) : null;
  const ageNote = crawlAge === null ? "never crawled" : `Google's data is ${crawlAge}d old`;

  const out = (severity, code, reason) => ({ severity, code, reason });

  // ── Rule 2 applied first: an empty state is not "fine", it is unknown. ──────────────
  if (!state) {
    return out(SEVERITY.ACTIONABLE_YELLOW, "NO_COVERAGE_STATE",
      "URL Inspection returned no coverageState — the inspection did not actually answer, so this URL is UNVERIFIED, not healthy");
  }

  // ── HARD ERRORS OUTRANK THE ASSET RULE (fixed 2026-08-06, adversarial review).
  // `ASSET_EXT` includes `xml` and `txt`, so `/sitemap.xml` returning "Server error (5xx)"
  // used to classify as NOISE — the single most load-bearing file on the site, filed as
  // "not a page, ignore". Whether a URL is an asset decides whether NOT BEING INDEXED
  // matters; it never decides whether a 5xx, a 403 or a redirect loop matters. A robots.txt
  // or sitemap.xml that Googlebot cannot fetch is a site-wide outage, not a rounding error.
  if (state.includes("server error") || state.includes("5xx")) {
    return out(SEVERITY.ACTIONABLE_RED, "SERVER_ERROR", "Googlebot hit a server error on this URL");
  }
  if (state.includes("unauthorized") || state.includes("401") || state.includes("403") || state.includes("forbidden")) {
    return out(SEVERITY.ACTIONABLE_RED, "AUTH_BLOCKED",
      "Googlebot is being refused access — the page is unreachable to search entirely");
  }
  if (state.includes("redirect error")) {
    return out(SEVERITY.ACTIONABLE_RED, "REDIRECT_ERROR",
      "Google could not resolve the redirect chain — usually a loop; the page is unreachable");
  }

  // ── "Indexed, though blocked by robots.txt" is a REAL Google state and must be caught
  // before the robots.txt branch below, which would otherwise rule it BENIGN "deliberate".
  // It is neither deliberate nor harmless: Google is serving a page it was never allowed
  // to read, so the listing has no title or description we control.
  if (state.includes("indexed") && state.includes("robots.txt")) {
    return out(SEVERITY.ACTIONABLE_YELLOW, "INDEXED_THOUGH_BLOCKED",
      "Google indexed this URL WITHOUT being allowed to crawl it — the search listing is built from third-party signals, not from the page. Allow crawling and use noindex instead, or the listing stays out of our control");
  }

  // ── Assets: not pages. Checked before every PAGE-QUALITY rule so no page rule fires on one.
  if (isAssetUrl(url)) {
    // ⚠ ORDER: "Crawled - currently NOT INDEXED" contains the substring "indexed". Testing
    // for "indexed" first mislabels every not-indexed asset as indexed. Caught by the
    // selftest, not by review — substring matching on localised free text is a trap, and
    // this is the first of three the tests found in this file.
    if (state.includes("not indexed")) {
      return out(SEVERITY.NOISE, "ASSET", `asset file, not a page — Google not indexing it is correct (${coverageState})`);
    }
    if (state.includes("indexed")) {
      return out(SEVERITY.NOISE, "ASSET_INDEXED", "asset file that Google chose to index — harmless");
    }
    return out(SEVERITY.NOISE, "ASSET", `asset file, not a page — Google not indexing it is correct (${coverageState})`);
  }

  // ── SPECIFIC-BEFORE-GENERIC. Three real states are substrings of broader ones:
  //   "Soft 404"       contains "404"       → would be eaten by the not-found branch
  //   "Redirect error" contains "redirect"  → would be eaten by the redirect branch
  // Both were misclassified as BENIGN until the selftest caught them. Keep these first.
  if (state.includes("soft 404")) {
    return out(SEVERITY.ACTIONABLE_YELLOW, "SOFT_404",
      "Google judged this a soft 404 — it answers 200 with what looks like an error or empty page");
  }
  if (state.includes("redirect error")) {
    return out(SEVERITY.ACTIONABLE_RED, "REDIRECT_ERROR",
      "Google could not resolve the redirect chain — usually a loop; the page is unreachable");
  }

  // ── "Not found (404)" ──────────────────────────────────────────────────────────────
  if (state.includes("not found") || state.includes("404")) {
    if (outcome === "UNKNOWN") {
      return out(SEVERITY.ACTIONABLE_YELLOW, "404_UNVERIFIED",
        `Google reports 404 (${ageNote}) and the live check did NOT run — unverified, so not dismissed`);
    }
    if (outcome === "UNREACHABLE") {
      return out(SEVERITY.ACTIONABLE_YELLOW, "404_UNREACHABLE",
        `Google reports 404 (${ageNote}) and OUR live check could not reach the URL either (network error or unresolved redirect) — we cannot tell whether the page is gone or our probe failed`);
    }
    if (outcome === "OK") {
      // Rule 4: name the disagreement rather than burying it.
      const base = `Google reports 404 but the URL resolves 200 now (${ageNote}) — Google's record is stale`;
      return inSitemap
        ? out(SEVERITY.BENIGN, "404_STALE_IN_SITEMAP", `${base}; it IS declared in the sitemap, so a recrawl should clear it`)
        : out(SEVERITY.BENIGN, "404_STALE", `${base}; not declared in the sitemap, so it will clear on its own`);
    }
    // Genuinely dead.
    if (inSitemap) {
      return out(SEVERITY.ACTIONABLE_RED, "404_IN_SITEMAP",
        `our sitemap DECLARES this URL and it does not exist (live ${live.finalStatus}) — we are handing Google a promise we do not keep`);
    }
    if (referringUrls.length) {
      return out(SEVERITY.ACTIONABLE_YELLOW, "404_LINKED",
        `dead URL (live ${live.finalStatus}) still linked from ${referringUrls.length} page(s): ${referringUrls.slice(0, 3).join(", ")} — fix the link or add a redirect`);
    }
    return out(SEVERITY.BENIGN, "404_HISTORICAL",
      `dead URL, not in the sitemap, nothing links to it — historical, will age out (${ageNote})`);
  }

  // ── "Page with redirect" — the 2026-07-27 incident lives here. ─────────────────────
  if (state.includes("redirect")) {
    if (inSitemap) {
      return out(SEVERITY.ACTIONABLE_RED, "REDIRECT_IN_SITEMAP",
        "our sitemap declares a URL that REDIRECTS — Google indexes the target instead and DISCARDS every hreflang pointing here (this is the 2026-07-27 regression)");
    }
    return out(SEVERITY.BENIGN, "REDIRECT_HISTORICAL",
      "old URL redirecting to its replacement and not declared in the sitemap — correct behaviour, counted as 'not indexed' by design");
  }

  // ── "Discovered - currently not indexed" — a queue until it isn't. ─────────────────
  if (state.includes("discovered")) {
    const knownDays = firstSeenAt ? Math.floor((now - Date.parse(firstSeenAt)) / 86_400_000) : null;
    if (knownDays !== null && knownDays >= DISCOVERED_GRACE_DAYS) {
      return out(SEVERITY.ACTIONABLE_YELLOW, "DISCOVERED_STALLED",
        `known to us for ${knownDays}d and Google still has not crawled it — past the ${DISCOVERED_GRACE_DAYS}d grace this is a crawl-budget or internal-linking failure, not a queue`);
    }
    if (outcome === "DEAD") {
      return out(SEVERITY.ACTIONABLE_RED, "DISCOVERED_DEAD",
        `Google queued this URL for crawling and it answers ${live.finalStatus} — it will be crawled into an error`);
    }
    return out(SEVERITY.BENIGN, "DISCOVERED_WAITING",
      `found by Google, not yet crawled${knownDays !== null ? ` (${knownDays}d)` : ""} — waiting is the correct state; nothing to fix`);
  }

  // ── "Crawled - currently not indexed" — Google read it and said no. ────────────────
  // This is the one that hid a real defect inside the owner's 57. It is never benign for
  // a real page: Google spent the crawl and declined, which is a judgement about the page.
  if (state.includes("crawled")) {
    return out(SEVERITY.ACTIONABLE_YELLOW, "CRAWLED_NOT_INDEXED",
      `Google crawled this page (${ageNote}) and chose NOT to index it — a quality, duplication or thin-content judgement; the page is invisible in search`);
  }

  // ── Canonical family ──────────────────────────────────────────────────────────────
  if (state.includes("alternate page") && state.includes("canonical")) {
    return out(SEVERITY.BENIGN, "ALTERNATE_CANONICAL",
      "duplicate that correctly points at its canonical — working as designed");
  }
  if (state.includes("duplicate")) {
    if (state.includes("google chose different canonical") || state.includes("different canonical")) {
      return out(SEVERITY.ACTIONABLE_YELLOW, "CANONICAL_OVERRIDDEN",
        "Google ignored our declared canonical and picked its own — our canonical signals disagree with the page's content");
    }
    return out(SEVERITY.ACTIONABLE_YELLOW, "DUPLICATE_NO_CANONICAL",
      "duplicate content with no user-selected canonical — declare one");
  }

  // ── Self-contradictions: we declared it AND blocked it. Always RED. ────────────────
  if (state.includes("noindex")) {
    return inSitemap
      ? out(SEVERITY.ACTIONABLE_RED, "NOINDEX_IN_SITEMAP",
          "our sitemap declares this URL while the page carries noindex — we are telling Google two opposite things")
      : out(SEVERITY.BENIGN, "NOINDEX_INTENTIONAL", "noindex and not declared in the sitemap — deliberate exclusion");
  }
  if (state.includes("robots.txt")) {
    return inSitemap
      ? out(SEVERITY.ACTIONABLE_RED, "ROBOTS_BLOCKED_IN_SITEMAP",
          "our sitemap declares this URL while robots.txt forbids crawling it — we are telling Google two opposite things")
      : out(SEVERITY.BENIGN, "ROBOTS_BLOCKED_INTENTIONAL", "blocked by robots.txt and not declared in the sitemap — deliberate");
  }
  // (server-error / auth / redirect-error are handled ABOVE the asset rule — see the
  // "HARD ERRORS OUTRANK THE ASSET RULE" block. Do not re-add them here.)
  if (state.includes("blocked due to") || state.includes("crawl anomaly")) {
    return out(SEVERITY.ACTIONABLE_YELLOW, "CRAWL_BLOCKED",
      `Google reports a crawl obstruction: "${coverageState}"`);
  }

  // ── Indexed states ────────────────────────────────────────────────────────────────
  if (state.includes("submitted and indexed")) {
    return out(SEVERITY.OK, "INDEXED", "indexed and submitted — healthy");
  }
  if (state.includes("indexed, not submitted") || (state.includes("indexed") && state.includes("not submitted"))) {
    return out(SEVERITY.ACTIONABLE_YELLOW, "INDEXED_NOT_SUBMITTED",
      "Google indexed a URL our sitemap never declared — the sitemap is incomplete, or this URL should not be public");
  }
  if (state.includes("indexed")) {
    return out(SEVERITY.OK, "INDEXED", `indexed (${coverageState})`);
  }

  // ── Rule 2, the backstop. Anything Google invents later lands here, loudly. ────────
  return out(SEVERITY.ACTIONABLE_YELLOW, "UNKNOWN_STATE",
    `unrecognised coverageState "${coverageState}" — reported rather than assumed harmless, because Google adds states without notice and a default-benign branch would swallow every future failure`);
}

/**
 * Roll per-URL rulings into the reconciliation line the owner actually needs: the one
 * that makes our verdict and the Search Console screen the SAME conversation.
 */
export function summarise(rulings) {
  const counts = { OK: 0, NOISE: 0, BENIGN: 0, ACTIONABLE_YELLOW: 0, ACTIONABLE_RED: 0 };
  for (const r of rulings) counts[r.severity] = (counts[r.severity] || 0) + 1;
  const notIndexed = counts.NOISE + counts.BENIGN + counts.ACTIONABLE_YELLOW + counts.ACTIONABLE_RED;
  return {
    counts,
    worst: worstSeverity(rulings.map((r) => r.severity)),
    actionable: counts.ACTIONABLE_RED + counts.ACTIONABLE_YELLOW,
    notIndexed,
    line: `${counts.OK} indexed · ${notIndexed} not indexed (of which ${counts.ACTIONABLE_RED} urgent, ${counts.ACTIONABLE_YELLOW} worth attention, ${counts.BENIGN} explained-benign, ${counts.NOISE} not-a-page)`,
  };
}
