# Tego Stock AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a Vercel-hosted A-share research terminal whose market calculations are
deterministic, whose Tushare credentials remain server-side, and whose optional AI reports run
entirely in the browser with local-only persistence.

**Architecture:** A Vite React SPA consumes stable DTOs from thin Vercel Functions backed by a
permission-aware Tushare adapter. Pure browser domain modules compute indicators and explainable
scores; separate browser modules stream OpenAI-compatible reports and persist explicitly approved
local data in IndexedDB. Every transport response and report context carries source, cutoff,
freshness, availability, and limitation metadata.

**Tech Stack:** Node.js 24 CI, npm 11, React 19, TypeScript 6, Vite 8, Zod, Lightweight Charts,
Vitest 4, Testing Library, Playwright 1.61, Oxlint, Oxfmt, Husky, Commitlint, Vercel Functions and
Cron.

---

## Locked file structure

The following boundaries are authoritative for this plan. Provider fields stop at `src/server`,
transport DTOs live in `src/domain`, deterministic calculations live in `src/analysis`, browser
side effects live in `src/ai` and `src/storage`, and React components only compose those public
interfaces.

```text
api/
  cron/daily-close.ts                 authenticated scheduled refresh
  health.ts                           deployment and configuration health
  market/status.ts                    trading-day and freshness response
  stocks/search.ts                    normalized stock search
  stocks/[code]/overview.ts           daily-close and valuation summary
  stocks/[code]/history.ts            normalized OHLCV series
  stocks/[code]/fundamentals.ts       normalized financial series
src/
  ai/client.ts                        browser-only streaming transport
  ai/report-contract.ts               bounded prompt and report validation
  analysis/indicators.ts              pure technical calculations
  analysis/scores.ts                  explainable score components
  app/App.tsx                         routing and application composition
  components/                         terminal UI presentation
  domain/errors.ts                    stable safe error taxonomy
  domain/stock.ts                     codes, dates, DTOs and availability
  server/cache.ts                     cache headers and last-good snapshots
  server/http.ts                      validation, CORS, logging and rate limit
  server/tushare/client.ts             authenticated provider requests
  server/tushare/mapper.ts             provider-to-domain normalization
  server/tushare/schemas.ts            runtime provider validation
  storage/database.ts                  IndexedDB open/migration lifecycle
  storage/repository.ts                watchlist/settings/report interface
  styles/                              terminal tokens and responsive layout
tests/
  browser/                             Playwright workflow and smoke tests
  component/                           React behavior tests
  contract/fixtures/tushare/           redacted fixed provider payloads
  contract/                            adapter and public API contracts
  unit/                                pure domain, analysis, AI and storage tests
```

## Locked analysis formulas

- `SMA(n)`: arithmetic mean of the latest `n` contiguous finite closes; emit `null` until `n`
  values exist.
- `EMA(n)`: seed with `SMA(n)`, then `EMA_t = price_t * 2/(n+1) + EMA_(t-1) * (1 - 2/(n+1))`.
- `MACD`: `EMA(12) - EMA(26)`; signal is `EMA(9)` of the defined MACD line; histogram is MACD minus
  signal.
- `RSI(14)`: Wilder smoothing. Seed average gain/loss from the first 14 changes, then
  `avg_t = (avg_(t-1) * 13 + current) / 14`. Return 50 for a flat window, 100 when loss is zero and
  gain is positive, otherwise `100 - 100/(1 + avgGain/avgLoss)`.
- `Bollinger(20, 2)`: 20-day SMA plus/minus two population standard deviations.
- `volumeRatio20`: current volume divided by 20-day average volume; `expanding` at `>= 1.2`,
  `contracting` at `<= 0.8`, otherwise `normal`.
- `realizedVolatility20`: sample standard deviation of the latest 20 log returns times `sqrt(252)`.
- `drawdown`: `close/runningPeak - 1`; maximum drawdown is the minimum drawdown in the series.
- `trendStrength` (0–100): MA alignment 40 points (`close > MA20 > MA60` = 40, reverse = 0,
  otherwise 20); positive 20-day MA slope = 20 points; positive MACD histogram = 20 points;
  `volumeRatio20 >= 1.0` while the daily return agrees with the MA direction = 20 points. Missing
  observations are listed and their points are removed from both numerator and denominator before
  rescaling to 100.
