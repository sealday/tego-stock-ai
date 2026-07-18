import { describe, expect, it, vi } from 'vitest';

import { createHealthHandler } from '../../api/health';
import { createFundamentalsHandler } from '../../api/stocks/[code]/fundamentals';
import { createHistoryHandler } from '../../api/stocks/[code]/history';
import { createOverviewHandler } from '../../api/stocks/[code]/overview';
import { createSearchHandler } from '../../api/stocks/search';
import { AppError, ERROR_CODES } from '../../src/domain/errors';
import type {
  MarketEnvelope,
  StockFundamentals,
  StockOverview,
  StockSearchResult,
} from '../../src/domain/stock';
import { isoDate, stockCode } from '../../src/domain/stock';
import { createTokenBucket } from '../../src/server/http';

const AS_OF = isoDate('2026-07-17');
const MOUTAI = stockCode('600519.SH');

const STOCKS: readonly StockSearchResult[] = [
  { code: stockCode('000001.SZ'), name: '平安银行', pinyinAbbreviation: 'PAYH' },
  { code: MOUTAI, name: '贵州茅台', pinyinAbbreviation: 'GZMT' },
  { code: stockCode('601318.SH'), name: '中国平安', pinyinAbbreviation: 'ZGPA' },
];

const OVERVIEW: StockOverview = {
  code: MOUTAI,
  name: '贵州茅台',
  date: AS_OF,
  close: 1430.2,
  previousClose: 1420,
  changePercent: 0.7183,
  peTtm: null,
  pb: 8.1,
  totalMarketValueCny: 1_796_000_000_000,
};

const FUNDAMENTALS: StockFundamentals = {
  code: MOUTAI,
  date: AS_OF,
  roe: 0.31,
  grossMargin: 0.91,
  revenueGrowth: null,
  profitGrowth: 0.16,
  operatingCashToNetProfit: 1.08,
  debtToAssets: 0.12,
};

function envelope<T>(data: T, availability = {}): MarketEnvelope<T> {
  return {
    data,
    asOf: AS_OF,
    source: 'Tushare Pro',
    freshness: 'fresh',
    availability,
    limitations: ['Daily-close data only'],
  };
}

function createAdapter(overrides: Record<string, unknown> = {}) {
  return {
    listStocks: vi.fn(async () => envelope(STOCKS)),
    getOverview: vi.fn(async () =>
      envelope(OVERVIEW, {
        peTtm: { status: 'missing' as const, reason: 'Provider field unavailable' },
      }),
    ),
    getHistory: vi.fn(async () => envelope([])),
    getFundamentals: vi.fn(async () =>
      envelope(FUNDAMENTALS, {
        revenueGrowth: { status: 'missing' as const, reason: 'Not reported for this period' },
      }),
    ),
    ...overrides,
  };
}

