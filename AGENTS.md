# tego-stock-ai development contract

Read `docs/superpowers/specs/2026-07-18-tego-stock-ai-design.md` before planning or
implementation. It is the approved product and architecture source of truth.

## Current phase

The product design is approved. The next task is to create a detailed implementation plan with the
`writing-plans` workflow before scaffolding application code.

## Non-negotiable decisions

- React + TypeScript + Vite, deployed on Vercel.
- Dark, high-information-density quantitative-terminal interface.
- Tushare Pro is the A-share data source.
- Tushare credentials stay in Vercel server-side environment variables.
- Vercel Functions provide the thin data gateway; Vercel Cron refreshes daily-close metadata and
  snapshots.
- AI requests run in the user's browser with the user's OpenAI-compatible API key.
- There is no account system or cloud synchronization in v1.
- User settings, watchlists, and reports are local-only.
- v1 covers historical/daily-close market data, technical analysis, valuation, and fundamentals.
- News, sentiment, real-time quotes, and deterministic buy/sell instructions are out of scope.

## Engineering conventions inherited from tego-sheet

- Use npm and commit the lockfile. Pin direct dependencies to exact versions.
- Support Node.js `>=20.19.0`; run primary CI on Node.js 24.
- Use Oxlint for linting and Oxfmt for formatting. Do not add ESLint or Prettier.
- Formatting baseline: single quotes and print width 100.
- Lint with `oxlint --deny-warnings .`; format checks must be non-mutating in CI.
- Use strict TypeScript. Do not use `any` or suppress errors without a documented reason.
- Use Vitest for unit/component/contract tests and Playwright for browser/e2e/visual tests.
- Use Conventional Commits enforced by Commitlint and Husky.
- Husky `pre-commit` runs `npm run format:check && npm run lint`.
- Husky `commit-msg` runs `commitlint --edit`.
- CI must check commit policy, formatting, lint, types, tests, build, and browser smoke coverage.
- Pin GitHub Actions by full commit SHA.
- Keep modules focused and interfaces explicit; prefer deterministic pure functions for finance
  calculations.

## Commit policy

Do not collapse implementation into one commit. Follow the staged commit plan in the approved
design. Every commit must be independently understandable and use a Conventional Commit header.
Where meaningful, add decision-record trailers:

```text
<type>(<scope>): <intent>

Constraint: <external constraint>
Rejected: <alternative> | <reason>
Confidence: <low|medium|high>
Scope-risk: <narrow|moderate|broad>
Directive: <warning for future work>
Tested: <verification performed>
Not-tested: <known gap>
```

Never commit API keys, access tokens, `.env` files, Vercel project metadata, generated reports, or
production data dumps.