- `valuationScore` (0–100): percentile positions for PE, PB, and dividend yield over the available
  reference period. Lower PE/PB percentiles and higher yield percentiles score better. Require at
  least two available inputs and average only available inputs.
- `qualityScore` (0–100): ROE 25%, gross margin 15%, revenue growth 15%, profit growth 15%,
  operating-cash/net-profit ratio 20%, debt/assets inverse 10%. Each normalized input is clipped to
  0–100 using thresholds locked in `scores.ts`; omit missing factors and reweight only when at least
  three factors remain.
- Composite scores always expose the calculation version, cutoff date, observations, missing input
  names, available weight, and qualitative band (`weak < 40`, `mixed < 60`, `constructive < 80`,
  `strong >= 80`). They never produce buy/sell instructions.

## Task 1: Establish the verified React application foundation

**Files:**
- Create: `package.json`, `package-lock.json`, `index.html`, `vite.config.ts`, `vitest.config.ts`
- Create: `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`
- Create: `.oxlintrc.json`, `.oxfmtrc.json`, `commitlint.config.js`
- Create: `.husky/pre-commit`, `.husky/commit-msg`, `.github/workflows/ci.yml`
- Create: `scripts/resolve-commit-range.mjs`, `playwright.config.ts`
- Create: `src/main.tsx`, `src/app/App.tsx`, `src/styles/tokens.css`, `src/styles/global.css`
- Create: `tests/setup.ts`, `tests/component/app-shell.test.tsx`, `tests/browser/smoke.spec.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Pin the toolchain and install it**

Create `package.json` with `private: true`, `type: module`, Node `>=20.19.0`, npm `11.13.0`, and
the required scripts. Pin runtime dependencies to React `19.2.7` and development dependencies to
the verified `tego-sheet` versions: TypeScript `6.0.3`, Vite `8.1.4`, React plugin `6.0.3`, Oxlint
`1.74.0`, Oxfmt `0.59.0`, Vitest/Coverage `4.1.10`, jsdom `29.1.1`, Testing Library React
`16.3.2`, DOM `10.4.1`, user-event `14.6.1`, Playwright `1.61.1`, Husky `9.1.7`, Commitlint
`20.5.3`, Node types `24.13.3`, React types `19.2.17`, and React DOM types `19.2.3`.

```json
{
  "name": "tego-stock-ai",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "engines": { "node": ">=20.19.0" },
  "packageManager": "npm@11.13.0",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run",
    "test:unit": "vitest run --project unit --project component --project contract",
    "test:browser": "playwright test tests/browser",
    "typecheck": "tsc -b --pretty false",
    "lint": "oxlint --deny-warnings .",
    "lint:fix": "oxlint --fix .",
    "format": "oxfmt --write .",
    "format:check": "oxfmt --check .",
    "prepare": "husky"
  },
  "dependencies": {
    "react": "19.2.7",
    "react-dom": "19.2.7"
  },
  "devDependencies": {
    "@commitlint/cli": "20.5.3",
    "@commitlint/config-conventional": "20.5.3",
    "@playwright/test": "1.61.1",
    "@testing-library/dom": "10.4.1",
    "@testing-library/react": "16.3.2",
    "@testing-library/user-event": "14.6.1",
    "@types/node": "24.13.3",
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.3",
    "@vitejs/plugin-react": "6.0.3",
    "@vitest/coverage-v8": "4.1.10",
    "husky": "9.1.7",
    "jsdom": "29.1.1",
    "oxfmt": "0.59.0",
    "oxlint": "1.74.0",
    "typescript": "6.0.3",
    "vite": "8.1.4",
    "vitest": "4.1.10"
  }
}
```

Run: `npm install`

Expected: `package-lock.json` is created with lockfile version 3 and `npm audit` reports no known
high-severity production vulnerability.

- [ ] **Step 2: Configure strict compilation and quality gates**

Use browser `ES2022`, `DOM`, `DOM.Iterable`, `moduleResolution: Bundler`, `jsx: react-jsx`,
`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`,
`isolatedModules: true`, and `verbatimModuleSyntax: true`. Configure Oxfmt as:

```json
{
  "singleQuote": true,
  "printWidth": 100
}
```

Configure Oxlint correctness, TypeScript, React, React Hooks and import rules as errors, explicitly
deny `no-explicit-any`, and ignore only generated coverage, build and Playwright artifacts.

- [ ] **Step 3: Write the failing application-shell test**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { App } from '../../src/app/App';

describe('App', () => {
  it('identifies the daily-close research product and its safety boundary', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'A 股研究终端' })).toBeVisible();
    expect(screen.getByText('日线收盘数据')).toBeVisible();
    expect(screen.getByText(/不构成投资建议/)).toBeVisible();
  });
});
```

