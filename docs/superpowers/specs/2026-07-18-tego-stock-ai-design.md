# tego-stock-ai product and technical design

Status: approved for implementation planning  
Date: 2026-07-18  
Target directory: `/Users/seal/projects/tego-stock-ai`  
Package/application name: `tego-stock-ai`

## 1. Background and intent

Build an AI-powered Chinese A-share research website inspired by the analysis workflow demonstrated
by DR-lin-eng's `stock-scanner` Flask application, especially its sequence of collecting market and
fundamental data, calculating deterministic indicators, and then asking an LLM to explain the
result.

Reference:

- <https://github.com/DR-lin-eng/stock-scanner/blob/main/3.0%20webapp%EF%BC%88%E6%94%AF%E6%8C%81%E6%B8%AF%E8%82%A1%E7%BE%8E%E8%82%A1%EF%BC%89/flask_web_server.py>

The implementation is a new React application, not a port or copy of the upstream Python source.
The reference supplies product inspiration and workflow ideas only. No upstream source code should
be copied into this repository.

The product must be deployable to Vercel and require no routine operator intervention after initial
authorization and secret configuration.

## 2. Approved decisions

| Area | Decision |
| --- | --- |
| Market scope | Mainland China A shares |
| Freshness | Historical data and daily close; no real-time promise |
| Data provider | Tushare Pro |
| Data architecture | On-demand Vercel data gateway plus daily market snapshot Cron |
| Frontend | React + TypeScript + Vite |
| Visual direction | Dark quantitative terminal with high information density |
| AI architecture | Browser BYOK using an OpenAI-compatible API |
| User identity | No accounts |
| Persistence | Local-only watchlists, preferences, and report history |
| v1 analysis | Price history, technical indicators, valuation, fundamentals, financial quality |
| Explicitly excluded | News sentiment, real-time trading, cloud sync, social features |

## 3. Product goals

1. A user can find any supported A-share company by code, name, or pinyin abbreviation.
2. The site explains current daily-close market structure through charts and deterministic metrics.
3. The site combines technical, valuation, and fundamental information without hiding missing data.
4. A user can generate a structured research report with their own AI provider and API key.
5. Every conclusion exposes its data date, source, contributing metrics, and limitations.
6. The application remains useful when AI is not configured or temporarily unavailable.
7. Production deployment, daily data refresh, and CI operate automatically after authorization.

## 4. Non-goals and safety boundary

- Do not advertise or imply real-time quotes.
- Do not execute trades or connect to brokerage accounts.
- Do not produce deterministic buy/sell orders, target prices, or guaranteed-return language.
- Do not add a user account, subscription, payment, or server-side report store in v1.
- Do not scrape news or add sentiment analysis in v1.
- Do not expose the operator's Tushare Token or require an operator-funded AI key.
- Do not treat AI prose as a source of calculated financial values.

Every analytical screen and exported report must state that the material is for research and
education only and does not constitute investment advice.

## 5. User experience

### 5.1 Visual language

Use the approved quantitative-terminal direction:

- Dark navy surfaces, cool blue accents, restrained red/green market colors, and compact typography.
- High information density without simulating an order-entry terminal.
- Data freshness and market state stay visible in the header.
- Charts and raw metrics precede AI narrative.
- Color never acts as the only status signal; pair it with text, icons, or numeric labels.
- Desktop is the primary research surface. Tablet and mobile must remain functional through stacked
  panels and a collapsible navigation drawer.

### 5.2 Primary navigation

- Market analysis
- Saved AI reports
- AI provider and model settings
- Local privacy and data controls

The left rail contains navigation and the locally stored watchlist. The top bar contains stock
search, data date, and market state.

### 5.3 Stock workspace

The stock workspace contains these views:

1. **Overview:** price, change, composite signals, primary chart, key valuation and quality metrics.
2. **Technical:** daily candlestick/volume chart and indicator explanations.
3. **Fundamentals:** valuation, profitability, operating quality, and balance-sheet signals.
4. **Financial trends:** comparable quarterly/annual series with period and unit labels.
5. **AI report:** explicit generation action, streaming state, structured report, and local history.

The user sees deterministic analysis before choosing whether to send the structured dataset to an AI
provider.

## 6. System architecture

### 6.1 Browser application

The Vite SPA owns:

