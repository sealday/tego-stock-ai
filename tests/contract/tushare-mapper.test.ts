import { describe, expect, it, vi } from 'vitest';

import {
  createTushareClient,
  createTushareMarketDataAdapter,
  type TushareQuery,
} from '../../src/server/tushare/client';
import { AppError } from '../../src/domain/errors';
import { isoDate, stockCode } from '../../src/domain/stock';
import {
  mapDailyRows,
  mapFundamentalRows,
  mapOverviewRows,
  mapStockRows,
} from '../../src/server/tushare/mapper';
import fixture from './fixtures/tushare/daily.json';
import fundamentalFixture from './fixtures/tushare/fundamentals.json';
import overviewFixture from './fixtures/tushare/overview.json';
import stockFixture from './fixtures/tushare/stock-basic.json';

const dailyFixtureRow = fixture.items[0];
if (dailyFixtureRow === undefined) {
  throw new Error('Daily fixture must contain one row');
}

describe('Tushare daily row mapper', () => {
  it('normalizes provider units and field names into the public daily-price shape', () => {
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
  });

  it('sorts historical rows by ascending trading date', () => {
    expect(
      mapDailyRows([
        { ...dailyFixtureRow, trade_date: '20260718' },
        { ...dailyFixtureRow, trade_date: '20260716' },
      ]).map((row) => row.date),
    ).toEqual(['2026-07-16', '2026-07-18']);
  });

  it('preserves an unavailable adjustment factor as an explicit null', () => {
    expect(mapDailyRows([{ ...dailyFixtureRow, adj_factor: null }])[0]).toMatchObject({
      adjustmentFactor: null,
    });
  });

  it('rejects a provider row with a missing required market field', () => {
    const { close, ...missingClose } = dailyFixtureRow;

    expect(close).toBe(1430.2);
    expect(() => mapDailyRows([missingClose])).toThrow();
  });
});

describe('Tushare stable domain mappings', () => {
  it('maps only listed stocks without exporting provider field names', () => {
    expect(mapStockRows(stockFixture.items)).toEqual([
      { code: '000001.SZ', name: '平安银行', pinyinAbbreviation: 'PAYH' },
      { code: '600519.SH', name: '贵州茅台', pinyinAbbreviation: 'GZMT' },
    ]);
  });

  it('normalizes fundamental percentages and discloses a missing field', () => {
    expect(mapFundamentalRows(fundamentalFixture.items)).toEqual([
      {
        announcedAt: '2026-07-15',
        data: {
          code: '600519.SH',
          date: '2026-06-30',
          roe: 0.31,
          grossMargin: 0.91,
          revenueGrowth: null,
          profitGrowth: 0.16,
          operatingCashToNetProfit: null,
          debtToAssets: 0.12,
        },
        availability: {
          roe: { status: 'available', value: 0.31 },
          grossMargin: { status: 'available', value: 0.91 },
          revenueGrowth: { status: 'missing', reason: 'Provider field unavailable' },
          profitGrowth: { status: 'available', value: 0.16 },
          operatingCashToNetProfit: {
            status: 'missing',
            reason: 'Requires comparable cash-flow and net-profit statements',
          },
          debtToAssets: { status: 'available', value: 0.12 },
        },
      },
    ]);
  });

  it('combines close and valuation rows while disclosing missing valuation data', () => {
    expect(mapOverviewRows(overviewFixture)).toEqual({
      data: {
        code: '600519.SH',
        name: '贵州茅台',
        date: '2026-07-17',
        close: 1430.2,
        previousClose: 1420,
        changePercent: 0.7183,
        peTtm: null,
        pb: 8.1,
        totalMarketValueCny: 1_796_000_000_000,
      },
      availability: {
        previousClose: { status: 'available', value: 1420 },
        changePercent: { status: 'available', value: 0.7183 },
        peTtm: { status: 'missing', reason: 'Provider field unavailable' },
        pb: { status: 'available', value: 8.1 },
        totalMarketValueCny: { status: 'available', value: 1_796_000_000_000 },
      },
    });
  });

  it('rejects overview rows whose stock code or valuation date does not align', () => {
    expect(() =>
      mapOverviewRows({
        ...overviewFixture,
        stocks: [{ ...overviewFixture.stocks[0], ts_code: '000001.SZ' }],
      }),
    ).toThrow('Provider overview rows do not align');
    expect(() =>
      mapOverviewRows({
        ...overviewFixture,
        valuation: [{ ...overviewFixture.valuation[0], trade_date: '20260716' }],
      }),
    ).toThrow('Provider overview rows do not align');
  });
});