Run: `npm test -- tests/component/app-shell.test.tsx`

Expected: FAIL because `src/app/App.tsx` does not exist.

- [ ] **Step 4: Implement the minimal accessible shell**

```tsx
export function App() {
  return (
    <main>
      <p>日线收盘数据</p>
      <h1>A 股研究终端</h1>
      <p>所有内容仅供研究与教育使用，不构成投资建议。</p>
    </main>
  );
}
```

Mount the component from `src/main.tsx`, add navy terminal tokens, readable focus styles, and a
responsive centered foundation layout without adding product behavior.

Run: `npm test -- tests/component/app-shell.test.tsx`

Expected: PASS with one test.

- [ ] **Step 5: Add browser smoke and commit-policy checks**

The smoke test opens `/`, asserts the heading and disclaimer, and checks that no horizontal scroll
exists at 390px and 1440px. Husky runs `npm run format:check && npm run lint` before commit and
`npx --no -- commitlint --edit "$1"` for commit messages. CI uses Node 24 and immutable action pins:
checkout `df4cb1c069e1874edd31b4311f1884172cec0e10`, setup-node
`249970729cb0ef3589644e2896645e5dc5ba9c38`, and upload-artifact
`330a01c490aca151604b8cf639adc76d48f6c5d4`.

Run: `npm run format && npm run format:check && npm run lint && npm run typecheck && npm test && npm run build && npm run test:browser`

Expected: all commands exit 0 and Playwright reports 2 responsive smoke cases passed.

- [ ] **Step 6: Commit the independently verified foundation**

```text
chore: establish the verified React application foundation

Constraint: Node.js >=20.19.0 with primary CI on Node.js 24
Rejected: ESLint and Prettier | the approved engineering baseline requires Oxlint and Oxfmt
Confidence: high
Scope-risk: narrow
Tested: format, lint, typecheck, Vitest, production build, and Playwright smoke
```

## Task 2: Protect and normalize A-share market data

**Files:**
- Create: `src/domain/stock.ts`, `src/domain/errors.ts`
- Create: `src/server/tushare/client.ts`, `src/server/tushare/schemas.ts`
- Create: `src/server/tushare/mapper.ts`, `src/server/http.ts`
- Create: `api/health.ts`, `api/stocks/search.ts`, `api/stocks/[code]/overview.ts`
- Create: `api/stocks/[code]/history.ts`, `api/stocks/[code]/fundamentals.ts`
- Create: `tests/contract/fixtures/tushare/*.json`, `tests/contract/tushare-mapper.test.ts`
- Create: `tests/contract/public-api.test.ts`, `tests/unit/domain-stock.test.ts`
- Modify: `package.json`, `package-lock.json`, `vitest.config.ts`, `.env.example`

- [ ] **Step 1: Add runtime validation and write the failing normalization contract**

Pin Zod `4.4.3` and `@vercel/node` `5.8.26`. Add a redacted fixture with
Tushare `ts_code`, `trade_date`, `open`, `high`, `low`, `close`, `vol`, `amount`, and `adj_factor`.
The first contract test must assert the exact public shape:

```ts
expect(mapDailyRows(fixture.items)).toEqual([
  {
    code: '600519.SH',
    date: '2026-07-17',
    open: 1421.5,
    high: 1438,
    low: 1412.01,
    close: 1430.2,
    volumeShares: 3_210_000,
    turnoverCny: 4_580_000_000,
    adjustmentFactor: 1.0342,
  },
]);
```

Run: `npm test -- tests/contract/tushare-mapper.test.ts`

Expected: FAIL because the mapper is absent.

- [ ] **Step 2: Define stable domain types and implement the adapter**