- Search and routing
- Charts and data tables
- Deterministic technical and scoring calculations
- AI request construction and streaming response handling
- IndexedDB persistence for preferences, watchlists, provider configuration, and report history
- Export and local deletion

The browser communicates with two independent systems:

1. The project's Vercel data API for public stock information.
2. The user's configured OpenAI-compatible endpoint for AI generation.

AI requests do not transit the project's Vercel Functions.

### 6.2 Vercel data gateway

Vercel Functions own:

- Request validation and normalization
- Tushare authentication
- Provider request execution
- Response schema validation
- Conversion from provider fields to stable application-domain fields
- Cache policy, rate limiting, and safe error mapping
- Redacted operational logging

The gateway is deliberately thin. It does not calculate investment signals, call an AI provider, or
persist user identity.

Suggested public routes:

- `GET /api/health`
- `GET /api/stocks/search?q=...`
- `GET /api/stocks/:code/overview?asOf=...`
- `GET /api/stocks/:code/history?start=...&end=...&adjust=forward`
- `GET /api/stocks/:code/fundamentals?asOf=...`
- `GET /api/market/status`
- `GET /api/cron/daily-close` (secret-protected and not a user-facing endpoint)

The implementation plan may consolidate related routes when doing so preserves explicit domain
interfaces and avoids request waterfalls.

### 6.3 Tushare data usage

Expected provider capabilities include:

- Stock directory and listing state
- Trading calendar
- Daily OHLCV and adjustment factors
- Daily valuation metrics
- Financial indicators and the minimum statements required to explain quality trends

The application must tolerate provider permission differences. Each response includes an `asOf`
date, source label, freshness state, and field-level availability metadata. Provider-specific names
must not leak past the server-side adapter.

### 6.4 Cache and scheduled refresh

The selected approach is request-driven data loading plus daily snapshots:

- Cache stock directory and trading calendar aggressively.
- Cache daily-close responses until the next expected market close.
- Cache historical/fundamental responses according to their update cadence.
- Run Vercel Cron after the mainland market close using an explicitly UTC schedule.
- Refresh stock metadata, trading calendar, and the daily all-market close snapshot.
- Historical or company-specific data may load on demand and then use CDN caching.

Cron requests require a secret. A failed Cron run must not delete the previous successful snapshot.

## 7. Domain modules and interfaces

Keep implementation units small and replaceable:

- `stock-domain`: stable codes, dates, currencies, periods, and normalized domain types.
- `tushare-adapter`: provider request/response mapping and permission-aware errors.
- `stock-api`: request validation, cache headers, rate limiting, and public transport DTOs.
- `indicator-engine`: pure deterministic technical calculations.
- `score-engine`: explainable component scores and missing-data rules.
- `ai-client`: browser-only OpenAI-compatible streaming client.
- `report-builder`: deterministic prompt context and validated report sections.
- `local-repository`: IndexedDB access and versioned migrations.
- `terminal-ui`: presentation components that consume domain interfaces, not provider responses.

Finance calculations must be deterministic pure functions with fixtures. UI components do not
silently derive domain values.

## 8. Deterministic analysis

The initial indicator set is intentionally bounded:

- Moving averages: MA5, MA20, MA60
- EMA and MACD
- RSI 14
- Bollinger Bands
- Volume trend
- Realized volatility and drawdown
- Trend strength derived from explicit documented rules
- Valuation position using available historical/reference periods
- Profitability and quality signals using ROE, margins, growth, cash-flow quality, and leverage where
  the provider supplies comparable values

Scores are explanatory summaries, not AI output. Each score exposes:

- Numeric value and qualitative band
- Contributing observations
- Missing inputs
- Calculation version
- Data cutoff date

The implementation plan must specify formulas and fixture-based expected values before writing the
score engine.

## 9. AI provider and report contract

### 9.1 BYOK configuration

The user supplies:

- OpenAI-compatible Base URL
- Model identifier
- API key

The key is session-only by default. The user may explicitly opt into remembering it on the current
device. The UI must explain that browser storage cannot protect a key from malicious extensions or a
compromised page. Never log, export, or send the key to the project's server.

### 9.2 Report generation

The browser sends a bounded, structured context containing normalized data, deterministic signals,
availability metadata, and the data cutoff date. The report contract contains:

1. Data summary and cutoff date
2. Technical structure and supporting observations
3. Fundamentals, valuation, and financial quality
4. Bull, base, and bear scenarios
5. Key risks and invalidation conditions
6. Missing information and questions requiring further research
7. Data sources and limitations

The AI must not invent missing metrics. Any financial number shown as authoritative must originate in
the validated context. A partially streamed response is saved only as a draft and never labeled a
complete report.

## 10. Local persistence and privacy

Use IndexedDB behind a versioned repository interface. Persist only:

- Watchlist entries
- UI preferences
- AI provider settings
- Optional remembered API key, only after explicit consent
- Generated report metadata, context snapshot, and response

Users can delete one report, clear their AI credentials, or clear all local application data. There
is no analytics or telemetry requirement in v1. If operational analytics are later proposed, they
require a separate privacy design.

## 11. Error handling and degraded operation

| Failure | Required behavior |
| --- | --- |
| Tushare timeout/rate limit | Return a still-usable cached response with a stale marker; otherwise show a retryable error |
| Invalid/insufficient Tushare Token | Log a redacted provider code and return a safe configuration/permission error |
| Missing financial fields | Preserve price/technical analysis, omit dependent score inputs, disclose gaps |
| AI endpoint/key/model failure | Preserve all deterministic analysis and allow an AI-only retry after settings change |
| AI stream interruption | Keep an explicitly incomplete local draft |
| Cron failure | Retain the previous snapshot, expose freshness, and record an observable failure |
| Invalid client input | Reject unknown codes, unsafe dates, oversized ranges, and malformed parameters |

All external errors map to a small typed application error taxonomy. Do not send upstream response
bodies or secrets to the browser.

## 12. Security requirements

- Store `TUSHARE_TOKEN` and `CRON_SECRET` only in Vercel environment variables.
- Maintain `.env.example` with names and explanations, never values.
- Validate all request parameters and provider payloads at runtime.
- Apply sensible per-IP/request cache and rate-limit protections to public functions.
- Use restrictive CORS for production APIs.
- Add a Content Security Policy compatible with explicitly configured AI endpoints; document the
  security tradeoff of custom endpoints.
- Never inject AI output as unsanitized HTML.
- Redact authorization headers, query secrets, and provider tokens from logs and test artifacts.
- Pin CI actions by immutable commit SHA and run least-privilege GitHub permissions.

## 13. Testing and verification

### 13.1 Test layers

- **Unit:** indicator formulas, scoring rules, dates, normalization, missing-data behavior.
- **Contract:** fixed Tushare fixtures validate adapter and DTO behavior without a live Token.
- **Component:** search, terminal states, settings, report streaming, IndexedDB behavior.
- **Browser/e2e:** search a fixture stock, inspect metrics, generate a mocked AI report, reload, and
  read local history.
- **Visual:** key desktop terminal state and at least one compact responsive state.
- **Deployment smoke:** production health, API shape, cache headers, SPA routing, Cron protection.

### 13.2 CI gates

Every pull request and push to `main` must run:

1. Introduced-commit Conventional Commit validation
2. `npm ci`
3. `npm run format:check`
4. `npm run lint`
5. `npm run typecheck`
6. Unit, component, and contract tests
7. Production build
8. Playwright browser tests

Upload Playwright reports on failure. Use concurrency cancellation for superseded runs. Production
deployment remains Vercel's Git integration responsibility after CI passes; deployment configuration
must not weaken repository quality gates.

## 14. Engineering and formatting conventions

These conventions intentionally follow `/Users/seal/projects/tego-sheet`:

- npm with committed `package-lock.json`
- React + TypeScript + Vite
- Node.js engine `>=20.19.0`, primary CI on Node.js 24
- Exact direct dependency versions
- `type: module`
- Oxlint, not ESLint
- Oxfmt, not Prettier
- Oxfmt: `singleQuote: true`, `printWidth: 100`
- Oxlint correctness rules as errors, React hooks/compiler rules, TypeScript rules including
  `no-explicit-any`, and `--deny-warnings` in CI
- Vitest + Testing Library for unit/component tests
- Playwright for browser and visual tests
- Commitlint with `@commitlint/config-conventional`
- Husky pre-commit: `npm run format:check && npm run lint`
- Husky commit-msg: `commitlint --edit`

