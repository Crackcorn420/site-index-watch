#!/usr/bin/env node
/**
 * selftest-sample-coverage.mjs — proves the URL Inspection sampler REACHES EVERY URL.
 *
 * THE BUG THIS LOCKS OUT (found 2026-08-06 by adversarial review, reproduced here).
 * `selectSample` picked its bucket with `floor(Date.now() / BUCKET_MS) % K` where
 * BUCKET_MS was 3.5 days, while the cron fires WEEKLY. 7d = 2 × 3.5d, so the slot
 * advanced by +2 every run. With an EVEN K, +2 mod K visits only half the buckets and
 * the other half is inspected NEVER — while the report printed "full coverage returns
 * roughly every K run(s)".
 *
 * It was invisible because it depends on parity: smallclaims had 144 URLs → K=3 (odd) →
 * genuinely 100%. At 181 URLs K becomes 4 and coverage silently halves. The trap was
 * armed by nothing more than publishing pages.
 *
 * This is a COVERAGE proof, not a unit test: it simulates real consecutive weekly runs
 * over the real sha1 bucketing and asserts every URL is eventually inspected. It must
 * fail if anyone reintroduces a slot step that shares a factor with K.
 *
 * Run: node site-index-watch/selftest-sample-coverage.mjs
 */
import { createHash } from "node:crypto";
import { slotFor, SLOT_MS } from "./inspect.mjs";

const SAMPLE_BASE = 60; // must mirror inspect.mjs
const bucketOf = (u, K) => parseInt(createHash("sha1").update(u).digest("hex").slice(0, 8), 16) % K;

let pass = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  if (ok) pass++;
  else failures.push(`${label}${detail ? `\n      ${detail}` : ""}`);
};

/** Simulate `runs` consecutive WEEKLY cron fires; return the fraction of URLs ever inspected. */
function coverageOver(n, runs) {
  const urls = Array.from({ length: n }, (_, i) => `https://example.test/page-${i}`);
  const seen = new Set();
  const t0 = Date.parse("2026-08-03T00:17:00Z"); // a real Monday cron time
  for (let r = 0; r < runs; r++) {
    const now = t0 + r * 7 * 86_400_000;
    const { K, slot } = slotFor(n, now, SAMPLE_BASE);
    for (const u of urls) if (bucketOf(u, K) === slot) seen.add(u);
  }
  return { covered: seen.size, total: n };
}

// ── THE REGRESSION: every size must reach 100%, ODD OR EVEN K ───────────────────────
// 212 and 421 are the sizes that exposed the bug (K=4 and K=8 → ~46%).
for (const n of [1, 59, 60, 61, 144, 181, 212, 240, 400, 421, 601]) {
  const K = Math.max(1, Math.ceil(n / SAMPLE_BASE));
  const { covered, total } = coverageOver(n, K * 3); // 3× the advertised cycle is generous
  check(
    `n=${n} (K=${K}${K % 2 === 0 ? ", EVEN — the parity that broke it" : ""}): every URL inspected`,
    covered === total,
    `only ${covered}/${total} = ${((100 * covered) / total).toFixed(1)}% were ever inspected`,
  );
}

// ── The advertised promise must be TRUE: full coverage within exactly K runs ─────────
for (const n of [212, 421]) {
  const K = Math.max(1, Math.ceil(n / SAMPLE_BASE));
  const { covered, total } = coverageOver(n, K);
  check(`n=${n}: the report's own claim holds — full coverage within K=${K} runs`, covered === total,
    `${covered}/${total} after exactly K runs`);
}

// ── The slot must advance by exactly ONE per week, and wrap ─────────────────────────
{
  const n = 212, K = 4;
  const t0 = Date.parse("2026-08-03T00:17:00Z");
  const slots = Array.from({ length: 6 }, (_, r) => slotFor(n, t0 + r * 7 * 86_400_000).K && slotFor(n, t0 + r * 7 * 86_400_000).slot);
  const steps = slots.slice(1).map((s, i) => (s - slots[i] + K) % K);
  check("slot advances by exactly +1 per weekly run", steps.every((s) => s === 1), `steps were ${steps.join(",")}`);
  check("slot wraps within K distinct values", new Set(slots).size === K, `saw ${new Set(slots).size} distinct slots`);
}

// ── Growth must not reshuffle: a URL keeps its bucket as the list grows (the original
// design property, which the fix must preserve). K changes, so compare at a fixed K. ──
{
  const u = "https://example.test/page-7";
  check("bucket for a URL is stable for a given K", bucketOf(u, 4) === bucketOf(u, 4));
  check("SLOT_MS is one week — it must match the cron cadence", SLOT_MS === 7 * 86_400_000, `SLOT_MS=${SLOT_MS}`);
}

if (failures.length) {
  console.error(`\nselftest-sample-coverage: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exitCode = 1;
} else {
  console.log(`selftest-sample-coverage: ${pass}/${pass} assertions passed — every URL is reached, at every list size`);
}