Use branded `StockCode` and `IsoDate` constructors, `Availability<T> = { status: 'available';
value: T } | { status: 'missing'; reason: string }`, and `MarketEnvelope<T>` containing `data`,
`asOf`, `source: 'Tushare Pro'`, `freshness: 'fresh' | 'stale'`, `availability`, and `limitations`.
Validate provider responses before mapping; convert Tushare volume lots to shares and amount
thousands of CNY to CNY. Never export provider field names from `src/server`.

Run: `npm test -- tests/unit/domain-stock.test.ts tests/contract/tushare-mapper.test.ts`

Expected: PASS for valid codes, rejected unsafe dates, mapping, sorting, and missing fields.

- [ ] **Step 3: Write failing public route contracts and implement thin handlers**

Test search trimming and a 50-result cap; code, Chinese name and pinyin-abbreviation matching;
canonical `000001.SZ`/`600519.SH` codes; maximum history range of 10 years; `adjust` limited to
`forward`; per-IP token-bucket exhaustion and reset; safe typed errors `INVALID_INPUT`, `NOT_FOUND`,
`RATE_LIMITED`, `PROVIDER_PERMISSION`, `PROVIDER_RATE_LIMIT`, `PROVIDER_UNAVAILABLE`, and
`INTERNAL_ERROR`.

Each handler validates `Request`, calls an injected adapter, returns `MarketEnvelope`, sets
restrictive production CORS, and uses cache headers appropriate to the payload. Logs include a
request ID and safe provider code but never authorization values or upstream bodies.

Run: `npm test -- tests/contract/public-api.test.ts`

Expected: PASS for success, malformed input, provider permission failure, timeout, redaction, and
field-level missing data.

- [ ] **Step 4: Verify and commit the gateway**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run build`

Commit: `feat(api): protect and normalize A-share market data`

## Task 3: Automate daily-close market snapshots

**Files:**
- Create: `src/server/cache.ts`, `src/server/market-snapshot.ts`
- Create: `src/server/blob-snapshot-store.ts`
- Create: `api/market/status.ts`, `api/cron/daily-close.ts`, `vercel.json`
- Create: `tests/unit/cache.test.ts`, `tests/contract/daily-close-cron.test.ts`
- Modify: `src/domain/stock.ts`, `package.json`, `package-lock.json`, `.env.example`

- [ ] **Step 1: Write failing last-good snapshot tests**

Test that a successful refresh atomically replaces metadata, calendar, and close data; a failed
refresh leaves the prior snapshot intact; reads return `freshness: 'stale'` with the last success
time after the expected close; and no snapshot returns a retryable `PROVIDER_UNAVAILABLE` error.

Run: `npm test -- tests/unit/cache.test.ts`

Expected: FAIL because snapshot storage is absent.

- [ ] **Step 2: Implement the cache contract**

Define `SnapshotStore` with `read(key)`, `writeAtomically(key, value)`, and `recordFailure(key,
safeError)`. Pin `@vercel/blob` `2.6.1` and implement production storage with a private Vercel Blob
store. Upload each validated snapshot to a new immutable date/hash pathname, then conditionally
replace the small `market-snapshots/current.json` pointer with its prior ETag; a failed refresh never
touches the pointer. Use `get(..., { useCache: false })` for the pointer, CDN cache immutable snapshot
objects, and inject an in-memory store only in tests. The Blob integration supplies its managed
token to Vercel; it is not a manually copied project secret and never reaches browser code.

Run: `npm test -- tests/unit/cache.test.ts`

Expected: PASS for immutable writes, optimistic pointer replacement, concurrent refresh conflict,
stale fallback and no-data behavior.

- [ ] **Step 3: Protect Cron and expose market state**

Write the route test first: missing or mismatched `Authorization: Bearer <CRON_SECRET>` returns 401;
an absent server secret returns safe 503; success refreshes the stock directory, calendar and daily
close; provider failure returns 502 while preserving last-good data. Use `CRON_SECRET` only through
server environment access. Configure a UTC schedule after mainland close (`30 8 * * 1-5`).

Run: `npm test -- tests/contract/daily-close-cron.test.ts`

Expected: PASS for protection, refresh, preserved data and market-status freshness.

- [ ] **Step 4: Verify and commit scheduled data refresh**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run build`

