import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { test as base, type Page, type Request, type Route } from '@playwright/test';

export const FIXTURE_STOCK = {
  code: '600519.SH',
  name: '贵州茅台',
  pinyinAbbreviation: 'GZMT',
} as const;

export const FIXTURE_CUTOFF = '2026-07-17';
export const FIXTURE_AI_MODEL = 'fixture-research-model';
export const FIXTURE_AI_KEY = 'browser-fixture-key-do-not-log';
export const MISSING_REVENUE_REASON = '当前报告期未披露营收增长';
export const MISSING_PE_REASON = '当前权限未返回市盈率';

const STREAM_STEP_DELAY_MS = 300;

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
  readonly headers: Readonly<Record<string, string>>;
  readonly postData: string | null;
}

export interface FixtureProbe {
  readonly previewOrigin: string;
  readonly aiBaseUrl: string;
  readonly aiEndpoint: string;
  readonly consoleMessages: readonly string[];
  readonly consoleErrors: readonly string[];
  readonly pageErrors: readonly string[];
  aiAttempts(): number;
  aiRequests(): readonly FixtureRequestRecord[];
  browserRequests(): Promise<readonly FixtureRequestRecord[]>;
  marketApiRequestCount(): Promise<number>;
  apiRequestsWithAuthorization(): Promise<readonly FixtureRequestRecord[]>;
}

interface ManagedFixtureProbe extends FixtureProbe {
  close(): Promise<void>;
}

interface BrowserFixtures {
  installFixtureRoutes(options?: FixtureRouteOptions): Promise<FixtureProbe>;
}

export const test = base.extend<BrowserFixtures>({
  installFixtureRoutes: async ({ page, baseURL }, provide) => {
    if (baseURL === undefined) {
      throw new Error('Browser fixture routes require a configured Playwright baseURL');
    }
    const previewOrigin = new URL(baseURL).origin;
    const activeFixtures: ManagedFixtureProbe[] = [];
    try {
      await provide(async (options = {}) => {
        const fixture = await createFixtureRoutes(page, previewOrigin, options);
        activeFixtures.push(fixture);
        return fixture;
      });
    } finally {
      await Promise.all(activeFixtures.map(async (fixture) => fixture.close()));
    }
  },
});

