import type { Page, Request, Route } from '@playwright/test';

export const FIXTURE_STOCK = {
  code: '600519.SH',
  name: '贵州茅台',
  pinyinAbbreviation: 'GZMT',
} as const;

export const FIXTURE_CUTOFF = '2026-07-17';
export const FIXTURE_AI_BASE_URL = 'http://127.0.0.1:43119/v1';
export const FIXTURE_AI_ENDPOINT = `${FIXTURE_AI_BASE_URL}/chat/completions`;
export const FIXTURE_AI_MODEL = 'fixture-research-model';
export const FIXTURE_AI_KEY = 'browser-fixture-key-do-not-log';
export const MISSING_REVENUE_REASON = '当前报告期未披露营收增长';
export const MISSING_PE_REASON = '当前权限未返回市盈率';

export type MarketFixtureMode = 'fresh' | 'stale' | 'missing-financials';
export type AiFixtureMode = 'complete' | 'interrupted' | 'retry-once';

export interface FixtureRouteOptions {
  readonly market?: MarketFixtureMode;
  readonly ai?: AiFixtureMode;
}

export interface FixtureRequestRecord {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | undefined;
  readonly postData: string | null;
}

export interface FixtureProbe {
  readonly requests: readonly FixtureRequestRecord[];
  readonly consoleMessages: readonly string[];
  readonly consoleErrors: readonly string[];
  readonly pageErrors: readonly string[];
  aiAttempts(): number;
  requestsContaining(value: string): readonly FixtureRequestRecord[];
  apiRequestsWithAuthorization(): readonly FixtureRequestRecord[];
}

export async function installFixtureRoutes(
  page: Page,
  options: FixtureRouteOptions = {},
): Promise<FixtureProbe> {
  const marketMode = options.market ?? 'fresh';
  const aiMode = options.ai ?? 'complete';
  const requests: FixtureRequestRecord[] = [];
  const consoleMessages: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  let aiAttempts = 0;

  page.on('request', (request) => requests.push(recordRequest(request)));
  page.on('console', (message) => {
    consoleMessages.push(message.text());
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.route('**/api/stocks/search?*', (route) =>
    fulfillJson(route, marketEnvelope([FIXTURE_STOCK], marketMode)),
  );
  await page.route('**/api/stocks/600519.SH/overview?*', (route) =>
    fulfillJson(route, overviewEnvelope(marketMode)),
  );
  await page.route('**/api/stocks/600519.SH/history?*', (route) =>
    fulfillJson(route, historyEnvelope(marketMode)),
  );
  await page.route('**/api/stocks/600519.SH/fundamentals?*', (route) =>
    fulfillJson(route, fundamentalsEnvelope(marketMode)),
  );
  await page.route('**/api/market/status', (route) =>
    fulfillJson(route, marketStatusEnvelope(marketMode)),
  );
  await page.route(FIXTURE_AI_ENDPOINT, async (route) => {
    aiAttempts += 1;
    if (aiMode === 'retry-once' && aiAttempts === 1) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'fixture credential rejection' } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
        'content-type': 'text/event-stream; charset=utf-8',
      },
      body: aiMode === 'interrupted' ? interruptedAiStream() : completeAiStream(),
    });
  });

  return {
    requests,
    consoleMessages,
    consoleErrors,
    pageErrors,
    aiAttempts: () => aiAttempts,
    requestsContaining: (value) =>
      requests.filter(
        (request) =>
          request.url.includes(value) ||
          request.authorization?.includes(value) === true ||
          request.postData?.includes(value) === true,
      ),
    apiRequestsWithAuthorization: () =>
      requests.filter(
        (request) => request.url.includes('/api/') && request.authorization !== undefined,
      ),
  };
}

export async function waitForFixtureWorkspace(page: Page): Promise<void> {
  await page.getByRole('heading', { name: '贵州茅台量化研究' }).waitFor();
  await page.getByText('1,430.2').first().waitFor();
  await page.getByText(FIXTURE_CUTOFF, { exact: true }).first().waitFor();
}

export async function configureFixtureAi(page: Page, rememberKey = false): Promise<void> {
  await page.getByRole('tab', { name: 'AI 报告' }).click();
  await page.getByLabel('OpenAI-compatible Base URL').fill(FIXTURE_AI_BASE_URL);
  await page.getByLabel('模型标识符').fill(FIXTURE_AI_MODEL);
  await page.getByLabel('API key', { exact: true }).fill(FIXTURE_AI_KEY);
  if (rememberKey) {
    await page.getByLabel('在此设备上记住 API key').check();
  }
}