Commit: `feat(data): automate daily-close market snapshots`

## Task 4: Make stock signals deterministic and explainable

**Files:**
- Create: `src/analysis/indicators.ts`, `src/analysis/scores.ts`
- Create: `tests/unit/indicators.test.ts`, `tests/unit/scores.test.ts`
- Create: `tests/fixtures/analysis/constant-series.json`, `tests/fixtures/analysis/rising-series.json`

- [ ] **Step 1: Lock indicator fixtures before implementation**

The constant fixture contains 80 closes and volumes of 100. Expected last values: SMA5/20/60 =
100, EMA12/26 = 100, MACD/signal/histogram = 0, RSI14 = 50, Bollinger mean/upper/lower = 100,
volume ratio = 1 and `normal`, realized volatility = 0, current and maximum drawdown = 0.

The rising fixture contains closes 1 through 80 and volumes 100 through 179. Expected last SMA5 =
78, SMA20 = 70.5, SMA60 = 50.5, current drawdown = 0, maximum drawdown = 0, and trend MA alignment
points = 40.

Run: `npm test -- tests/unit/indicators.test.ts`

Expected: FAIL because the indicator module is absent.

- [ ] **Step 2: Implement only the locked pure formulas**

Implement the formulas in this plan, return `null` until each warm-up window exists, reject
non-finite values, preserve input order, and never round internal values. Tests compare floating
point output with `toBeCloseTo(..., 10)`.

Run: `npm test -- tests/unit/indicators.test.ts`

Expected: PASS for constants, rising series, warm-up boundaries, invalid values and a drawdown
series `[100, 120, 90]` whose final/max drawdown is `-0.25`.

- [ ] **Step 3: Lock score missing-data and explanation behavior**

Write tests for a complete quality input `{ roe: 0.16, grossMargin: 0.42, revenueGrowth: 0.2,
profitGrowth: 0.2, operatingCashToNetProfit: 1.2, debtToAssets: 0.32 }`. Every factor normalizes to
80, so weighted contributions are 20, 12, 12, 12, 16 and 8 and the total is exactly 80. A partial
input `{ roe: 0.2, operatingCashToNetProfit: 1.5, debtToAssets: 0.2 }` has 55% raw available weight
and rescales to 100. A two-factor input returns `status: 'insufficient'`.

For valuation, use PE reference `[10, 15, 20, 25]` at current 15 (37.5th midrank percentile, score
62.5), PB reference `[1, 2, 3, 4]` at current 2 (score 62.5), and dividend-yield reference
`[0.01, 0.02, 0.03, 0.04]` at current 0.03 (62.5th midrank percentile, score 62.5). Require four
reference observations per factor and at least two factors. Also test a trend score that lists every
missing observation. Assert `calculationVersion: '1.0.0'`, cutoff date, band and exact contribution
labels.

Run: `npm test -- tests/unit/scores.test.ts`

Expected: FAIL because the score engine is absent.

- [ ] **Step 4: Implement scores and commit**

Implement pure clipping, percentile, reweighting and band helpers. Financial thresholds are: ROE
0–20%, gross margin 10–50%, revenue/profit growth -20–30%, cash/net profit 0–1.5, and debt/assets
inverse 80–20%. Percentile rank is `(countLess + 0.5 * countEqual) / count`. Preserve raw values in
observations and disclose clipped values.

Run: `npm run format:check && npm run lint && npm run typecheck && npm test`

Expected: all analysis tests pass without snapshots hiding numeric expectations.

Commit: `feat(analysis): make stock signals deterministic and explainable`

## Task 5: Present the quantitative terminal workspace

**Files:**
- Create: `src/app/routes.ts`, `src/hooks/use-stock-workspace.ts`
- Create: `src/components/layout/TerminalShell.tsx`, `src/components/search/StockSearch.tsx`
- Create: `src/components/workspace/StockWorkspace.tsx`, `OverviewPanel.tsx`
- Create: `src/components/workspace/TechnicalPanel.tsx`, `FundamentalsPanel.tsx`
- Create: `src/components/workspace/FinancialTrendsPanel.tsx`, `DataStatus.tsx`
- Create: `src/components/charts/PriceChart.tsx`
- Create: `tests/component/stock-search.test.tsx`, `tests/component/stock-workspace.test.tsx`
- Modify: `src/app/App.tsx`, `src/styles/tokens.css`, `src/styles/global.css`
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Pin the chart dependency and test search behavior first**

