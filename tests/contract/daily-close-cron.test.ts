import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { createDailyCloseCronHandler } from '../../api/cron/daily-close';
import { createMarketStatusHandler } from '../../api/market/status';
import { AppError } from '../../src/domain/errors';
import {
  isoDate,
  stockCode,
  type DailyMarketSnapshot,
  type DailyPrice,
  type StockSearchResult,
  type TradingCalendarDay,
} from '../../src/domain/stock';
import {
  MARKET_SNAPSHOT_KEY,
  type SafeSnapshotFailure,
  type SnapshotStore,
} from '../../src/server/cache';
import {
  createTushareMarketSnapshotSource,
  type MarketSnapshotSource,
} from '../../src/server/market-snapshot';
import type { TushareClient, TushareQuery } from '../../src/server/tushare/client';

const CRON_SECRET = 'cron-test-secret';
const FRIDAY = isoDate('2026-07-17');
const MOUTAI = stockCode('600519.SH');
const STOCK_DIRECTORY: readonly StockSearchResult[] = [
  { code: MOUTAI, name: '贵州茅台', pinyinAbbreviation: 'GZMT' },
];
const TRADING_CALENDAR: readonly TradingCalendarDay[] = [
  { date: FRIDAY, isOpen: true },
  { date: isoDate('2026-07-18'), isOpen: false },
  { date: isoDate('2026-07-19'), isOpen: false },
  { date: isoDate('2026-07-20'), isOpen: true },
];
const DAILY_CLOSE: readonly DailyPrice[] = [
  {
    code: MOUTAI,
    date: FRIDAY,
    open: 1421.5,
    high: 1438,
    low: 1412.01,
    close: 1430.2,
    volumeShares: 3_210_000,
    turnoverCny: 4_580_000_000,
    adjustmentFactor: null,
  },
];

class MemorySnapshotStore implements SnapshotStore {
  readonly failures: SafeSnapshotFailure[] = [];
  private readonly values = new Map<string, unknown>();

  async read<T>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null;
  }

  async writeAtomically<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async recordFailure(_key: string, safeError: SafeSnapshotFailure): Promise<void> {
    this.failures.push(safeError);
  }
}

function source(overrides: Partial<MarketSnapshotSource> = {}): MarketSnapshotSource {
  return {
    loadStockDirectory: vi.fn(async () => STOCK_DIRECTORY),
    loadTradingCalendar: vi.fn(async () => TRADING_CALENDAR),
    loadDailyClose: vi.fn(async () => DAILY_CLOSE),
    ...overrides,
  };
}

function cronRequest(authorization?: string): Request {
  return new Request('https://stocks.example.com/api/cron/daily-close', {
    headers: authorization === undefined ? {} : { authorization },
  });
}

const quietLogger = { info: vi.fn(), error: vi.fn() };

describe('daily-close Cron route', () => {
  it.each([undefined, 'Bearer wrong-secret', CRON_SECRET, 'Basic cron-test-secret'])(
    'rejects a missing or mismatched authorization header: %s',
    async (authorization) => {
      const marketSource = source();
      const response = await createDailyCloseCronHandler({
        environment: { CRON_SECRET },
        source: marketSource,
        store: new MemorySnapshotStore(),
        logger: quietLogger,
      })(cronRequest(authorization));

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toMatchObject({
        error: { retryable: false },
      });
      expect(marketSource.loadStockDirectory).not.toHaveBeenCalled();
      expect(JSON.stringify(body)).not.toContain(CRON_SECRET);
    },
  );

  it('returns a safe 503 when the server Cron secret is absent', async () => {
    const response = await createDailyCloseCronHandler({
      environment: {},
      source: source(),
      store: new MemorySnapshotStore(),
      logger: quietLogger,
    })(cronRequest('Bearer anything'));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INTERNAL_ERROR', retryable: true },
    });
  });

  it('refreshes directory, calendar, and all-market daily close as one snapshot', async () => {
    const store = new MemorySnapshotStore();
    const marketSource = source();
    const response = await createDailyCloseCronHandler({
      environment: { CRON_SECRET },
      source: marketSource,
      store,
      now: () => new Date('2026-07-17T08:30:00.000Z'),
      logger: quietLogger,
    })(cronRequest(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        asOf: '2026-07-17',
        lastSuccessfulAt: '2026-07-17T08:30:00.000Z',
        freshness: 'fresh',
      },
      asOf: '2026-07-17',
      freshness: 'fresh',
    });
    expect(marketSource.loadStockDirectory).toHaveBeenCalledOnce();
    expect(marketSource.loadTradingCalendar).toHaveBeenCalledOnce();
    expect(marketSource.loadDailyClose).toHaveBeenCalledWith({ date: FRIDAY });
    await expect(store.read<DailyMarketSnapshot>(MARKET_SNAPSHOT_KEY)).resolves.toMatchObject({
      stockDirectory: STOCK_DIRECTORY,
      tradingCalendar: TRADING_CALENDAR,
      dailyClose: DAILY_CLOSE,
    });
  });

  it('returns 502 for a provider failure while preserving the last-good snapshot', async () => {
    const store = new MemorySnapshotStore();
    const successHandler = createDailyCloseCronHandler({
      environment: { CRON_SECRET },
      source: source(),
      store,
      now: () => new Date('2026-07-17T08:30:00.000Z'),
      logger: quietLogger,
    });
    expect((await successHandler(cronRequest(`Bearer ${CRON_SECRET}`))).status).toBe(200);
    const prior = await store.read<DailyMarketSnapshot>(MARKET_SNAPSHOT_KEY);
    const failure = new AppError('PROVIDER_UNAVAILABLE', 'unsafe upstream details', {
      status: 503,
      retryable: true,
      providerCode: 'TIMEOUT',
    });
    const failingHandler = createDailyCloseCronHandler({
      environment: { CRON_SECRET },
      source: source({ loadDailyClose: vi.fn(async () => Promise.reject(failure)) }),
      store,
      now: () => new Date('2026-07-17T08:45:00.000Z'),
      logger: quietLogger,
    });

    const response = await failingHandler(cronRequest(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toMatchObject({
      error: { code: 'PROVIDER_UNAVAILABLE', retryable: true },
    });
    await expect(store.read(MARKET_SNAPSHOT_KEY)).resolves.toEqual(prior);
    expect(store.failures).toEqual([
      {
        code: 'PROVIDER_UNAVAILABLE',
        message: 'Market data provider is unavailable',
        retryable: true,
        occurredAt: '2026-07-17T08:45:00.000Z',
      },
    ]);
    expect(JSON.stringify({ body, failures: store.failures })).not.toContain(
      'unsafe upstream details',
    );
  });
});

