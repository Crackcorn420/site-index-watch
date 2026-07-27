# site-index-watch

Always-on URL health watch for every site we run. **No credentials. No PC.**

## What it asserts

**The declared-URL law:** every URL a site declares in its sitemap must be
byte-identical to the URL the host actually serves. A declared URL that redirects
is filed by Google as *"Page with redirect — not indexed"*, and any `hreflang`
alternate pointing at it is **discarded**.

It reports three failure kinds:

| kind | meaning |
|---|---|
| **LOOP** | redirects forever — permanently unreachable to users *and* crawlers |
| **DEAD** | 4xx/5xx — the sitemap promises a page that does not exist |
| **REDIRECTING** | resolves, but only after a bounce — Google skips these |

## Why it exists

On 2026-07-27 the owner opened Search Console, saw *"57 pages not indexed"*, and
asked. The cause had been live for weeks and nothing was watching. A watch was built
the same day — but as a Windows Scheduled Task, so it only ran when one particular PC
was on **and logged in**.

On its first run it found `landlord.com.hk` with **89 of 90 sitemap URLs broken**,
including **three infinite redirect loops** — pages no human or crawler could open.
Nobody had asked it to look there.

## Why this half can run free

The original watch had two lenses. The Google lens needs the service-account key, so
it is vault-bound and therefore PC-bound. The **live lens needs nothing but
internet** — and the live lens is the one that found everything above.

## Alerting

`watch.mjs` exits **non-zero** when a site is broken. Render emails the account on a
failed cron run, so the alarm needs no token and no webhook.

## Config

`WATCH_SITES` — comma-separated origins. That is the whole configuration.
An empty value **aborts** rather than reporting green: a watch with nothing to watch
looks identical to a healthy fleet, which is the failure mode this replaces.

## Run locally

```bash
WATCH_SITES=https://smallclaims.com.hk,https://landlord.com.hk node watch.mjs
```