Pin `lightweight-charts` `5.2.0`. Test a
300 ms debounced search, keyboard selection, loading/empty/error states, code/name/pinyin display,
and aborting a superseded request.

Run: `npm test -- tests/component/stock-search.test.tsx`

Expected: FAIL because the component is absent.

- [ ] **Step 2: Implement search and shell navigation**

Build an accessible left rail with Market Analysis, Saved AI Reports, AI Settings and Local Privacy;
include a local watchlist slot. The top bar always displays selected stock, market state, source and
data cutoff. At compact widths the rail becomes a labeled disclosure drawer. Do not add order-entry
controls or real-time language. Add a production CSP whose `connect-src` permits the project origin
and HTTPS AI endpoints; document that supporting arbitrary browser-configured providers necessarily
broadens outbound HTTPS connectivity and still does not permit scripts or HTML from those origins.

Run: `npm test -- tests/component/stock-search.test.tsx`

Expected: PASS with no `act` warnings.

- [ ] **Step 3: Write workspace state tests before panels**

Test Overview, Technical, Fundamentals, Financial Trends and AI Report tabs; deterministic metrics
render before AI controls; missing fields show their reason; stale data shows last success time;
errors leave available panels usable; source/cutoff/disclaimer remain visible; red/green statuses
also have text and numeric labels.

Run: `npm test -- tests/component/stock-workspace.test.tsx`

Expected: FAIL because the workspace panels are absent.

- [ ] **Step 4: Implement panels and chart adapter**

Render candlesticks, volume, MA5/20/60 and selected indicators from domain values. Keep all finance
calculation outside React. Tables include period and unit columns. Provide a chart text summary for
screen readers and never use unsanitized HTML.

Run: `npm test -- tests/component/stock-workspace.test.tsx`

Expected: PASS for complete, missing, stale and provider-error fixtures.

- [ ] **Step 5: Verify responsive terminal and commit**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run build && npm run test:browser`

Commit: `feat(ui): present the quantitative terminal workspace`

## Task 6: Let users generate reports with their own provider

**Files:**
- Create: `src/ai/client.ts`, `src/ai/report-contract.ts`
- Create: `src/components/ai/AiSettings.tsx`, `src/components/ai/AiReportPanel.tsx`
- Create: `tests/unit/ai-client.test.ts`, `tests/unit/report-contract.test.ts`
- Create: `tests/component/ai-settings.test.tsx`, `tests/component/ai-report.test.tsx`
- Modify: `src/components/workspace/StockWorkspace.tsx`

- [ ] **Step 1: Write the bounded report-context contract test**

Assert a context containing normalized price/fundamental values, deterministic signals,
availability, cutoff, source and limitations. Reject unknown authoritative metrics, contexts above
200 KB, missing cutoff/source and report sections outside the seven approved headings. Assert the
system instruction forbids invented metrics, advice, target prices and guaranteed-return language.

Run: `npm test -- tests/unit/report-contract.test.ts`

Expected: FAIL because the contract is absent.

- [ ] **Step 2: Implement report validation and streaming transport**

The client accepts `{ baseUrl, model, apiKey, signal }`, sends directly with browser `fetch`, parses
OpenAI-compatible SSE `data:` frames, and returns typed `delta`, `complete`, `aborted` and `error`
events. It never logs headers or sends data to `/api`. Write failing tests for split frames,
`[DONE]`, 401, malformed JSON and abort before implementing the parser.

Run: `npm test -- tests/unit/report-contract.test.ts tests/unit/ai-client.test.ts`

Expected: PASS for validation and all stream terminal states.

- [ ] **Step 3: Test and build explicit BYOK settings**

Test that the API key starts session-only, remember-key requires unchecked-by-default explicit
consent, custom endpoints display the extension/compromised-page warning, credential clearing is
immediate, and the key is absent from exports and rendered diagnostics.

Run: `npm test -- tests/component/ai-settings.test.tsx`

Expected: PASS after the minimal settings form is implemented.

- [ ] **Step 4: Test and build report generation states**

Test explicit generate action, streaming sections, cancellation, AI-only retry, complete save,
interrupted draft labeling, missing-metric disclosure and deterministic analysis remaining usable
after AI failure. Render structured React nodes, never `dangerouslySetInnerHTML`.

Run: `npm test -- tests/component/ai-report.test.tsx`

Expected: PASS for success, abort, invalid response and provider failure.

- [ ] **Step 5: Verify and commit browser-only AI**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run build`