async function createFixtureRoutes(
  page: Page,
  previewOrigin: string,
  options: FixtureRouteOptions = {},
): Promise<ManagedFixtureProbe> {
  const marketMode = options.market ?? 'fresh';
  const aiMode = options.ai ?? 'complete';
  const requestRecords: Promise<FixtureRequestRecord>[] = [];
  const consoleMessages: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const aiServer = await startAiFixtureServer(aiMode, previewOrigin);

  page.on('request', (request) => {
    const record = recordRequest(request);
    requestRecords.push(record);
    void record.catch(() => undefined);
  });
  page.on('console', (message) => {
    consoleMessages.push(message.text());
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    await installMarketFixtureRoutes(page, previewOrigin, marketMode);
  } catch (error: unknown) {
    await aiServer.close();
    throw error;
  }

  return {
    previewOrigin,
    aiBaseUrl: aiServer.baseUrl,
    aiEndpoint: aiServer.endpoint,
    consoleMessages,
    consoleErrors,
    pageErrors,
    aiAttempts: () => aiServer.attempts(),
    aiRequests: () => aiServer.requests,
    browserRequests: async () => Promise.all(requestRecords),
    marketApiRequestCount: async () =>
      (await Promise.all(requestRecords)).filter((request) =>
        request.url.startsWith(`${previewOrigin}/api/`),
      ).length,
    apiRequestsWithAuthorization: async () =>
      (await Promise.all(requestRecords)).filter(
        (request) =>
          request.url.startsWith(`${previewOrigin}/api/`) && request.authorization !== undefined,
      ),
    close: async () => {
      try {
        await Promise.all(requestRecords);
      } finally {
        await aiServer.close();
      }
    },
  };
}

async function installMarketFixtureRoutes(
  page: Page,
  previewOrigin: string,
  marketMode: MarketFixtureMode,
): Promise<void> {
  const escapedOrigin = escapeRegExp(previewOrigin);
  await page.route(new RegExp(`^${escapedOrigin}/api/stocks/search\\?.+$`), (route) =>
    fulfillJson(route, marketEnvelope([FIXTURE_STOCK], marketMode)),
  );
  await page.route(
    new RegExp(`^${escapedOrigin}/api/stocks/600519\\.SH/overview(?:\\?.*)?$`),
    (route) => fulfillJson(route, overviewEnvelope(marketMode)),
  );
  await page.route(
    new RegExp(`^${escapedOrigin}/api/stocks/600519\\.SH/history(?:\\?.*)?$`),
    (route) => fulfillJson(route, historyEnvelope(marketMode)),
  );
  await page.route(
    new RegExp(`^${escapedOrigin}/api/stocks/600519\\.SH/fundamentals(?:\\?.*)?$`),
    (route) => fulfillJson(route, fundamentalsEnvelope(marketMode)),
  );
  await page.route(new RegExp(`^${escapedOrigin}/api/market/status(?:\\?.*)?$`), (route) =>
    fulfillJson(route, marketStatusEnvelope(marketMode)),
  );
}

export async function waitForFixtureWorkspace(page: Page): Promise<void> {
  await page.getByRole('heading', { name: '贵州茅台量化研究' }).waitFor();
  await page.getByText('1,430.2').first().waitFor();
  await page.getByText(FIXTURE_CUTOFF, { exact: true }).first().waitFor();
}

export async function configureFixtureAi(
  page: Page,
  probe: FixtureProbe,
  rememberKey = false,
): Promise<void> {
  await page.getByRole('tab', { name: 'AI 报告' }).click();
  await page.getByLabel('OpenAI-compatible Base URL').fill(probe.aiBaseUrl);
  await page.getByLabel('模型标识符').fill(FIXTURE_AI_MODEL);
  await page.getByLabel('API key', { exact: true }).fill(FIXTURE_AI_KEY);
  if (rememberKey) {
    await page.getByLabel('在此设备上记住 API key').check();
  }
}

interface AiServerFixture {
  readonly baseUrl: string;
  readonly endpoint: string;
  readonly requests: readonly FixtureRequestRecord[];
  attempts(): number;
  close(): Promise<void>;
}

async function startAiFixtureServer(
  mode: AiFixtureMode,
  previewOrigin: string,
): Promise<AiServerFixture> {
  const requests: FixtureRequestRecord[] = [];
  const streamAbort = new AbortController();
  let attempts = 0;
  let origin = '';

  const server = createServer((request, response) => {
    void handleAiFixtureRequest({
      request,
      response,
      mode,
      origin,
      previewOrigin,
      requests,
      signal: streamAbort.signal,
      nextAttempt: () => {
        attempts += 1;
        return attempts;
      },
    }).catch((error: unknown) => {
      const cause = error instanceof Error ? error : new Error('Unknown AI fixture server error');
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('AI fixture server failed');
        return;
      }
      response.destroy(cause);
    });
  });

  await listenOnEphemeralPort(server);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('AI fixture server did not expose a TCP address');
  }
  origin = `http://127.0.0.1:${address.port}`;
  const baseUrl = `${origin}/v1`;

  return {
    baseUrl,
    endpoint: `${baseUrl}/chat/completions`,
    requests,
    attempts: () => attempts,
    close: async () => {
      streamAbort.abort();
      await closeServer(server);
    },
  };
}

