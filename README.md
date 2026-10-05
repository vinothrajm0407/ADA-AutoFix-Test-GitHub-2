# TaskFlow Analytics — ADA Auto-Fix Test App

Plain static HTML, no build step. Seeded with Tier 1 (straightforward) and
Tier 2 (harder to locate/disambiguate) accessibility violations across 3
pages (`docs/index.html`, `docs/profile.html`, `docs/search.html`) for
testing the ADA Tool's Auto-Fix pipeline end-to-end.

`package.json` is deliberately not included — its presence would make
Auto-Fix attempt a real `npm install && npm run build`, which fails on a
static site with no build tooling.