Commit: `feat(ai): let users generate reports with their own provider`

## Task 7: Keep watchlists and research history local

**Files:**
- Create: `src/storage/database.ts`, `src/storage/repository.ts`, `src/storage/export.ts`
- Create: `src/components/privacy/PrivacyControls.tsx`
- Create: `src/components/reports/SavedReports.tsx`
- Create: `tests/unit/storage-repository.test.ts`, `tests/component/privacy-controls.test.tsx`
- Create: `tests/component/saved-reports.test.tsx`

- [ ] **Step 1: Write migration and repository tests first**

Use `fake-indexeddb` `6.2.5` as an exact-pinned development dependency. Test database v1 stores watchlists,
UI preferences, provider settings and reports; API keys are omitted unless `rememberKeyConsent` is
true; interrupted reports persist as `draft`; complete reports require all approved sections;
opening the same version is idempotent; migration failure aborts without clearing existing stores.

Run: `npm test -- tests/unit/storage-repository.test.ts`

Expected: FAIL because the database and repository are absent.

- [ ] **Step 2: Implement a versioned IndexedDB boundary**

Expose `LocalRepository` methods `listWatchlist`, `putWatchlistEntry`, `removeWatchlistEntry`,
`getSettings`, `saveSettings`, `listReports`, `saveReport`, `deleteReport`, `clearCredentials` and
`clearAll`. Keep raw IndexedDB events inside `database.ts`; transactions resolve only after
`oncomplete`, and failures reject with typed local-storage errors.

Run: `npm test -- tests/unit/storage-repository.test.ts`

Expected: PASS for migrations, consent, CRUD, drafts and transaction failures.

- [ ] **Step 3: Test and build privacy/report UI**

Test deleting one report, clearing credentials without deleting reports, clearing all local data
behind a confirmation dialog, JSON export without API key, report reload after remount, and visible
local-only/privacy explanations.

Run: `npm test -- tests/component/privacy-controls.test.tsx tests/component/saved-reports.test.tsx`

Expected: PASS after controls and report list are implemented.

