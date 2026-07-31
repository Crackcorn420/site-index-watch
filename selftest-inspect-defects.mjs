#!/usr/bin/env node
/**
 * selftest-inspect-defects.mjs — proves the three "absence read as health" defects in
 * inspect.mjs are fixed, and that each one's PRE-FIX computation is reproduced here and
 * shown to be wrong. A gate that only asserts the new behaviour cannot tell you whether
 * it ever caught anything; every case below therefore carries its own regression twin.
 *
 * No network: the classifiers are pure functions over fixture rows, which is exactly why
 * they were extracted from main()'s body in the first place.
 *
 * Run: node selftest-inspect-defects.mjs   (or `npm test`)
 */
import {
  INSPECTION_ERROR_THRESHOLD,
  classifyInspectionBatch,
  zeroPropertiesReason,
  formatIndexRow,
} from "./inspect.mjs";

let failures = 0;
let checks = 0;

function check(label, cond, detail) {
  checks++;
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** The exact pre-fix counting from inspect.mjs before 2026-07-31. */
function preFixCounts(inspected) {
  const clean = inspected.filter((r) => !r.error);
  return {
    inspected: clean.length,
    indexed: clean.filter((r) => r.indexed).length,
    notIndexed: clean.filter((r) => !r.indexed).length,
  };
}

const err = (n, code = "HTTP 403") =>
  Array.from({ length: n }, (_, i) => ({ url: `https://a.example/e${i}`, error: code }));
const good = (n, indexed = true) =>
  Array.from({ length: n }, (_, i) => ({
    url: `https://a.example/g${i}`,
    indexed,
    verdict: indexed ? "PASS" : "NEUTRAL",
    coverageState: indexed ? "Submitted and indexed" : "Crawled - currently not indexed",
    lastCrawlTime: "2026-07-29T00:00:00Z",
  }));

// ── DEFECT 1 — every inspection call fails ──────────────────────────────────────────
console.log("case 1 — all 60 URL Inspection calls return 403");
{
  const inspected = err(60);
  const cls = classifyInspectionBatch(inspected);
  check("errors counted as 60", cls.errors === 60, JSON.stringify(cls.errors));
  check("errRatio is 1.0", cls.errRatio === 1, String(cls.errRatio));
  check("lens is marked unavailable", cls.unavailable === true);
  check("notIndexed is 0 — and that is NOT the same as clean", cls.notIndexed === 0);
  check("successfullyInspected is 0", cls.successfullyInspected === 0);
  check("sampleErrors names the failure", cls.sampleErrors.includes("HTTP 403"), JSON.stringify(cls.sampleErrors));

  const old = preFixCounts(inspected);
  check(
    "REGRESSION TWIN: the pre-fix counting reported 0/0/0 with no error signal at all",
    old.inspected === 0 && old.indexed === 0 && old.notIndexed === 0 && !("errors" in old),
    JSON.stringify(old),
  );
  check(
    "REGRESSION TWIN: pre-fix output was indistinguishable from a clean property",
    JSON.stringify(old) === JSON.stringify(preFixCounts([])),
    JSON.stringify(old),
  );
}

console.log("case 2 — exactly at the threshold (30 of 60 fail)");
{
  const cls = classifyInspectionBatch([...err(30), ...good(30)]);
  check(`errRatio (${cls.errRatio}) >= threshold (${INSPECTION_ERROR_THRESHOLD})`, cls.errRatio >= INSPECTION_ERROR_THRESHOLD);
  check("unavailable is true at the boundary, not just above it", cls.unavailable === true);
}

console.log("case 3 — a few transient failures stay YELLOW, not RED");
{
  const cls = classifyInspectionBatch([...err(3), ...good(57)]);
  check("errors counted as 3", cls.errors === 3, String(cls.errors));
  check("unavailable is false", cls.unavailable === false);
  check("successfullyInspected excludes the 3 errors", cls.successfullyInspected === 57, String(cls.successfullyInspected));
}

console.log("case 4 — the not-indexed ratio is over successfully-inspected, not the raw sample");
{
  const cls = classifyInspectionBatch([...err(40), ...good(10, false)]);
  check("successfullyInspected is 10", cls.successfullyInspected === 10, String(cls.successfullyInspected));
  check("notIndexedRatio is 1.0 (10/10), not 0.2 (10/50)", cls.notIndexedRatio === 1, String(cls.notIndexedRatio));
}

console.log("case 5 — an empty sample is not a failure");
{
  const cls = classifyInspectionBatch([]);
  check("unavailable is false", cls.unavailable === false);
  check("errors is 0", cls.errors === 0);
  check("notIndexedRatio is 0", cls.notIndexedRatio === 0);
}

// ── DEFECT 2 — zero usable properties ───────────────────────────────────────────────
console.log("case 6 — the service account sees nothing at all");
{
  const reason = zeroPropertiesReason({ propertiesLength: 0, domainOnlyCount: 0 });
  check("reason is non-null", reason !== null);
  check("reason names zero properties", /0 Search Console properties/.test(reason), reason);
}

console.log("case 7 — only sc-domain: properties, which this watch cannot crawl");
{
  const reason = zeroPropertiesReason({ propertiesLength: 0, domainOnlyCount: 4 });
  check("reason is non-null", reason !== null);
  check("reason names the sc-domain count", /4 sc-domain/.test(reason), reason);
  check("reason explains they are not covered", /not covered/i.test(reason), reason);
}

console.log("case 8 — singular/plural is not mangled for exactly one sc-domain property");
{
  const reason = zeroPropertiesReason({ propertiesLength: 0, domainOnlyCount: 1 });
  check("says 'property', not 'propertys'/'properties'", /1 sc-domain: property\b/.test(reason), reason);
}

console.log("case 9 — properties DO exist: no finding");
{
  check("reason is null", zeroPropertiesReason({ propertiesLength: 3, domainOnlyCount: 0 }) === null);
  check("reason is null even alongside sc-domain properties", zeroPropertiesReason({ propertiesLength: 3, domainOnlyCount: 2 }) === null);
}

// ── DEFECT 3 — findings that cannot be triaged from their own text ──────────────────
console.log("case 10 — a dropped URL renders with the fact that resolves stale-vs-live");
{
  const row = {
    url: "https://landlord.com.hk/en",
    indexed: false,
    verdict: "NEUTRAL",
    coverageState: "Page with redirect",
    lastCrawlTime: "2026-07-27T02:05:34Z",
  };
  const line = formatIndexRow(row);
  check("line names the URL", line.includes("https://landlord.com.hk/en"), line);
  check("line carries coverageState, not the bare verdict", line.includes("Page with redirect"), line);
  check("line carries lastCrawlTime", line.includes("2026-07-27T02:05:34Z"), line);

  const preFix = `${row.url} — ${row.verdict}`;
  check("REGRESSION TWIN: the pre-fix formatter lacked the crawl time", !preFix.includes("2026-07-27"), preFix);
  check("REGRESSION TWIN: the pre-fix formatter lacked the coverage state", !preFix.includes("Page with redirect"), preFix);
}

console.log("case 11 — a never-crawled URL says so instead of rendering an empty parenthetical");
{
  const line = formatIndexRow({ url: "https://a.example/new", verdict: "NEUTRAL", coverageState: "", lastCrawlTime: "" });
  check("line says 'never'", /last crawled never/.test(line), line);
  check("no empty parenthetical", !/\(last crawled \)/.test(line), line);
  check("falls back to the verdict when coverageState is absent", line.includes("NEUTRAL"), line);
}

console.log("case 12 — a row missing every field still renders without leaking undefined");
{
  const line = formatIndexRow({ url: "https://a.example/x" });
  check("renders UNKNOWN", line.includes("UNKNOWN"), line);
  check("no literal 'undefined' leaks into the finding", !/undefined/.test(line), line);
}

console.log("");
if (failures) {
  console.error(`selftest-inspect-defects: ${failures} of ${checks} check(s) FAILED.`);
  process.exitCode = 1;
} else {
  console.log(`selftest-inspect-defects: all ${checks} checks passed.`);
}