Core package scripts should include at least:

```json
{
  "dev": "vite",
  "build": "tsc -b && vite build",
  "test": "vitest run",
  "typecheck": "tsc --noEmit",
  "lint": "oxlint --deny-warnings .",
  "lint:fix": "oxlint --fix .",
  "format": "oxfmt --write .",
  "format:check": "oxfmt --check .",
  "test:browser": "playwright test",
  "prepare": "husky"
}
```

Generated artifacts, fixtures that encode exact external payloads, visual snapshots, and design
documents may be excluded from formatting only when formatting would alter their contract.

## 15. Commit strategy

Preserve development history. Do not implement this project as a single commit and do not squash the
following milestones into an initial import:

1. `chore: establish the verified React application foundation`
   - Vite/React/TypeScript, Oxlint/Oxfmt, Vitest, Husky, Commitlint, base CI.
2. `feat(api): protect and normalize A-share market data`
   - Tushare adapter, validation, typed errors, fixture contract tests, initial Functions.
3. `feat(data): automate daily-close market snapshots`
   - Cache policy, Cron protection, refresh workflow, stale-data behavior.
4. `feat(analysis): make stock signals deterministic and explainable`
   - Indicator and score engines with formula fixtures.
5. `feat(ui): present the quantitative terminal workspace`
   - Shell, search, stock workspace, charts, responsive states, component tests.
6. `feat(ai): let users generate reports with their own provider`
   - BYOK settings, streaming client, report contract, failure handling.
7. `feat(storage): keep watchlists and research history local`
   - IndexedDB repository, migrations, privacy controls, export/delete.
8. `test(e2e): lock the primary research workflow`
   - Browser and visual coverage, deterministic AI/provider fixtures.
9. `ci: require complete evidence before deployment`
   - Final CI topology, artifacts, protected deployment expectations.
10. `docs: explain operation privacy and deployment`
    - README, architecture, environment variables, Vercel setup, data/risk attribution.

Small corrective commits are allowed and should remain visible when they represent real development
decisions. Each commit uses a Conventional Commit header. When meaningful, include decision-record
trailers such as `Constraint`, `Rejected`, `Confidence`, `Scope-risk`, `Directive`, `Tested`, and
`Not-tested`.

## 16. Deployment and authorization boundary

The implementation agent can complete code, repository setup, GitHub CI, Vercel project creation,
environment configuration, deployment, and smoke verification. The user must intervene only for
authority that cannot be delegated:

1. Vercel login/OAuth authorization.
2. GitHub authorization if the existing `gh` session is unavailable or lacks repository scope.
3. Tushare registration/terms and provision of a valid Token with sufficient endpoint permissions.
4. Custom-domain or DNS authorization, only if a custom domain is requested.

After those authorizations, deployment and daily operation should require no routine manual action.

Required production variables:

- `TUSHARE_TOKEN`
- `CRON_SECRET`

The user's AI key is not a Vercel variable.

## 17. Acceptance criteria

The project is complete when:

- A production Vercel URL loads the responsive terminal UI.
- A user can search supported A shares and inspect daily-close historical/technical/fundamental data.
- All screens display source and cutoff date.
- Deterministic metrics match locked fixture expectations.
- Missing or stale data is explicit and does not produce fabricated scores.
- A user can configure an OpenAI-compatible provider and stream a structured report entirely from
  the browser.
- The application remains useful with no AI configuration.
- Watchlists, settings, and reports survive reload locally and can be deleted.
- Tushare and Cron secrets never appear in browser bundles, logs, fixtures, or Git history.
- Cron is authenticated and preserves the last good snapshot on failure.
- Format, lint, typecheck, tests, build, browser tests, and production smoke checks pass.
- Git history preserves the staged implementation milestones.
- README documents setup, privacy, data provenance, limitations, deployment, and non-advice status.

## 18. Handoff to the next context

This document is the complete approved design. A new development context should:

1. Read this file and the repository `AGENTS.md`.
2. Verify no secrets are present.
3. Invoke the `writing-plans` workflow and create a detailed, test-first implementation plan.
4. Keep the plan aligned with the commit sequence in section 15.
5. Do not re-open already approved product decisions unless implementation evidence proves a
   conflict.
6. Implement in small commits and verify each milestone before continuing.

No application code exists at the design handoff point by intent.