async function handleAiFixtureRequest({
  request,
  response,
  mode,
  origin,
  previewOrigin,
  requests,
  signal,
  nextAttempt,
}: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly mode: AiFixtureMode;
  readonly origin: string;
  readonly previewOrigin: string;
  readonly requests: FixtureRequestRecord[];
  readonly signal: AbortSignal;
  readonly nextAttempt: () => number;
}): Promise<void> {
  const requestUrl = new URL(request.url ?? '/', origin);
  const postData = await readRequestBody(request);
  requests.push({
    url: requestUrl.toString(),
    method: request.method ?? 'UNKNOWN',
    authorization: firstHeader(request.headers.authorization),
    headers: normalizeNodeHeaders(request),
    postData: postData.length === 0 ? null : postData,
  });

  if (request.headers.origin !== previewOrigin) {
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Unexpected browser origin');
    return;
  }

  const corsHeaders = {
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'OPTIONS, POST',
    'access-control-allow-origin': previewOrigin,
    vary: 'Origin',
  } as const;

  if (request.method === 'OPTIONS') {
    response.writeHead(204, corsHeaders);
    response.end();
    return;
  }

  if (request.method !== 'POST' || requestUrl.pathname !== '/v1/chat/completions') {
    response.writeHead(404, { ...corsHeaders, 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  if (firstHeader(request.headers.authorization) !== `Bearer ${FIXTURE_AI_KEY}`) {
    rejectAiFixtureRequest(response, corsHeaders, 401, 'invalid-authorization');
    return;
  }
  if (
    firstHeader(request.headers['content-type'])?.split(';', 1)[0]?.trim() !== 'application/json'
  ) {
    rejectAiFixtureRequest(response, corsHeaders, 415, 'invalid-content-type');
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(postData);
  } catch {
    rejectAiFixtureRequest(response, corsHeaders, 400, 'invalid-json');
    return;
  }
  if (!isValidAiFixtureBody(body)) {
    rejectAiFixtureRequest(response, corsHeaders, 422, 'invalid-request');
    return;
  }

  const attempt = nextAttempt();
  if (mode === 'retry-once' && attempt === 1) {
    response.writeHead(200, {
      ...corsHeaders,
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify({ error: { message: 'fixture credential rejection' } }));
    return;
  }

  response.writeHead(200, {
    ...corsHeaders,
    'cache-control': 'no-store',
    'content-type': 'text/event-stream; charset=utf-8',
  });
  response.flushHeaders();

  const chunks = mode === 'interrupted' ? interruptedAiChunks() : completeAiChunks();
  for (const chunk of chunks) {
    if (response.destroyed) {
      return;
    }
    response.write(sseDelta(chunk));
    try {
      await delay(STREAM_STEP_DELAY_MS, undefined, { signal });
    } catch (error: unknown) {
      if (signal.aborted) {
        return;
      }
      throw error;
    }
  }
  if (mode !== 'interrupted' && !response.destroyed) {
    response.write('data: [DONE]\n\n');
  }
  response.end();
}

function rejectAiFixtureRequest(
  response: ServerResponse,
  corsHeaders: Readonly<Record<string, string>>,
  status: number,
  error: string,
): void {
  response.writeHead(status, {
    ...corsHeaders,
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify({ error }));
}

function isValidAiFixtureBody(value: unknown): boolean {
  if (!isRecord(value) || value.model !== FIXTURE_AI_MODEL || value.stream !== true) {
    return false;
  }
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    return false;
  }

  const content: string[] = [];
  for (const message of value.messages) {
    if (
      !isRecord(message) ||
      !isMessageRole(message.role) ||
      typeof message.content !== 'string' ||
      message.content.trim().length === 0
    ) {
      return false;
    }
    content.push(message.content);
  }

  const context = content.join('\n');
  return ['600519.SH', FIXTURE_CUTOFF, 'Tushare'].every((marker) => context.includes(marker));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMessageRole(value: unknown): value is 'system' | 'user' | 'assistant' {
  return value === 'system' || value === 'user' || value === 'assistant';
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' || value === undefined ? value : value[0];
}

function normalizeNodeHeaders(request: IncomingMessage): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(request.headers).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]],
    ),
  );
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function listenOnEphemeralPort(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
    server.closeAllConnections();
  });
}

async function recordRequest(request: Request): Promise<FixtureRequestRecord> {
  const [headers, authorization] = await Promise.all([
    request.allHeaders(),
    request.headerValue('authorization'),
  ]);
  return {
    url: request.url(),
    method: request.method(),
    authorization: authorization ?? undefined,
    headers,
    postData: request.postData(),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function completeAiChunks(): readonly string[] {
  return [
    '## 数据摘要与截止日期\n贵州茅台数据截止 2026-07-17，来源为 Tushare Pro。\n\n## 技术结构与支持观察\nMA5、MA20 与 MA60 来自确定性日线计算。\n\n',
    '## 基本面、估值与财务质量\n报告仅复述经过校验的估值与财务指标，不补造缺失值。\n\n## 多空情景\n基准情景关注经营延续；其他情景仅作为研究假设。\n\n',
    '## 关键风险与失效条件\n历史数据延迟或基本面变化会使结论失效。\n\n## 缺失信息与待研究问题\n估值参考序列缺失，需要进一步研究。\n\n',
    '## 数据来源与限制\n来源为 Tushare Pro 日线收盘数据，仅供研究与教育使用，不构成投资建议。',
  ];
}

function interruptedAiChunks(): readonly string[] {
  return [
    '## 数据摘要与截止日期\n贵州茅台数据截止 2026-07-17。\n\n',
    '## 技术结构与支持观察\n流式响应在本节后中断。',
  ];
}

function sseDelta(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}