describe('Tushare client', () => {
  it('sends the server-side token only in the provider request body and validates the response', async () => {
    const fetchImplementation = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        code: 0,
        msg: null,
        data: {
          fields: ['ts_code'],
          items: [['600519.SH']],
        },
      }),
    );
    const client = createTushareClient({
      token: 'server-side-test-token',
      fetchImplementation,
      timeoutMs: 1_000,
    });

    await expect(
      client.query({ apiName: 'daily', params: { ts_code: '600519.SH' }, fields: ['ts_code'] }),
    ).resolves.toEqual({ fields: ['ts_code'], items: [['600519.SH']] });

    const [, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({
      api_name: 'daily',
      token: 'server-side-test-token',
      params: { ts_code: '600519.SH' },
      fields: 'ts_code',
    });
  });

  it('maps a provider permission response to a safe code without retaining the upstream body', async () => {
    const fetchImplementation = vi.fn(async () =>
      Response.json({
        code: 2002,
        msg: 'permission denied for token server-side-test-token',
        data: null,
      }),
    );
    const client = createTushareClient({
      token: 'server-side-test-token',
      fetchImplementation,
      timeoutMs: 1_000,
    });

    const error = await client
      .query({ apiName: 'daily', params: {}, fields: ['ts_code'] })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'PROVIDER_PERMISSION', providerCode: '2002' });
    expect(String(error)).not.toContain('server-side-test-token');
    expect(String(error)).not.toContain('permission denied');
  });

  it('maps an HTTP permission response to the same safe permission taxonomy', async () => {
    const client = createTushareClient({
      token: 'server-side-test-token',
      fetchImplementation: vi.fn(async () => new Response(null, { status: 403 })),
      timeoutMs: 1_000,
    });

    await expect(
      client.query({ apiName: 'daily', params: {}, fields: ['ts_code'] }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_PERMISSION',
      providerCode: 'HTTP_403',
      retryable: false,
    });
  });

  it('rejects malformed successful provider payloads before mapping', async () => {
    const client = createTushareClient({
      token: 'server-side-test-token',
      fetchImplementation: vi.fn(async () =>
        Response.json({ code: 0, msg: null, data: { fields: ['ts_code'], items: 'not-an-array' } }),
      ),
      timeoutMs: 1_000,
    });

    await expect(
      client.query({ apiName: 'daily', params: {}, fields: ['ts_code'] }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});

describe('Tushare market adapter', () => {
  it('uses the latest adjustment factor to return forward-adjusted history prices', async () => {
    const client = {
      query: vi.fn(async (query: TushareQuery) => {
        if (query.apiName === 'adj_factor') {
          return {
            fields: ['ts_code', 'trade_date', 'adj_factor'],
            items: [
              ['600519.SH', '20260717', 2],
              ['600519.SH', '20260716', 1],
            ],
          };
        }

        return {
          fields: ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'vol', 'amount'],
          items: [
            ['600519.SH', '20260717', 108, 112, 107, 110, 100, 200],
            ['600519.SH', '20260716', 98, 102, 97, 100, 100, 200],
          ],
        };
      }),
    };
    const adapter = createTushareMarketDataAdapter(client);

    const result = await adapter.getHistory({
      code: stockCode('600519.SH'),
      start: isoDate('2026-07-16'),
      end: isoDate('2026-07-17'),
      adjust: 'forward',
    });

    expect(result.data.map((row) => row.close)).toEqual([50, 110]);
    expect(result.data.map((row) => row.adjustmentFactor)).toEqual([1, 2]);
  });

  it('keeps close data usable when valuation permission is unavailable', async () => {
    const client = {
      query: vi.fn(async (query: TushareQuery) => {
        if (query.apiName === 'daily_basic') {
          throw new AppError('PROVIDER_PERMISSION', 'Market data access is not permitted', {
            status: 502,
            retryable: false,
            providerCode: '2002',
          });
        }

        if (query.apiName === 'stock_basic') {
          return {
            fields: ['ts_code', 'name'],
            items: [['600519.SH', '贵州茅台']],
          };
        }

        return {
          fields: ['ts_code', 'trade_date', 'close', 'pre_close', 'pct_chg'],
          items: [['600519.SH', '20260717', 1430.2, 1420, 0.7183]],
        };
      }),
    };
    const adapter = createTushareMarketDataAdapter(client);

    const result = await adapter.getOverview({ code: stockCode('600519.SH') });

    expect(result.data).toMatchObject({ close: 1430.2, peTtm: null, pb: null });
    expect(result.availability.peTtm).toEqual({
      status: 'missing',
      reason: 'Provider permission unavailable',
    });
  });

  it('uses the latest close on or before the cutoff and treats lagging valuation as missing', async () => {
    const client = {
      query: vi.fn(async (query: TushareQuery) => {
        if (query.apiName === 'stock_basic') {
          return { fields: ['ts_code', 'name'], items: [['600519.SH', '贵州茅台']] };
        }

        if (query.apiName === 'daily_basic') {
          return {
            fields: ['ts_code', 'trade_date', 'pe_ttm', 'pb', 'total_mv'],
            items: [['600519.SH', '20260716', 20, 8, 179_600_000]],
          };
        }

        return {
          fields: ['ts_code', 'trade_date', 'close', 'pre_close', 'pct_chg'],
          items: [
            ['600519.SH', '20260716', 1420, 1410, 0.71],
            ['600519.SH', '20260717', 1430.2, 1420, 0.7183],
          ],
        };
      }),
    };
    const adapter = createTushareMarketDataAdapter(client);

    const result = await adapter.getOverview({
      code: stockCode('600519.SH'),
      asOf: isoDate('2026-07-18'),
    });

    expect(result.data).toMatchObject({ date: '2026-07-17', close: 1430.2, peTtm: null });
    expect(result.availability.peTtm).toEqual({
      status: 'missing',
      reason: 'Provider field unavailable',
    });
    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({
        apiName: 'daily',
        params: { ts_code: '600519.SH', end_date: '20260718' },
      }),
    );
  });

  it('returns NOT_FOUND when overview has no close on or before the cutoff', async () => {
    const client = {
      query: vi.fn(async (query: TushareQuery) => ({
        fields:
          query.apiName === 'stock_basic'
            ? ['ts_code', 'name']
            : query.apiName === 'daily_basic'
              ? ['ts_code', 'trade_date', 'pe_ttm', 'pb', 'total_mv']
              : ['ts_code', 'trade_date', 'close', 'pre_close', 'pct_chg'],
        items: query.apiName === 'stock_basic' ? [['600519.SH', '贵州茅台']] : [],
      })),
    };
    const adapter = createTushareMarketDataAdapter(client);

    await expect(
      adapter.getOverview({ code: stockCode('600519.SH'), asOf: isoDate('1990-01-01') }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns NOT_FOUND when a valid history request has no provider rows', async () => {
    const client = {
      query: vi.fn(async (query: TushareQuery) => ({
        fields:
          query.apiName === 'adj_factor'
            ? ['ts_code', 'trade_date', 'adj_factor']
            : ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'vol', 'amount'],
        items: [],
      })),
    };
    const adapter = createTushareMarketDataAdapter(client);

    await expect(
      adapter.getHistory({
        code: stockCode('600519.SH'),
        start: isoDate('2026-07-16'),
        end: isoDate('2026-07-17'),
        adjust: 'forward',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects history rows that do not match the requested stock code', async () => {
    const client = {
      query: vi.fn(async (query: TushareQuery) =>
        query.apiName === 'adj_factor'
          ? {
              fields: ['ts_code', 'trade_date', 'adj_factor'],
              items: [['000001.SZ', '20260717', 1]],
            }
          : {
              fields: ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'vol', 'amount'],
              items: [['000001.SZ', '20260717', 10, 11, 9, 10, 100, 200]],
            },
      ),
    };
    const adapter = createTushareMarketDataAdapter(client);

    await expect(
      adapter.getHistory({
        code: stockCode('600519.SH'),
        start: isoDate('2026-07-17'),
        end: isoDate('2026-07-17'),
        adjust: 'forward',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('selects fundamentals announced on or before the requested cutoff', async () => {
    const client = {
      query: vi.fn(async () => ({
        fields: [
          'ts_code',
          'ann_date',
          'end_date',
          'roe',
          'grossprofit_margin',
          'or_yoy',
          'netprofit_yoy',
          'debt_to_assets',
          'update_flag',
        ],
        items: [
          ['600519.SH', '20260720', '20260630', 31, 91, 12, 16, 12, '1'],
          ['600519.SH', '20260430', '20260331', 20, 90, 10, 12, 13, '1'],
        ],
      })),
    };
    const adapter = createTushareMarketDataAdapter(client);

    const result = await adapter.getFundamentals({
      code: stockCode('600519.SH'),
      asOf: isoDate('2026-07-17'),
    });

    expect(result.data).toMatchObject({ date: '2026-03-31', roe: 0.2 });
    expect(result.asOf).toBe('2026-04-30');
    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({ params: { ts_code: '600519.SH', end_date: '20260717' } }),
    );
  });
});
