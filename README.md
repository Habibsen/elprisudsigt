# Elprisudsigt

A small, permanent Danish DK1 electricity-price website. Open index.html through an HTTP server. No build step, runtime framework, server, credentials, tracking or daily deployments. GitHub Pages serves the static files; browsers fetch current data directly with CORS.

## Ownership
Frontend design and presentation implementation: Claude CLI `claude-opus-5-5`, `--effort high` (explicitly authorized after max-effort attempts exhausted their reasoning budgets without producing frontend files). Data, research, calculations, integration, testing and deployment: Hermes.

## Pricing and sources (verified 2026-09-29)
- API documentation: https://elpriser.org/api and https://elpriser.org/api/openapi.json
- Forecast: `/api/forecast?area=DK1&mode=spot_ex`, hourly LightGBM forecast plus actual published prices. Exactly today + six local dates are displayed. No invented forecasts beyond source coverage.
- Official prices: `/api/raw/prices?area=DK1&start=YYYY-MM-DD&end=YYYY-MM-DD`. Energinet quarter-hour records are averaged only when all four quarters exist. Official hours override forecast hours by UTC instant.
- Grid lookup through API (DAWA + Green Power Denmark) resolved the configured Halgårde location to **NOE Net A/S**, not the initially suggested L-NET. No home address/coordinates are included in the public project.
- NOE Net GLN: `5790000395620`. Household C-tariff is assumed. Actual meter tariff class is not contract-verified.
- Grid rates fetched dynamically from `/api/raw/tariff?gln=5790000395620`, selected by ValidFrom/ValidTo and local hour. Verified against https://noe.dk/prisblad/ and its January 2026 price sheet. Summer ex-VAT low/high/peak: .0563/.0845/.2197 DKK. Winter: .0563/.169/.507. October 1 switches season automatically.
- L-NET July 2026 PDF was researched, but not used because address lookup indicated NOE Net. Its inclusive/exclusive columns also contain inconsistent VAT arithmetic, so copying them would not be justified.
- National rates fetched dynamically from `/api/raw/encharges`: codes 40000 (transmission), 41000 (system), EA-001 (electricity duty), with validity windows. 2026 rates .043 + .072 + .008 DKK/kWh ex VAT. These are not the fixed annual subscriptions.
- Price = (spot ex VAT + local grid tariff ex VAT + national charges ex VAT) * 1.25 + configurable supplier markup inclusive of VAT.
- EVDK publicly advertises 9 øre/kWh after an introductory six months at zero: https://evdk.dk/pages/elaftale. Default .09 DKK/kWh, user-adjustable including zero. Exact private contract and offer eligibility are unknown. No fixed monthly or annual charges are allocated.
- Important provider finding: `forecast?mode=net_inkl_alt&gln=...` returned the same values as `inkl_alt` in the live verification, omitting the grid charge. This app intentionally uses raw spot plus explicit dated tariffs instead. The daily `/api/prices?mode=net_inkl_alt` endpoint was independently compared; calculated totals agree within 0.00005 DKK (rounding), before supplier markup.

## Time, caching and honesty
Europe/Copenhagen is explicit everywhere, regardless of device timezone. Days have 23/24/25 actual UTC hour slots. Repeated autumn 02:00 hours carry offset labels. Since the forecast provider supplies 24 wall-clock points, both autumn 02:00 slots share its forecast value, explicitly marked forecast; actual UTC records distinguish them. Partial official hours are not accepted. Missing prices/tariffs are not silently set to zero. Statistics use available displayed hours and missing data is stated.

Endpoint responses cache locally for five minutes, with last-successful fallback on errors. Refresh bypasses browser/application TTL (provider edge cache may persist briefly). Cached data remains associated with its actual date and is never relabeled today's data. First-load failure has a retry state. Forecasts are estimates, not guaranteed consumer bills. The API offers best-effort uptime, no SLA.

## Tests
`npm test` runs deterministic data regression tests including signed prices, statistics, markup, missing data, mixed provenance, October seasonal switch and both DST transitions.
Browser integration tests use Playwright against live data, then simulated network outage on the same browser cache. No synthetic price data is shipped to production.