- [ ] **Step 4: Verify and commit local persistence**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run build`

Commit: `feat(storage): keep watchlists and research history local`

## Task 8: Lock the primary research workflow in the browser

**Files:**
- Create: `tests/browser/fixtures.ts`, `tests/browser/research-workflow.spec.ts`
- Create: `tests/browser/privacy.spec.ts`, `tests/browser/error-recovery.spec.ts`
- Create: `tests/browser/visual.spec.ts`, `playwright.visual.config.ts`
- Create: `tests/browser/visual.spec.ts-snapshots/*`
- Modify: `playwright.config.ts`, `package.json`

- [ ] **Step 1: Build deterministic route and AI fixtures**

Intercept only the documented project API and configured AI endpoint. Use `600519.SH` fixtures
with fixed `2026-07-17` cutoff, source and missing-field reasons. Stream the AI response in at least
three SSE chunks and retain a separate interrupted stream fixture.

- [ ] **Step 2: Write and pass the main workflow**

Test search by code, inspect source/cutoff and deterministic metrics, switch all workspace views,
configure a fake browser-only AI provider, stream a complete structured report, reload, and read it
from local history. Assert no request containing the AI authorization header targets `/api`.

Run: `npm run test:browser -- tests/browser/research-workflow.spec.ts`

Expected: PASS on Chromium.

- [ ] **Step 3: Write and pass degraded/privacy workflows**

Test no-AI operation, stale cached response, missing financial fields, provider retry, interrupted
AI draft, clearing credentials, clearing all data and no secret appearing in DOM, console or export.

Run: `npm run test:browser -- tests/browser/privacy.spec.ts tests/browser/error-recovery.spec.ts`

Expected: PASS without console errors.

- [ ] **Step 4: Lock desktop and compact visual states**

Capture the overview at 1440×1000 and compact navigation/workspace at 390×844 with a deterministic
font, timezone `Asia/Shanghai`, locale `zh-CN`, disabled animation and fixed data. Run visual tests
on the selected stable CI platform.

Run: `npm run test:visual`

Expected: both screenshots match committed baselines within the configured threshold.

- [ ] **Step 5: Verify and commit end-to-end evidence**

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run build && npm run test:browser && npm run test:visual`

Commit: `test(e2e): lock the primary research workflow`

## Task 9: Require complete evidence before deployment

**Files:**
- Modify: `.github/workflows/ci.yml`, `scripts/resolve-commit-range.mjs`
- Create: `scripts/deployment-smoke.mjs`, `tests/contract/deployment-smoke.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Test deployment-smoke response validation**

Write a contract test for health 200, JSON content type, API error shape, cache headers, SPA fallback,
and Cron 401 without a secret. The smoke script requires an explicit base URL and never prints
environment values.

Run: `npm test -- tests/contract/deployment-smoke.test.ts`

Expected: FAIL before the validator exists, then PASS after minimal implementation.

- [ ] **Step 2: Finalize least-privilege CI topology**

Use `contents: read`, concurrency cancellation, introduced-commit Commitlint, `npm ci`, format,
lint, types, unit/component/contract tests, build and browser smoke on Node 24. Install only Chromium
and its dependencies. Upload Playwright reports only on failure. Keep all actions pinned by full SHA;
do not add automatic secret-bearing pull-request deployment.

Run: `npx commitlint --from HEAD~1 --to HEAD && npm run ci`

Expected: the complete local CI aggregate exits 0.

- [ ] **Step 3: Commit the deployment gate**

Commit: `ci: require complete evidence before deployment`

## Task 10: Explain operation, privacy and Vercel deployment

**Files:**
- Create: `README.md`, `docs/architecture.md`, `docs/deployment.md`, `docs/privacy.md`
- Modify: `.env.example`, `vercel.json`

- [ ] **Step 1: Document the verified operator path**

README includes prerequisites, exact npm commands, Tushare provenance, daily-close limitation,
BYOK browser flow, non-advice statement, local data controls and links to architecture/deployment.
Deployment documents GitHub integration, `TUSHARE_TOKEN`, `CRON_SECRET`, UTC Cron conversion,
permission differences, CSP/custom endpoint tradeoff, smoke command and rollback to last-good
snapshot. Examples contain variable names only, never values.

- [ ] **Step 2: Add documentation contract checks**

Add a Vitest test that reads the documents and asserts every required variable, limitation,
non-advice statement, privacy behavior, health route, Cron protection and smoke command exists;
assert common token patterns and `.env` value assignments are absent from tracked files.

Run: `npm test -- tests/contract/documentation.test.ts`

Expected: FAIL before documentation is complete, then PASS after all required sections exist.

- [ ] **Step 3: Run final security and acceptance verification**

Run: `git grep -nE '(sk-|Bearer [A-Za-z0-9]|TUSHARE_TOKEN=.+|CRON_SECRET=.+)' -- ':!package-lock.json'`

Expected: no secret-like tracked values.

Run: `npm run format:check && npm run lint && npm run typecheck && npm test && npm run build && npm run test:browser && npm run test:visual`

Expected: every gate exits 0 with no warnings or console errors.

- [ ] **Step 4: Commit operational documentation**

Commit: `docs: explain operation privacy and deployment`

## Cross-cutting completion checklist

- [ ] All ten staged commits remain independently understandable and are not squashed.
- [ ] Tushare and Cron secrets appear only as server-side environment variable reads.
- [ ] Browser AI authorization never reaches project Functions, logs, exports or diagnostics.
- [ ] Every analysis and report surface displays source, cutoff, freshness and limitations.
- [ ] Missing data removes dependent score weight and is disclosed instead of fabricated.
- [ ] All application and exported report surfaces show the research/education non-advice notice.
- [ ] Production health, API schema/cache, SPA routing and Cron protection smoke checks pass.
- [ ] Vercel authorization, environment configuration and production smoke are performed only when
  valid operator credentials and Tushare permissions are available.
