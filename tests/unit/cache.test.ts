import { BlobPreconditionFailedError } from '@vercel/blob';
import { describe, expect, it, vi } from 'vitest';

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
  readMarketSnapshot,
  refreshMarketSnapshot,
  type MarketSnapshotSource,
} from '../../src/server/market-snapshot';
import {
  createBlobSnapshotStore,
  type SnapshotBlobClient,
} from '../../src/server/blob-snapshot-store';

const FRIDAY = isoDate('2026-07-17');
const THURSDAY = isoDate('2026-07-16');
const MONDAY = isoDate('2026-07-20');
const MOUTAI = stockCode('600519.SH');
const PING_AN = stockCode('000001.SZ');

const STOCK_DIRECTORY: readonly StockSearchResult[] = [
  { code: MOUTAI, name: '贵州茅台', pinyinAbbreviation: 'GZMT' },
];

const TRADING_CALENDAR: readonly TradingCalendarDay[] = [
  { date: FRIDAY, isOpen: true },
  { date: isoDate('2026-07-18'), isOpen: false },
  { date: isoDate('2026-07-19'), isOpen: false },
  { date: MONDAY, isOpen: true },
  { date: isoDate('2026-07-21'), isOpen: true },
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

function expectedSnapshot(): DailyMarketSnapshot {
  return {
    version: 1,
    asOf: FRIDAY,
    lastSuccessfulAt: '2026-07-17T08:30:00.000Z',
    nextExpectedCloseAt: '2026-07-20T07:00:00.000Z',
    stockDirectory: STOCK_DIRECTORY,
    tradingCalendar: TRADING_CALENDAR,
    dailyClose: DAILY_CLOSE,
    limitations: ['Daily-close data only; suspended stocks may not have a close row'],
  };
}

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

describe('daily-close market snapshot cache', () => {
  it('atomically replaces directory, calendar, and close data as one validated bundle', async () => {
    const store = new MemorySnapshotStore();

    const snapshot = await refreshMarketSnapshot({
      store,
      source: source(),
      now: () => new Date('2026-07-17T08:30:00.000Z'),
    });

    expect(snapshot).toEqual({
      ...expectedSnapshot(),
    });
    await expect(store.read<DailyMarketSnapshot>(MARKET_SNAPSHOT_KEY)).resolves.toEqual(snapshot);
  });

  it('publishes the prior open day before 16:30 Shanghai and the current day at readiness', async () => {
    const directory: readonly StockSearchResult[] = [
      { code: PING_AN, name: '平安银行', pinyinAbbreviation: 'PAYH' },
      ...STOCK_DIRECTORY,
    ];
    const calendar: readonly TradingCalendarDay[] = [
      { date: THURSDAY, isOpen: true },
      ...TRADING_CALENDAR,
    ];
    const priorClose: readonly DailyPrice[] = [
      { ...DAILY_CLOSE[0]!, code: PING_AN, date: THURSDAY },
      { ...DAILY_CLOSE[0]!, date: THURSDAY },
    ];
    const loadDailyClose = vi.fn(async ({ date }: { date: typeof FRIDAY }) =>
      date === FRIDAY ? DAILY_CLOSE : priorClose,
    );
    const marketSource = source({
      loadStockDirectory: vi.fn(async () => directory),
      loadTradingCalendar: vi.fn(async () => calendar),
      loadDailyClose,
    });
    const store = new MemorySnapshotStore();

    const beforeReady = await refreshMarketSnapshot({
      store,
      source: marketSource,
      now: () => new Date('2026-07-17T07:30:00.000Z'),
    });
    const beforeReadyStatus = await readMarketSnapshot({
      store,
      now: () => new Date('2026-07-17T07:30:00.000Z'),
    });
    const atReady = await refreshMarketSnapshot({
      store,
      source: marketSource,
      now: () => new Date('2026-07-17T08:30:00.000Z'),
    });

    expect(loadDailyClose.mock.calls).toEqual([[{ date: THURSDAY }], [{ date: FRIDAY }]]);
    expect(beforeReady).toMatchObject({
      asOf: THURSDAY,
      nextExpectedCloseAt: '2026-07-17T07:00:00.000Z',
      dailyClose: priorClose,
    });
    expect(beforeReady.dailyClose).not.toContainEqual(expect.objectContaining({ date: FRIDAY }));
    expect(beforeReadyStatus.freshness).toBe('stale');
    expect(atReady).toMatchObject({
      asOf: FRIDAY,
      nextExpectedCloseAt: '2026-07-20T07:00:00.000Z',
      dailyClose: DAILY_CLOSE,
    });
  });

  it('records a safe failure while leaving the prior snapshot intact', async () => {
    const store = new MemorySnapshotStore();
    const prior = await refreshMarketSnapshot({
      store,
      source: source(),
      now: () => new Date('2026-07-17T08:30:00.000Z'),
    });
    const providerFailure = new AppError(
      'PROVIDER_UNAVAILABLE',
      'upstream body containing a secret',
      {
        status: 503,
        retryable: true,
        providerCode: 'TIMEOUT',
      },
    );

    await expect(
      refreshMarketSnapshot({
        store,
        source: source({ loadDailyClose: vi.fn(async () => Promise.reject(providerFailure)) }),
        now: () => new Date('2026-07-20T08:30:00.000Z'),
      }),
    ).rejects.toBe(providerFailure);

    await expect(store.read(MARKET_SNAPSHOT_KEY)).resolves.toEqual(prior);
    expect(store.failures).toEqual([
      {
        code: 'PROVIDER_UNAVAILABLE',
        message: 'Market data provider is unavailable',
        retryable: true,
        occurredAt: '2026-07-20T08:30:00.000Z',
      },
    ]);
    expect(JSON.stringify(store.failures)).not.toContain('secret');
  });

  it('marks the last-good snapshot stale after its next expected close', async () => {
    const store = new MemorySnapshotStore();
    await refreshMarketSnapshot({
      store,
      source: source(),
      now: () => new Date('2026-07-17T08:30:00.000Z'),
    });

    await expect(
      readMarketSnapshot({
        store,
        now: () => new Date('2026-07-20T07:00:00.001Z'),
      }),
    ).resolves.toMatchObject({
      freshness: 'stale',
      asOf: FRIDAY,
      lastSuccessfulAt: '2026-07-17T08:30:00.000Z',
      nextExpectedCloseAt: '2026-07-20T07:00:00.000Z',
    });
  });

  it('returns a retryable provider-unavailable error when no snapshot exists', async () => {
    const store = new MemorySnapshotStore();

    await expect(readMarketSnapshot({ store })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      status: 503,
      retryable: true,
    });
  });

  it('rejects stored freshness metadata that conflicts with the bundled trading calendar', async () => {
    const store = new MemorySnapshotStore();
    await store.writeAtomically(MARKET_SNAPSHOT_KEY, {
      ...expectedSnapshot(),
      nextExpectedCloseAt: '2026-07-21T07:00:00.000Z',
    });

    await expect(readMarketSnapshot({ store })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
      providerCode: 'SNAPSHOT_INVALID',
    });
  });
});