function recordRequest(request: Request): FixtureRequestRecord {
  return {
    url: request.url(),
    method: request.method(),
    authorization: request.headers()['authorization'],
    postData: request.postData(),
  };
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    headers: { 'cache-control': 'no-store' },
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function overviewEnvelope(mode: MarketFixtureMode) {
  const missingFinancials = mode === 'missing-financials';
  const peTtm = missingFinancials ? null : 24.6;
  return marketEnvelope(
    {
      code: FIXTURE_STOCK.code,
      name: FIXTURE_STOCK.name,
      date: FIXTURE_CUTOFF,
      close: 1430.2,
      previousClose: 1420,
      changePercent: 0.7183,
      peTtm,
      pb: 8.1,
      totalMarketValueCny: 1_796_000_000_000,
    },
    mode,
    {
      previousClose: available(1420),
      changePercent: available(0.7183),
      peTtm: peTtm === null ? missing(MISSING_PE_REASON) : available(peTtm),
      pb: available(8.1),
      totalMarketValueCny: available(1_796_000_000_000),
    },
    ['仅包含日线收盘数据', '估值参考序列在当前 fixture 中不可用'],
  );
}

function historyEnvelope(mode: MarketFixtureMode) {
  const rows = Array.from({ length: 80 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 3, 29 + index));
    const close = Number((1350 + index + Math.sin(index / 4) * 3).toFixed(2));
    const open = Number((close - 2.4).toFixed(2));
    return {
      code: FIXTURE_STOCK.code,
      date: date.toISOString().slice(0, 10),
      open,
      high: Number((close + 5).toFixed(2)),
      low: Number((open - 4).toFixed(2)),
      close,
      volumeShares: 2_600_000 + index * 10_000,
      turnoverCny: 3_700_000_000 + index * 8_000_000,
      adjustmentFactor: Number((1 + index / 10_000).toFixed(4)),
    };
  });
  const last = rows.at(-1);
  if (last === undefined) {
    throw new Error('History fixture requires a final row');
  }
  rows[rows.length - 1] = {
    ...last,
    date: FIXTURE_CUTOFF,
    open: 1425.8,
    high: 1438,
    low: 1418.2,
    close: 1430.2,
  };
  return marketEnvelope(rows, mode, { adjustmentFactor: available(1.0079) }, [
    '前复权日线 fixture，不代表实时行情',
  ]);
}

function fundamentalsEnvelope(mode: MarketFixtureMode) {
  const missingFinancials = mode === 'missing-financials';
  const revenueGrowth = missingFinancials ? null : 0.12;
  return marketEnvelope(
    {
      code: FIXTURE_STOCK.code,
      date: '2026-06-30',
      roe: 0.31,
      grossMargin: 0.91,
      revenueGrowth,
      profitGrowth: 0.16,
      operatingCashToNetProfit: 1.08,
      debtToAssets: 0.12,
    },
    mode,
    {
      roe: available(0.31),
      grossMargin: available(0.91),
      revenueGrowth:
        revenueGrowth === null ? missing(MISSING_REVENUE_REASON) : available(revenueGrowth),
      profitGrowth: available(0.16),
      operatingCashToNetProfit: available(1.08),
      debtToAssets: available(0.12),
    },
    ['财务数据按报告期披露'],
  );
}

function marketStatusEnvelope(mode: MarketFixtureMode) {
  const freshness = mode === 'stale' ? 'stale' : 'fresh';
  return {
    data: {
      asOf: FIXTURE_CUTOFF,
      lastSuccessfulAt: '2026-07-17T08:31:00.000Z',
      nextExpectedCloseAt: '2026-07-20T07:00:00.000Z',
      freshness,
    },
    asOf: FIXTURE_CUTOFF,
    source: 'Tushare Pro',
    freshness,
    availability: {},
    limitations: ['每日收盘后更新，不是实时行情'],
  };
}

function marketEnvelope(
  data: unknown,
  mode: MarketFixtureMode,
  availability: Readonly<Record<string, unknown>> = {},
  limitations: readonly string[] = ['固定浏览器测试数据'],
) {
  return {
    data,
    asOf: FIXTURE_CUTOFF,
    source: 'Tushare Pro',
    freshness: mode === 'stale' ? 'stale' : 'fresh',
    availability,
    limitations,
  };
}

function available(value: unknown) {
  return { status: 'available', value } as const;
}

function missing(reason: string) {
  return { status: 'missing', reason } as const;
}

function completeAiStream(): string {
  const chunks = [
    '## 数据摘要与截止日期\n贵州茅台数据截止 2026-07-17，来源为 Tushare Pro。\n\n## 技术结构与支持观察\nMA5、MA20 与 MA60 来自确定性日线计算。\n\n',
    '## 基本面、估值与财务质量\n报告仅复述经过校验的估值与财务指标，不补造缺失值。\n\n## 多空情景\n基准情景关注经营延续；其他情景仅作为研究假设。\n\n',
    '## 关键风险与失效条件\n历史数据延迟或基本面变化会使结论失效。\n\n## 缺失信息与待研究问题\n估值参考序列缺失，需要进一步研究。\n\n',
    '## 数据来源与限制\n来源为 Tushare Pro 日线收盘数据，仅供研究与教育使用，不构成投资建议。',
  ];
  return `${chunks.map(sseDelta).join('')}data: [DONE]\n\n`;
}

function interruptedAiStream(): string {
  return sseDelta(
    '## 数据摘要与截止日期\n贵州茅台数据截止 2026-07-17。\n\n## 技术结构与支持观察\n流式响应在本节后中断。',
  );
}

function sseDelta(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}