async function responseBody(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe('public stock API', () => {
  it('reports provider configuration without exposing the server token', async () => {
    const response = await createHealthHandler({
      environment: { TUSHARE_TOKEN: 'server-side-health-token' },
      now: () => new Date('2026-07-18T00:00:00.000Z'),
    })(new Request('https://stocks.example.com/api/health'));
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(serialized).toContain('providerConfigured');
    expect(serialized).toContain('true');
    expect(serialized).not.toContain('server-side-health-token');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it.each([
    ['600519', '600519.SH'],
    ['贵州', '600519.SH'],
    ['gzmt', '600519.SH'],
    ['平安银行', '000001.SZ'],
  ])(
    'matches trimmed search %s by code, Chinese name, or pinyin abbreviation',
    async (query, code) => {
      const adapter = createAdapter();
      const handler = createSearchHandler({ adapter });

      const response = await handler(
        new Request(
          `https://stocks.example.com/api/stocks/search?q=${encodeURIComponent(`  ${query}  `)}`,
        ),
      );
      const body = await responseBody(response);

      expect(response.status).toBe(200);
      expect((body.data as Array<{ code: string }>).map((stock) => stock.code)).toContain(code);
      expect(adapter.listStocks).toHaveBeenCalledOnce();
    },
  );

  it('caps search output at 50 canonical results', async () => {
    const stocks = Array.from({ length: 60 }, (_, index) => ({
      code: stockCode(`${String(600_000 + index).padStart(6, '0')}.SH`),
      name: `测试公司${index}`,
      pinyinAbbreviation: `CSGS${index}`,
    }));
    const handler = createSearchHandler({
      adapter: createAdapter({ listStocks: vi.fn(async () => envelope(stocks)) }),
    });

    const response = await handler(
      new Request('https://stocks.example.com/api/stocks/search?q=%E6%B5%8B%E8%AF%95&limit=500'),
    );
    const body = await responseBody(response);

    expect(body.data as unknown[]).toHaveLength(50);
  });

  it('rejects an empty search after trimming with a typed safe error', async () => {
    const response = await createSearchHandler({ adapter: createAdapter() })(
      new Request('https://stocks.example.com/api/stocks/search?q=%20%20'),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INVALID_INPUT', retryable: false },
    });
  });

  it('accepts an exact ten-year forward-adjusted history range', async () => {
    const adapter = createAdapter();
    const handler = createHistoryHandler({ adapter });

    const response = await handler(
      new Request(
        'https://stocks.example.com/api/stocks/600519.SH/history?start=2016-07-17&end=2026-07-17&adjust=forward',
      ),
    );

    expect(response.status).toBe(200);
    expect(adapter.getHistory).toHaveBeenCalledWith({
      code: MOUTAI,
      start: isoDate('2016-07-17'),
      end: AS_OF,
      adjust: 'forward',
    });
  });

  it('accepts a valid short history range near the upper supported date bound', async () => {
    const adapter = createAdapter();
    const response = await createHistoryHandler({ adapter })(
      new Request(
        'https://stocks.example.com/api/stocks/600519.SH/history?start=2091-01-01&end=2100-12-31&adjust=forward',
      ),
    );

    expect(response.status).toBe(200);
    expect(adapter.getHistory).toHaveBeenCalledWith({
      code: MOUTAI,
      start: isoDate('2091-01-01'),
      end: isoDate('2100-12-31'),
      adjust: 'forward',
    });
  });

  it.each([
    ['2020-02-29', '2030-02-28', 200],
    ['2020-02-29', '2030-03-01', 400],
    ['2090-01-01', '2100-01-02', 400],
  ])('applies the ten-year boundary from %s through %s', async (start, end, status) => {
    const response = await createHistoryHandler({ adapter: createAdapter() })(
      new Request(
        `https://stocks.example.com/api/stocks/600519.SH/history?start=${start}&end=${end}&adjust=forward`,
      ),
    );

    expect(response.status).toBe(status);
    if (status === 400) {
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'INVALID_INPUT' } });
    }
  });

  it.each([
    'start=2016-07-16&end=2026-07-17&adjust=forward',
    'start=2026-07-01&end=2026-07-17&adjust=backward',
    'start=2026-07-01%3Ftoken%3Dx&end=2026-07-17&adjust=forward',
  ])('rejects an unsafe history query: %s', async (query) => {
    const response = await createHistoryHandler({ adapter: createAdapter() })(
      new Request(`https://stocks.example.com/api/stocks/600519.SH/history?${query}`),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'INVALID_INPUT' } });
  });

  it('exhausts and refills a per-IP token bucket', async () => {
    let now = 1_000;
    const rateLimiter = createTokenBucket({
      capacity: 2,
      refillTokens: 1,
      refillIntervalMs: 1_000,
      now: () => now,
    });
    const handler = createSearchHandler({ adapter: createAdapter(), rateLimiter });
    const request = () =>
      new Request('https://stocks.example.com/api/stocks/search?q=600519', {
        headers: { 'x-forwarded-for': '203.0.113.8' },
      });

    expect((await handler(request())).status).toBe(200);
    expect((await handler(request())).status).toBe(200);
    const exhausted = await handler(request());
    expect(exhausted.status).toBe(429);
    await expect(exhausted.json()).resolves.toMatchObject({ error: { code: 'RATE_LIMITED' } });

    now += 1_000;
    expect((await handler(request())).status).toBe(200);
  });

  it('evicts idle token buckets before their normal refill interval', () => {
    let now = 0;
    const rateLimiter = createTokenBucket({
      capacity: 1,
      refillTokens: 1,
      refillIntervalMs: 100_000,
      idleTtlMs: 1_000,
      maxBuckets: 10,
      now: () => now,
    });

    expect(rateLimiter.consume('198.51.100.1').allowed).toBe(true);
    expect(rateLimiter.consume('198.51.100.1').allowed).toBe(false);

    now = 1_001;
    expect(rateLimiter.consume('198.51.100.2').allowed).toBe(true);
    expect(rateLimiter.consume('198.51.100.1').allowed).toBe(true);
  });

  it('evicts the least recently used bucket when the hard cap is reached', () => {
    let now = 0;
    const rateLimiter = createTokenBucket({
      capacity: 1,
      refillTokens: 1,
      refillIntervalMs: 100_000,
      idleTtlMs: 100_000,
      maxBuckets: 2,
      now: () => now,
    });

    expect(rateLimiter.consume('198.51.100.1').allowed).toBe(true);
    now = 1;
    expect(rateLimiter.consume('198.51.100.2').allowed).toBe(true);
    now = 2;
    expect(rateLimiter.consume('198.51.100.1').allowed).toBe(false);
    now = 3;
    expect(rateLimiter.consume('198.51.100.3').allowed).toBe(true);
    expect(rateLimiter.consume('198.51.100.2').allowed).toBe(true);
  });

  it('preserves field-level missing-data reasons in a successful overview', async () => {
    const response = await createOverviewHandler({ adapter: createAdapter() })(
      new Request('https://stocks.example.com/api/stocks/600519.SH/overview?asOf=2026-07-17'),
    );
    const body = await responseBody(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      data: { code: '600519.SH', peTtm: null },
      availability: {
        peTtm: { status: 'missing', reason: 'Provider field unavailable' },
      },
    });
  });

  it('preserves field-level missing-data reasons in fundamentals', async () => {
    const response = await createFundamentalsHandler({ adapter: createAdapter() })(
      new Request('https://stocks.example.com/api/stocks/600519.SH/fundamentals?asOf=2026-07-17'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { revenueGrowth: null },
      availability: {
        revenueGrowth: { status: 'missing', reason: 'Not reported for this period' },
      },
    });
  });

  it('maps provider permission failures without exposing authorization or upstream bodies', async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const adapter = createAdapter({
      listStocks: vi.fn(async () => {
        throw new AppError('PROVIDER_PERMISSION', 'Market data access is not permitted', {
          status: 502,
          retryable: false,
          providerCode: '-2001',
          cause: new Error('Bearer secret-value; upstream body: permission details'),
        });
      }),
    });
    const handler = createSearchHandler({
      adapter,
      logger,
      requestIdFactory: () => 'request-safe-id',
    });

    const response = await handler(
      new Request('https://stocks.example.com/api/stocks/search?q=600519', {
        headers: { authorization: 'Bearer browser-secret' },
      }),
    );
    const serialized = JSON.stringify({
      body: await response.json(),
      logs: logger.error.mock.calls,
    });

    expect(response.status).toBe(502);
    expect(serialized).toContain('request-safe-id');
    expect(serialized).toContain('-2001');
    expect(serialized).not.toContain('browser-secret');
    expect(serialized).not.toContain('secret-value');
    expect(serialized).not.toContain('upstream body');
  });

  it('maps provider timeouts to a retryable unavailable error', async () => {
    const adapter = createAdapter({
      getOverview: vi.fn(async () => {
        throw new DOMException('timed out while reading upstream body', 'TimeoutError');
      }),
    });
    const response = await createOverviewHandler({ adapter })(
      new Request('https://stocks.example.com/api/stocks/600519.SH/overview'),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PROVIDER_UNAVAILABLE', retryable: true },
    });
  });

  it('returns restrictive CORS and payload-appropriate cache headers', async () => {
    const handler = createSearchHandler({
      adapter: createAdapter(),
      allowedOrigins: ['https://stocks.example.com'],
    });
    const response = await handler(
      new Request('https://api.example.com/api/stocks/search?q=600519', {
        headers: { origin: 'https://stocks.example.com' },
      }),
    );

    expect(response.headers.get('access-control-allow-origin')).toBe('https://stocks.example.com');
    expect(response.headers.get('vary')).toContain('Origin');
    expect(response.headers.get('cache-control')).toContain('s-maxage=86400');
    expect(response.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('does not authorize an unlisted production origin', async () => {
    const response = await createSearchHandler({
      adapter: createAdapter(),
      allowedOrigins: ['https://stocks.example.com'],
    })(
      new Request('https://api.example.com/api/stocks/search?q=600519', {
        headers: { origin: 'https://untrusted.example' },
      }),
    );

    expect(response.headers.has('access-control-allow-origin')).toBe(false);
  });

  it('keeps the application error taxonomy stable and closed', () => {
    expect(ERROR_CODES).toEqual([
      'INVALID_INPUT',
      'NOT_FOUND',
      'RATE_LIMITED',
      'PROVIDER_PERMISSION',
      'PROVIDER_RATE_LIMIT',
      'PROVIDER_UNAVAILABLE',
      'INTERNAL_ERROR',
    ]);
  });
});
