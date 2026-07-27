# site-index-watch

Always-on URL health watch. **No credentials. No local machine.**

## The law it enforces

Every URL a site **declares** in its sitemap must be byte-identical to the URL the
host actually **serves**. A declared URL that redirects is filed by Google as
*"Page with redirect — not indexed"*, and any `hreflang` alternate pointing at it is
**discarded**.

## What it reports

| kind | meaning |
|---|---|
| **LOOP** | redirects forever — permanently unreachable to users *and* crawlers |
| **DEAD** | 4xx/5xx — the sitemap promises a page that does not exist |
| **REDIRECTING** | resolves, but only after a bounce — Google skips these |

## Why these failures hide so well

Static hosts normalise URLs silently, and differently: some lowercase paths, some
append a trailing slash, some do both. Build tooling usually declares the *un*-normalised
form, so every declared URL quietly becomes a redirect while the pages still open fine
in a browser — which is why this class survives ordinary testing.

Worse: when a redirect rule is written to *fight* the host's normalisation, the rule
and the host can bounce a URL back and forth forever. Those pages are completely
unreachable, and a plain `curl -L` hides it by following silently until it gives up.
This follows redirects manually so a loop is detected and both bouncing URLs are named.

## Alerting without secrets

Exits **non-zero** when any site is broken. A cron host that emails on failed runs is
then the whole alerting stack — no token, no webhook, nothing to rot.

## Fails closed, in both directions

- Empty `WATCH_SITES` **aborts** — a watch with nothing to watch reports green forever.
- A site with zero discoverable sitemap URLs is a **finding**, not a silence.

## Config

`WATCH_SITES` — comma-separated origins. That is the entire configuration.
Sitemap location is read from each site's `robots.txt`, never guessed.

```bash
WATCH_SITES=https://example.com,https://example.org node watch.mjs
```