describe('market status route', () => {
  it('exposes the last successful cutoff and stale freshness', async () => {
    const store = new MemorySnapshotStore();
    await createDailyCloseCronHandler({
      environment: { CRON_SECRET },
      source: source(),
      store,
      now: () => new Date('2026-07-17T08:30:00.000Z'),
      logger: quietLogger,
    })(cronRequest(`Bearer ${CRON_SECRET}`));

    const response = await createMarketStatusHandler({
      store,
      now: () => new Date('2026-07-20T07:00:00.001Z'),
      logger: quietLogger,
    })(new Request('https://stocks.example.com/api/market/status'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        asOf: '2026-07-17',
        lastSuccessfulAt: '2026-07-17T08:30:00.000Z',
        nextExpectedCloseAt: '2026-07-20T07:00:00.000Z',
        freshness: 'stale',
      },
      asOf: '2026-07-17',
      freshness: 'stale',
    });
  });

  it('returns a retryable no-data error when no last-good snapshot exists', async () => {
    const response = await createMarketStatusHandler({
      store: new MemorySnapshotStore(),
      logger: quietLogger,
    })(new Request('https://stocks.example.com/api/market/status'));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PROVIDER_UNAVAILABLE', retryable: true },
    });
  });
});

describe('production snapshot source', () => {
  it('validates and normalizes provider rows before returning all-market close data', async () => {
    const queries: TushareQuery[] = [];
    const client: TushareClient = {
      query: vi.fn(async (query) => {
        queries.push(query);
        if (query.apiName === 'stock_basic') {
          return {
            fields: ['ts_code', 'name', 'cnspell', 'list_status'],
            items: [['600519.SH', '贵州茅台', 'gzmt', 'L']],
          };
        }
        if (query.apiName === 'trade_cal') {
          return {
            fields: ['cal_date', 'is_open'],
            items: [
              ['20260717', '1'],
              ['20260718', '0'],
              ['20260720', '1'],
            ],
          };
        }
        return {
          fields: ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'vol', 'amount'],
          items: [['600519.SH', '20260717', 1421.5, 1438, 1412.01, 1430.2, 32100, 4580000]],
        };
      }),
    };
    const marketSource = createTushareMarketSnapshotSource(client);

    await expect(marketSource.loadStockDirectory()).resolves.toEqual(STOCK_DIRECTORY);
    await expect(
      marketSource.loadTradingCalendar({
        start: isoDate('2026-07-17'),
        end: isoDate('2026-07-20'),
      }),
    ).resolves.toEqual([
      { date: isoDate('2026-07-17'), isOpen: true },
      { date: isoDate('2026-07-18'), isOpen: false },
      { date: isoDate('2026-07-20'), isOpen: true },
    ]);
    await expect(marketSource.loadDailyClose({ date: FRIDAY })).resolves.toEqual(DAILY_CLOSE);

    const dailyQuery = queries.find((query) => query.apiName === 'daily');
    expect(dailyQuery?.params).toEqual({ trade_date: '20260717' });
    expect(JSON.stringify(await marketSource.loadDailyClose({ date: FRIDAY }))).not.toContain(
      'ts_code',
    );
  });
});

describe('Vercel Cron configuration', () => {
  it('runs on weekday UTC time after the mainland market close', async () => {
    const configuration = JSON.parse(await readFile('vercel.json', 'utf8')) as {
      crons?: Array<{ path: string; schedule: string }>;
    };

    expect(configuration.crons).toContainEqual({
      path: '/api/cron/daily-close',
      schedule: '30 8 * * 1-5',
    });
  });
});