describe('private Vercel Blob snapshot store', () => {
  it('uploads an immutable date/hash object before replacing the pointer with its prior ETag', async () => {
    const client: SnapshotBlobClient = {
      get: vi.fn(async () => ({ body: '{"snapshotPath":"old.json"}', etag: 'etag-current' })),
      put: vi.fn(async () => undefined),
    };
    const store = createBlobSnapshotStore({ client });

    await store.writeAtomically(MARKET_SNAPSHOT_KEY, expectedSnapshot());

    const putCalls = vi.mocked(client.put).mock.calls;
    expect(putCalls).toHaveLength(2);
    const [snapshotPath, snapshotBody, snapshotOptions] = putCalls[0] ?? [];
    expect(snapshotPath).toMatch(/^market-snapshots\/snapshots\/2026-07-17\/[a-f0-9]{64}\.json$/);
    expect(JSON.parse(String(snapshotBody))).toEqual(expectedSnapshot());
    expect(snapshotOptions).toEqual({
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 31_536_000,
      contentType: 'application/json',
    });
    expect(putCalls[1]).toEqual([
      'market-snapshots/current.json',
      JSON.stringify({ snapshotPath }),
      {
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 60,
        contentType: 'application/json',
        ifMatch: 'etag-current',
      },
    ]);
    expect(client.get).toHaveBeenCalledWith('market-snapshots/current.json', {
      access: 'private',
      useCache: false,
    });
  });

  it('idempotently writes the same content hash twice while preserving pointer CAS', async () => {
    const contentPaths = new Set<string>();
    let pointer: { body: string; etag: string } | null = null;
    let etagVersion = 0;
    const client: SnapshotBlobClient = {
      get: vi.fn(async (pathname) => (pathname.endsWith('/current.json') ? pointer : null)),
      put: vi.fn(async (pathname, body, options) => {
        if (!pathname.endsWith('/current.json')) {
          if (contentPaths.has(pathname) && !options.allowOverwrite) {
            throw new Error('content pathname already exists');
          }
          contentPaths.add(pathname);
          return;
        }

        if (pointer === null) {
          expect(options.allowOverwrite).toBe(false);
        } else {
          expect(options).toMatchObject({ allowOverwrite: true, ifMatch: pointer.etag });
        }
        etagVersion += 1;
        pointer = { body, etag: `etag-${etagVersion}` };
      }),
    };
    const store = createBlobSnapshotStore({ client });

    await store.writeAtomically(MARKET_SNAPSHOT_KEY, expectedSnapshot());
    await store.writeAtomically(MARKET_SNAPSHOT_KEY, expectedSnapshot());

    const snapshotCalls = vi
      .mocked(client.put)
      .mock.calls.filter(([pathname]) => !pathname.endsWith('/current.json'));
    expect(snapshotCalls).toHaveLength(2);
    expect(snapshotCalls[0]?.[0]).toBe(snapshotCalls[1]?.[0]);
    expect(snapshotCalls.map(([, , options]) => options.allowOverwrite)).toEqual([true, true]);
    expect(pointer).toMatchObject({ etag: 'etag-2' });
  });

  it('reads the strongly-current pointer before the immutable snapshot object', async () => {
    const snapshot = expectedSnapshot();
    const snapshotPath = 'market-snapshots/snapshots/2026-07-17/content-hash.json';
    const client: SnapshotBlobClient = {
      get: vi.fn(async (pathname) =>
        pathname.endsWith('/current.json')
          ? { body: JSON.stringify({ snapshotPath }), etag: 'etag-current' }
          : { body: JSON.stringify(snapshot), etag: 'etag-snapshot' },
      ),
      put: vi.fn(async () => undefined),
    };

    await expect(createBlobSnapshotStore({ client }).read(MARKET_SNAPSHOT_KEY)).resolves.toEqual(
      snapshot,
    );
    expect(vi.mocked(client.get).mock.calls).toEqual([
      ['market-snapshots/current.json', { access: 'private', useCache: false }],
      [snapshotPath, { access: 'private', useCache: true }],
    ]);
  });

  it('accepts an initial competing creator when its pointer chose the same content path', async () => {
    let attemptedPath = '';
    let pointerReads = 0;
    const client: SnapshotBlobClient = {
      get: vi.fn(async (pathname) => {
        if (!pathname.endsWith('/current.json')) {
          return null;
        }
        pointerReads += 1;
        return pointerReads === 1
          ? null
          : {
              body: JSON.stringify({ snapshotPath: attemptedPath }),
              etag: 'etag-winner',
            };
      }),
      put: vi.fn(async (pathname) => {
        if (pathname.endsWith('/current.json')) {
          throw new Error('pathname already exists');
        }
        attemptedPath = pathname;
      }),
    };

    await expect(
      createBlobSnapshotStore({ client }).writeAtomically(MARKET_SNAPSHOT_KEY, expectedSnapshot()),
    ).resolves.toBeUndefined();
    expect(client.get).toHaveBeenLastCalledWith('market-snapshots/current.json', {
      access: 'private',
      useCache: false,
    });
  });

  it('classifies an initial competing creator with a different winner and preserves last-good', async () => {
    const storageError = new Error('pathname already exists');
    const winnerPath = 'market-snapshots/snapshots/2026-07-16/winner.json';
    const lastGood = { marker: 'last-good' };
    let pointerReads = 0;
    const client: SnapshotBlobClient = {
      get: vi.fn(async (pathname) => {
        if (pathname.endsWith('/current.json')) {
          pointerReads += 1;
          return pointerReads === 1
            ? null
            : {
                body: JSON.stringify({ snapshotPath: winnerPath }),
                etag: 'etag-winner',
              };
        }
        return pathname === winnerPath
          ? { body: JSON.stringify(lastGood), etag: 'etag-snapshot' }
          : null;
      }),
      put: vi.fn(async (pathname) => {
        if (pathname.endsWith('/current.json')) {
          throw storageError;
        }
      }),
    };
    const store = createBlobSnapshotStore({ client });

    await expect(
      store.writeAtomically(MARKET_SNAPSHOT_KEY, expectedSnapshot()),
    ).rejects.toMatchObject({
      name: 'SnapshotConflictError',
      code: 'INTERNAL_ERROR',
      status: 409,
      retryable: true,
    });
    await expect(store.read(MARKET_SNAPSHOT_KEY)).resolves.toEqual(lastGood);
  });

  it('preserves the initial storage error when a failed pointer create has no winner', async () => {
    const storageError = new Error('blob service unavailable');
    const client: SnapshotBlobClient = {
      get: vi.fn(async () => null),
      put: vi.fn(async (pathname) => {
        if (pathname.endsWith('/current.json')) {
          throw storageError;
        }
      }),
    };

    await expect(
      createBlobSnapshotStore({ client }).writeAtomically(MARKET_SNAPSHOT_KEY, expectedSnapshot()),
    ).rejects.toBe(storageError);
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  it('accepts an existing-pointer CAS race when the winner chose the same content path', async () => {
    let attemptedPath = '';
    let pointerReads = 0;
    const client: SnapshotBlobClient = {
      get: vi.fn(async () => {
        pointerReads += 1;
        return pointerReads === 1
          ? {
              body: JSON.stringify({
                snapshotPath: 'market-snapshots/snapshots/2026-07-16/old.json',
              }),
              etag: 'etag-current',
            }
          : {
              body: JSON.stringify({ snapshotPath: attemptedPath }),
              etag: 'etag-winner',
            };
      }),
      put: vi.fn(async (pathname) => {
        if (pathname.endsWith('/current.json')) {
          throw new BlobPreconditionFailedError();
        }
        attemptedPath = pathname;
      }),
    };

    await expect(
      createBlobSnapshotStore({ client }).writeAtomically(MARKET_SNAPSHOT_KEY, expectedSnapshot()),
    ).resolves.toBeUndefined();
  });

  it('classifies an existing-pointer CAS winner at a different path as a conflict', async () => {
    const pointer = {
      body: JSON.stringify({
        snapshotPath: 'market-snapshots/snapshots/2026-07-16/winner.json',
      }),
      etag: 'etag-current',
    };
    const client: SnapshotBlobClient = {
      get: vi.fn(async () => pointer),
      put: vi.fn(async (pathname) => {
        if (pathname.endsWith('/current.json')) {
          throw new BlobPreconditionFailedError();
        }
      }),
    };

    await expect(
      createBlobSnapshotStore({ client }).writeAtomically(MARKET_SNAPSHOT_KEY, expectedSnapshot()),
    ).rejects.toMatchObject({
      name: 'SnapshotConflictError',
      code: 'INTERNAL_ERROR',
      status: 409,
      retryable: true,
    });
  });

  it('preserves an ordinary existing-pointer storage failure when the old pointer is unchanged', async () => {
    const storageError = new Error('blob service unavailable');
    const pointer = {
      body: JSON.stringify({
        snapshotPath: 'market-snapshots/snapshots/2026-07-16/last-good.json',
      }),
      etag: 'etag-current',
    };
    const client: SnapshotBlobClient = {
      get: vi.fn(async () => pointer),
      put: vi.fn(async (pathname) => {
        if (pathname.endsWith('/current.json')) {
          throw storageError;
        }
      }),
    };

    await expect(
      createBlobSnapshotStore({ client }).writeAtomically(MARKET_SNAPSHOT_KEY, expectedSnapshot()),
    ).rejects.toBe(storageError);
  });

  it('records safe failures as immutable objects without reading or touching the pointer', async () => {
    const client: SnapshotBlobClient = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    };
    const failure: SafeSnapshotFailure = {
      code: 'PROVIDER_UNAVAILABLE',
      message: 'Market data provider is unavailable',
      retryable: true,
      occurredAt: '2026-07-20T08:30:00.000Z',
    };

    await createBlobSnapshotStore({ client }).recordFailure(MARKET_SNAPSHOT_KEY, failure);

    expect(client.get).not.toHaveBeenCalled();
    expect(client.put).toHaveBeenCalledOnce();
    const [pathname, body, options] = vi.mocked(client.put).mock.calls[0] ?? [];
    expect(pathname).toMatch(/^market-snapshots\/failures\/2026-07-20\/[a-f0-9]{64}\.json$/);
    expect(JSON.parse(String(body))).toEqual(failure);
    expect(options).toMatchObject({
      access: 'private',
      allowOverwrite: true,
      addRandomSuffix: false,
    });
    expect(JSON.stringify(options)).not.toContain('token');
  });
});
