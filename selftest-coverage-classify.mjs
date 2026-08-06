#!/usr/bin/env node
/**
 * selftest-coverage-classify.mjs — proof for classify-coverage.mjs.
 *
 * WHY (instruments.json contract): this classifier decides which Search Console findings
 * ever reach a human. If it is wrong toward BENIGN, the watch reports a clean bill while
 * the site is broken — the failure this workspace keeps paying for. So every rule is
 * tested in BOTH directions: the case that must be benign, and the neighbouring case that
 * must NOT be.
 *
 * Two adversarial classes are mandatory here and would have caught real incidents:
 *   - NO DEFAULT-BENIGN. An unrecognised coverageState, and an empty one, must be loud.
 *   - NO VERDICT WITHOUT EVIDENCE. When the live check did not run, a scary Google state
 *     may not be downgraded to benign on the assumption it would have passed.
 *
 * Run: node site-index-watch/selftest-coverage-classify.mjs
 */
import { classifyCoverage, summarise, worstSeverity, isAssetUrl, SEVERITY, DISCOVERED_GRACE_DAYS } from "./classify-coverage.mjs";

const NOW = Date.parse("2026-08-06T00:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();

let pass = 0;
const failures = [];

function check(label, actual, expected) {
  if (actual === expected) { pass++; return; }
  failures.push(`${label}\n      expected: ${expected}\n      actual:   ${actual}`);
}

/** Assert a row classifies to `expected` severity, and optionally to `code`. */
function sev(label, row, expected, code) {
  const r = classifyCoverage({ now: NOW, ...row });
  check(label, r.severity, expected);
  if (code) check(`${label} [code]`, r.code, code);
  return r;
}

const OK200 = { finalStatus: 200 };
const DEAD404 = { finalStatus: 404 };
const PAGE = "https://example.com/blog/some-post";

// ── 1 · Assets are never page defects ────────────────────────────────────────────────
sev("asset: font 'crawled not indexed' is NOISE, not a defect",
  { url: "https://example.com/fonts/noto-serif-sc.woff2", coverageState: "Crawled - currently not indexed", live: OK200 },
  SEVERITY.NOISE, "ASSET");
sev("asset: css",
  { url: "https://example.com/a/style.css", coverageState: "Crawled - currently not indexed" }, SEVERITY.NOISE);
sev("asset: query string does not hide the extension",
  { url: "https://example.com/fonts/x.woff2?v=cd87a1b3", coverageState: "Crawled - currently not indexed" }, SEVERITY.NOISE);
// The OTHER direction: a real page must NOT be swallowed by the asset rule.
sev("NOT an asset: a page whose slug merely contains 'css' stays a page",
  { url: "https://example.com/blog/css-tips", coverageState: "Crawled - currently not indexed", live: OK200 },
  SEVERITY.ACTIONABLE_YELLOW, "CRAWLED_NOT_INDEXED");
check("isAssetUrl: page is not an asset", isAssetUrl("https://example.com/blog/post"), false);
check("isAssetUrl: woff2 is an asset", isAssetUrl("https://example.com/f.woff2"), true);

// ── 2 · "Not found (404)" — the row most likely to hide a real defect ────────────────
sev("404 + live 200 + not in sitemap = BENIGN (Google's record is stale)",
  { url: PAGE, coverageState: "Not found (404)", inSitemap: false, live: OK200, lastCrawlTime: daysAgo(17) },
  SEVERITY.BENIGN, "404_STALE");
sev("404 + live 200 + IN sitemap = still BENIGN but flagged as declared",
  { url: PAGE, coverageState: "Not found (404)", inSitemap: true, live: OK200, lastCrawlTime: daysAgo(17) },
  SEVERITY.BENIGN, "404_STALE_IN_SITEMAP");
// THE CRITICAL NEGATIVE: no live check means no rebuttal, so no downgrade.
sev("404 + live check DID NOT RUN = ACTIONABLE, never assumed stale",
  { url: PAGE, coverageState: "Not found (404)", inSitemap: false, live: null, lastCrawlTime: daysAgo(17) },
  SEVERITY.ACTIONABLE_YELLOW, "404_UNVERIFIED");
sev("404 + genuinely dead + IN sitemap = RED (we promise a page that does not exist)",
  { url: PAGE, coverageState: "Not found (404)", inSitemap: true, live: DEAD404 },
  SEVERITY.ACTIONABLE_RED, "404_IN_SITEMAP");
sev("404 + dead + linked from live pages = YELLOW (we link to a dead URL)",
  { url: PAGE, coverageState: "Not found (404)", inSitemap: false, live: DEAD404, referringUrls: ["https://example.com/cases/x"] },
  SEVERITY.ACTIONABLE_YELLOW, "404_LINKED");
sev("404 + dead + unreferenced + not declared = BENIGN historical",
  { url: PAGE, coverageState: "Not found (404)", inSitemap: false, live: DEAD404, referringUrls: [] },
  SEVERITY.BENIGN, "404_HISTORICAL");

// ── 3 · "Page with redirect" — the 2026-07-27 regression must stay RED ───────────────
sev("REGRESSION GUARD: sitemap declares a URL that redirects = RED",
  { url: PAGE, coverageState: "Page with redirect", inSitemap: true, live: { finalStatus: 200, hops: 1 } },
  SEVERITY.ACTIONABLE_RED, "REDIRECT_IN_SITEMAP");
sev("redirect NOT in sitemap = BENIGN (correct historical redirect)",
  { url: PAGE, coverageState: "Page with redirect", inSitemap: false, live: { finalStatus: 200, hops: 1 } },
  SEVERITY.BENIGN, "REDIRECT_HISTORICAL");

// ── 4 · "Discovered - currently not indexed" — queue vs failure ──────────────────────
sev("discovered recently = BENIGN (waiting is correct)",
  { url: PAGE, coverageState: "Discovered - currently not indexed", inSitemap: true, firstSeenAt: daysAgo(10) },
  SEVERITY.BENIGN, "DISCOVERED_WAITING");
sev("discovered with no first-seen date = BENIGN (cannot claim it is stalled)",
  { url: PAGE, coverageState: "Discovered - currently not indexed", inSitemap: true, firstSeenAt: null },
  SEVERITY.BENIGN, "DISCOVERED_WAITING");
sev(`discovered ${DISCOVERED_GRACE_DAYS}+ days = YELLOW (a queue that never moves is a failure)`,
  { url: PAGE, coverageState: "Discovered - currently not indexed", inSitemap: true, firstSeenAt: daysAgo(DISCOVERED_GRACE_DAYS + 1) },
  SEVERITY.ACTIONABLE_YELLOW, "DISCOVERED_STALLED");
sev("boundary: exactly at the grace day is already stalled",
  { url: PAGE, coverageState: "Discovered - currently not indexed", firstSeenAt: daysAgo(DISCOVERED_GRACE_DAYS) },
  SEVERITY.ACTIONABLE_YELLOW, "DISCOVERED_STALLED");
sev("boundary: one day inside the grace is still waiting",
  { url: PAGE, coverageState: "Discovered - currently not indexed", firstSeenAt: daysAgo(DISCOVERED_GRACE_DAYS - 1) },
  SEVERITY.BENIGN, "DISCOVERED_WAITING");
sev("discovered but the URL is dead = RED (Google will crawl into an error)",
  { url: PAGE, coverageState: "Discovered - currently not indexed", inSitemap: true, live: DEAD404, firstSeenAt: daysAgo(5) },
  SEVERITY.ACTIONABLE_RED, "DISCOVERED_DEAD");

// ── 5 · "Crawled - currently not indexed" — the defect hidden in the owner's 57 ──────
sev("THE 2026-08-06 FINDING: real page crawled and declined = ACTIONABLE",
  { url: "https://smallclaims.com.hk/blog/travel-agency-refund-guide", coverageState: "Crawled - currently not indexed",
    inSitemap: true, live: OK200, lastCrawlTime: daysAgo(17) },
  SEVERITY.ACTIONABLE_YELLOW, "CRAWLED_NOT_INDEXED");
sev("crawled-not-indexed is ACTIONABLE even when NOT in the sitemap (still a real page)",
  { url: PAGE, coverageState: "Crawled - currently not indexed", inSitemap: false, live: OK200 },
  SEVERITY.ACTIONABLE_YELLOW, "CRAWLED_NOT_INDEXED");

// ── 6 · Canonical family ────────────────────────────────────────────────────────────
sev("alternate page with proper canonical = BENIGN by design",
  { url: PAGE, coverageState: "Alternate page with proper canonical tag", live: OK200 },
  SEVERITY.BENIGN, "ALTERNATE_CANONICAL");
sev("duplicate without user-selected canonical = YELLOW",
  { url: PAGE, coverageState: "Duplicate without user-selected canonical", live: OK200 },
  SEVERITY.ACTIONABLE_YELLOW, "DUPLICATE_NO_CANONICAL");
sev("Google chose a different canonical = YELLOW",
  { url: PAGE, coverageState: "Duplicate, Google chose different canonical than user", live: OK200 },
  SEVERITY.ACTIONABLE_YELLOW, "CANONICAL_OVERRIDDEN");

// ── 7 · Self-contradiction is always RED ────────────────────────────────────────────
sev("noindex + declared in sitemap = RED (two opposite instructions)",
  { url: PAGE, coverageState: "Excluded by 'noindex' tag", inSitemap: true, live: OK200 },
  SEVERITY.ACTIONABLE_RED, "NOINDEX_IN_SITEMAP");
sev("noindex + not declared = BENIGN (deliberate exclusion)",
  { url: PAGE, coverageState: "Excluded by 'noindex' tag", inSitemap: false, live: OK200 },
  SEVERITY.BENIGN, "NOINDEX_INTENTIONAL");
sev("robots.txt blocked + declared in sitemap = RED",
  { url: PAGE, coverageState: "Blocked by robots.txt", inSitemap: true },
  SEVERITY.ACTIONABLE_RED, "ROBOTS_BLOCKED_IN_SITEMAP");
sev("robots.txt blocked + not declared = BENIGN",
  { url: PAGE, coverageState: "Blocked by robots.txt", inSitemap: false },
  SEVERITY.BENIGN, "ROBOTS_BLOCKED_INTENTIONAL");

// ── 8 · Hard errors ─────────────────────────────────────────────────────────────────
sev("soft 404 = YELLOW", { url: PAGE, coverageState: "Soft 404", live: OK200 }, SEVERITY.ACTIONABLE_YELLOW, "SOFT_404");
sev("403 to Googlebot = RED", { url: PAGE, coverageState: "Blocked due to access forbidden (403)" }, SEVERITY.ACTIONABLE_RED, "AUTH_BLOCKED");
sev("401 = RED", { url: PAGE, coverageState: "Blocked due to unauthorized request (401)" }, SEVERITY.ACTIONABLE_RED, "AUTH_BLOCKED");
sev("server error = RED", { url: PAGE, coverageState: "Server error (5xx)" }, SEVERITY.ACTIONABLE_RED, "SERVER_ERROR");
sev("redirect error / loop = RED", { url: PAGE, coverageState: "Redirect error" }, SEVERITY.ACTIONABLE_RED, "REDIRECT_ERROR");

// ── 9 · Indexed states ──────────────────────────────────────────────────────────────
sev("submitted and indexed = OK", { url: PAGE, coverageState: "Submitted and indexed", inSitemap: true, live: OK200 }, SEVERITY.OK, "INDEXED");
sev("indexed but not in our sitemap = YELLOW (sitemap incomplete)",
  { url: PAGE, coverageState: "Indexed, not submitted in sitemap", inSitemap: false, live: OK200 },
  SEVERITY.ACTIONABLE_YELLOW, "INDEXED_NOT_SUBMITTED");

// ── 10 · ABSENCE MUST NOT READ AS HEALTH — the whole point ───────────────────────────
sev("unrecognised coverageState is LOUD, never benign",
  { url: PAGE, coverageState: "Some Future State Google Invents In 2027", live: OK200 },
  SEVERITY.ACTIONABLE_YELLOW, "UNKNOWN_STATE");
sev("empty coverageState is LOUD (the inspection did not answer)",
  { url: PAGE, coverageState: "", live: OK200 },
  SEVERITY.ACTIONABLE_YELLOW, "NO_COVERAGE_STATE");
sev("missing coverageState field entirely is LOUD",
  { url: PAGE, live: OK200 },
  SEVERITY.ACTIONABLE_YELLOW, "NO_COVERAGE_STATE");
check("classifyCoverage(undefined) does not throw and is not benign",
  classifyCoverage(undefined).severity, SEVERITY.ACTIONABLE_YELLOW);

// A localisation guard: Google localises coverageState. Mixed case must not change a verdict.
sev("case-insensitive matching (Google localises and re-cases these strings)",
  { url: PAGE, coverageState: "CRAWLED - CURRENTLY NOT INDEXED", live: OK200 },
  SEVERITY.ACTIONABLE_YELLOW, "CRAWLED_NOT_INDEXED");

// ── 10b · DEFECTS FOUND BY ADVERSARIAL REVIEW, 2026-08-06 ───────────────────────────
// Each of these classified WRONG before the fix. They are the regression guards.

// (a) A network failure on OUR side is not proof the page is dead. inspect.mjs:179 returns
//     finalStatus 0 for a DNS/socket error; that used to reach the "genuinely dead" branch
//     and produce RED, which under the delivery rules wakes the owner for our own blip.
sev("network error on our side is UNVERIFIED, not a dead page",
  { url: PAGE, coverageState: "Not found (404)", inSitemap: true, live: { finalStatus: 0 } },
  SEVERITY.ACTIONABLE_YELLOW, "404_UNREACHABLE");
sev("an unresolved redirect (never landed) is also UNVERIFIED, not dead",
  { url: PAGE, coverageState: "Not found (404)", inSitemap: true, live: { finalStatus: 302 } },
  SEVERITY.ACTIONABLE_YELLOW, "404_UNREACHABLE");
// The other direction must still be RED — a genuine 4xx on a declared URL.
sev("a REAL 4xx on a sitemap URL is still RED (the fix must not soften this)",
  { url: PAGE, coverageState: "Not found (404)", inSitemap: true, live: { finalStatus: 410 } },
  SEVERITY.ACTIONABLE_RED, "404_IN_SITEMAP");

// (b) ASSET_EXT contains xml/txt, so the site's most load-bearing files were being filed
//     as "not a page, ignore" even when Googlebot could not fetch them at all.
sev("sitemap.xml with a SERVER ERROR is RED, not NOISE",
  { url: "https://example.com/sitemap.xml", coverageState: "Server error (5xx)" },
  SEVERITY.ACTIONABLE_RED, "SERVER_ERROR");
sev("robots.txt refused to Googlebot is RED, not NOISE",
  { url: "https://example.com/robots.txt", coverageState: "Blocked due to access forbidden (403)" },
  SEVERITY.ACTIONABLE_RED, "AUTH_BLOCKED");
sev("an asset in a redirect LOOP is RED, not NOISE",
  { url: "https://example.com/a/style.css", coverageState: "Redirect error" },
  SEVERITY.ACTIONABLE_RED, "REDIRECT_ERROR");
// The other direction: an asset merely not indexed is still NOISE.
sev("an asset that is simply not indexed remains NOISE",
  { url: "https://example.com/fonts/x.woff2", coverageState: "Crawled - currently not indexed", live: OK200 },
  SEVERITY.NOISE, "ASSET");

// (c) "Indexed, though blocked by robots.txt" is a real GSC state. The robots branch used
//     to catch it first and call it a deliberate exclusion — the opposite of the truth.
sev("'Indexed, though blocked by robots.txt' is ACTIONABLE, not deliberate",
  { url: PAGE, coverageState: "Indexed, though blocked by robots.txt", inSitemap: false },
  SEVERITY.ACTIONABLE_YELLOW, "INDEXED_THOUGH_BLOCKED");
sev("plain robots.txt exclusion, not indexed, not declared = still BENIGN",
  { url: PAGE, coverageState: "Blocked by robots.txt", inSitemap: false },
  SEVERITY.BENIGN, "ROBOTS_BLOCKED_INTENTIONAL");

// ── 11 · Roll-up: the reconciliation the owner actually reads ────────────────────────
{
  const rulings = [
    { severity: SEVERITY.OK }, { severity: SEVERITY.OK },
    { severity: SEVERITY.BENIGN }, { severity: SEVERITY.NOISE },
    { severity: SEVERITY.ACTIONABLE_YELLOW },
  ];
  const s = summarise(rulings);
  check("summarise: not-indexed count excludes OK", s.notIndexed, 3);
  check("summarise: actionable counts only actionable rungs", s.actionable, 1);
  check("summarise: worst severity", s.worst, SEVERITY.ACTIONABLE_YELLOW);
  check("worstSeverity: RED beats YELLOW", worstSeverity([SEVERITY.ACTIONABLE_YELLOW, SEVERITY.ACTIONABLE_RED, SEVERITY.OK]), SEVERITY.ACTIONABLE_RED);
  check("worstSeverity: empty list is OK", worstSeverity([]), SEVERITY.OK);
  check("summarise: all-clear reports zero actionable", summarise([{ severity: SEVERITY.OK }]).actionable, 0);
}

// ── 12 · THE INCIDENT, REPLAYED END TO END ──────────────────────────────────────────
// The owner's screen on 2026-08-06: 57 not indexed. This reproduces the sample he saw and
// asserts the watch would have told him what it MEANT: mostly benign, one real defect.
{
  const incident = [
    // 4 × "Not found (404)" — doubled-locale URLs that now redirect correctly
    ...["en/zh-HK/blog/travel-agency-refund-guide", "zh-CN/zh-HK/blog/travel-agency-refund-guide",
        "zh-HK/blog/travel-agency-refund-guide", "en/zh-HK/cases/repair-dispute-recovered"]
      .map((p) => ({ url: `https://smallclaims.com.hk/${p}`, coverageState: "Not found (404)",
                     inSitemap: false, live: OK200, lastCrawlTime: daysAgo(17) })),
    // 3 × "Crawled - currently not indexed" on real pages — the REAL defect
    ...["blog/travel-agency-refund-guide", "en/blog/travel-agency-refund-guide", "zh-CN/blog/travel-agency-refund-guide"]
      .map((p) => ({ url: `https://smallclaims.com.hk/${p}`, coverageState: "Crawled - currently not indexed",
                     inSitemap: true, live: OK200, lastCrawlTime: daysAgo(17) })),
    // 1 × the font file
    { url: "https://smallclaims.com.hk/fonts/noto-serif-sc.woff2", coverageState: "Crawled - currently not indexed", live: OK200 },
    // 2 × "Discovered - currently not indexed" — live pages awaiting first crawl
    ...["en/use-cases/agency-commission", "en/use-cases/goods-payment"]
      .map((p) => ({ url: `https://smallclaims.com.hk/${p}`, coverageState: "Discovered - currently not indexed",
                     inSitemap: true, live: OK200, firstSeenAt: daysAgo(20) })),
    // 47 × "Page with redirect" — case-normalisation, none declared in the sitemap
    ...Array.from({ length: 47 }, (_, i) => ({ url: `https://smallclaims.com.hk/zh-CN/page-${i}`,
      coverageState: "Page with redirect", inSitemap: false, live: { finalStatus: 200, hops: 1 } })),
  ].map((r) => classifyCoverage({ now: NOW, ...r }));

  const s = summarise(incident);
  check("incident: total rows equals the owner's 57", incident.length, 57);
  check("incident: exactly 3 actionable (the unindexed article, all 3 languages)", s.actionable, 3);
  check("incident: no RED — nothing was urgent that day", s.counts.ACTIONABLE_RED, 0);
  check("incident: the font is the only NOISE row", s.counts.NOISE, 1);
  check("incident: 53 rows explained as benign or noise", s.counts.BENIGN + s.counts.NOISE, 54);
  const article = incident.find((r) => r.code === "CRAWLED_NOT_INDEXED");
  check("incident: the real defect is named, not buried in a count", !!article && article.reason.includes("chose NOT to index"), true);
}

// ── report ──────────────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\nselftest-coverage-classify: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exitCode = 1;
} else {
  console.log(`selftest-coverage-classify: ${pass}/${pass} assertions passed`);
}
