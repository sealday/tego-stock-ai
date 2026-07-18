import { AppError, notFound } from '../../domain/errors';
import type {
  DailyPrice,
  IsoDate,
  MarketEnvelope,
  StockCode,
  StockFundamentals,
  StockOverview,
  StockSearchResult,
} from '../../domain/stock';
import { isoDate } from '../../domain/stock';
import { mapDailyRows, mapFundamentalRows, mapOverviewRows, mapStockRows } from './mapper';
import { parseProviderResponse } from './schemas';

type ProviderParameter = string | number | boolean;

export interface TushareQuery {
  apiName: string;
  params: Readonly<Record<string, ProviderParameter>>;
  fields: readonly string[];
}

export interface TushareTable {
  fields: string[];
  items: unknown[][];
}

export interface TushareClient {
  query(input: TushareQuery): Promise<TushareTable>;
}

export interface MarketDataAdapter {
  listStocks(): Promise<MarketEnvelope<readonly StockSearchResult[]>>;
  getOverview(input: { code: StockCode; asOf?: IsoDate }): Promise<MarketEnvelope<StockOverview>>;
  getHistory(input: {
    code: StockCode;
    start: IsoDate;
    end: IsoDate;
    adjust: 'forward';
  }): Promise<MarketEnvelope<readonly DailyPrice[]>>;
  getFundamentals(input: {
    code: StockCode;
    asOf?: IsoDate;
  }): Promise<MarketEnvelope<StockFundamentals>>;
}

interface TushareClientOptions {
  token: string;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
  endpoint?: string;
}

const DEFAULT_ENDPOINT = 'https://api.tushare.pro';

export function createTushareClient(options: TushareClientOptions): TushareClient {
  if (options.token.length === 0) {
    throw new AppError('PROVIDER_PERMISSION', 'Market data provider is not configured', {
      status: 503,
      retryable: false,
      providerCode: 'TOKEN_MISSING',
    });
  }

  const fetchImplementation = options.fetchImplementation ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;

  return {
    async query(input) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImplementation(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            api_name: input.apiName,
            token: options.token,
            params: input.params,
            fields: input.fields.join(','),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            throw new AppError('PROVIDER_PERMISSION', 'Market data access is not permitted', {
              status: 502,
              retryable: false,
              providerCode: `HTTP_${response.status}`,
            });
          }

          throw new AppError(
            response.status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_UNAVAILABLE',
            response.status === 429
              ? 'Market data provider rate limit reached'
              : 'Market data provider is unavailable',
            {
              status: response.status === 429 ? 429 : 503,
              retryable: true,
              providerCode: `HTTP_${response.status}`,
            },
          );
        }

        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw providerUnavailable('INVALID_JSON');
        }

        let parsed;
        try {
          parsed = parseProviderResponse(payload);
        } catch {
          throw providerUnavailable('INVALID_SCHEMA');
        }

        if (parsed.code !== 0) {
          throw providerResponseError(parsed.code);
        }

        if (parsed.data === null || parsed.data === undefined) {
          throw providerUnavailable('MISSING_DATA');
        }

        return parsed.data;
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        throw providerUnavailable(
          error instanceof DOMException && error.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK',
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export function createTushareMarketDataAdapter(
  client: TushareClient,
  now: () => Date = () => new Date(),
): MarketDataAdapter {
  return {
    async listStocks() {
      const table = await client.query({
        apiName: 'stock_basic',
        params: { list_status: 'L' },
        fields: ['ts_code', 'name', 'cnspell', 'list_status'],
      });
      const stocks = mapProvider(() => mapStockRows(tableRecords(table)));
      return marketEnvelope(stocks, currentDate(now));
    },

    async getHistory(input) {
      const params = {
        ts_code: input.code,
        start_date: compactDate(input.start),
        end_date: compactDate(input.end),
      };
      const [dailyTable, adjustmentTable] = await Promise.all([
        client.query({
          apiName: 'daily',
          params,
          fields: ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'vol', 'amount'],
        }),
        client.query({
          apiName: 'adj_factor',
          params,
          fields: ['ts_code', 'trade_date', 'adj_factor'],
        }),
      ]);
      const adjustments = new Map(
        tableRecords(adjustmentTable).map((row) => [
          `${String(row.ts_code)}:${String(row.trade_date)}`,
          row.adj_factor,
        ]),
      );
      const rows = tableRecords(dailyTable).map((row) => ({
        ...row,
        adj_factor: adjustments.get(`${String(row.ts_code)}:${String(row.trade_date)}`) ?? null,
      }));
      const history = mapProvider(() => forwardAdjust(mapDailyRows(rows)));
      if (history.length === 0) {
        throw notFound();
      }
      if (history.some((row) => row.code !== input.code)) {
        throw providerUnavailable('CODE_MISMATCH');
      }

      return marketEnvelope(history, history.at(-1)?.date ?? input.end, {
        adjustmentFactor: { status: 'available', value: true },
      });
    },

    async getOverview(input) {
      const dateParams =
        input.asOf === undefined
          ? { ts_code: input.code }
          : { ts_code: input.code, end_date: compactDate(input.asOf) };
      const valuationQuery = {
        apiName: 'daily_basic',
        params: dateParams,
        fields: ['ts_code', 'trade_date', 'pe_ttm', 'pb', 'total_mv'],
      } as const;
      const [dailyTable, stockTable, valuationResult] = await Promise.all([
        client.query({
          apiName: 'daily',
          params: dateParams,
          fields: ['ts_code', 'trade_date', 'close', 'pre_close', 'pct_chg'],
        }),
        client.query({
          apiName: 'stock_basic',
          params: { ts_code: input.code },
          fields: ['ts_code', 'name'],
        }),
        optionalPermissionTable(client, valuationQuery),
      ]);
      const dailyRows = tableRecords(dailyTable);
      const stockRows = tableRecords(stockTable);
      const valuationRows = tableRecords(valuationResult.table);
      const daily = latestProviderRow(dailyRows, input.code, input.asOf);
      if (daily === undefined) {
        if (dailyRows.some((row) => row.ts_code !== input.code)) {
          throw providerUnavailable('CODE_MISMATCH');
        }
        throw notFound();
      }
      const stock = stockRows.find((row) => row.ts_code === input.code);
      if (stock === undefined) {
        throw providerUnavailable(
          stockRows.length > 0 ? 'CODE_MISMATCH' : 'MISSING_STOCK_METADATA',
        );
      }
      const valuation = valuationRows.find(
        (row) => row.ts_code === input.code && row.trade_date === daily.trade_date,
      );
      const mapped = mapProvider(() =>
        mapOverviewRows({
          daily: [daily],
          stocks: [stock],
          valuation: valuation === undefined ? [] : [valuation],
        }),
      );

      const availability = valuationResult.permissionMissing
        ? {
            ...mapped.availability,
            peTtm: { status: 'missing' as const, reason: 'Provider permission unavailable' },
            pb: { status: 'missing' as const, reason: 'Provider permission unavailable' },
            totalMarketValueCny: {
              status: 'missing' as const,
              reason: 'Provider permission unavailable',
            },
          }
        : mapped.availability;
      if (mapped.data.code !== input.code) {
        throw providerUnavailable('CODE_MISMATCH');
      }

      return marketEnvelope(mapped.data, mapped.data.date, availability);
    },

    async getFundamentals(input) {
      const table = await client.query({
        apiName: 'fina_indicator',
        params:
          input.asOf === undefined
            ? { ts_code: input.code }
            : { ts_code: input.code, end_date: compactDate(input.asOf) },
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
      });
      const mapped = mapProvider(() => mapFundamentalRows(tableRecords(table)))
        .filter((row) => input.asOf === undefined || row.announcedAt <= input.asOf)
        .at(-1);
      if (mapped === undefined) {
        throw notFound();
      }
      if (mapped.data.code !== input.code) {
        throw providerUnavailable('CODE_MISMATCH');
      }

      return marketEnvelope(mapped.data, mapped.announcedAt, mapped.availability);
    },
  };
}

export function createTushareMarketDataAdapterFromEnvironment(): MarketDataAdapter {
  return createTushareMarketDataAdapter(
    createTushareClient({ token: process.env.TUSHARE_TOKEN ?? '' }),
  );
}

function providerResponseError(code: number): AppError {
  const providerCode = String(code);

  if (code === 2002) {
    return new AppError('PROVIDER_PERMISSION', 'Market data access is not permitted', {
      status: 502,
      retryable: false,
      providerCode,
    });
  }

  if (code === -2003 || code === -2004) {
    return new AppError('PROVIDER_RATE_LIMIT', 'Market data provider rate limit reached', {
      status: 429,
      retryable: true,
      providerCode,
    });
  }

  return providerUnavailable(providerCode);
}

function providerUnavailable(providerCode: string): AppError {
  return new AppError('PROVIDER_UNAVAILABLE', 'Market data provider is unavailable', {
    status: 503,
    retryable: true,
    providerCode,
  });
}

function tableRecords(table: TushareTable): Array<Record<string, unknown>> {
  if (new Set(table.fields).size !== table.fields.length) {
    throw providerUnavailable('DUPLICATE_FIELDS');
  }

  return table.items.map((item) => {
    if (item.length !== table.fields.length) {
      throw providerUnavailable('ROW_WIDTH');
    }

    return Object.fromEntries(table.fields.map((field, index) => [field, item[index]]));
  });
}

function mapProvider<T>(map: () => T): T {
  try {
    return map();
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw providerUnavailable('INVALID_SCHEMA');
  }
}

function marketEnvelope<T>(
  data: T,
  asOf: IsoDate,
  availability: MarketEnvelope<T>['availability'] = {},
): MarketEnvelope<T> {
  return {
    data,
    asOf,
    source: 'Tushare Pro',
    freshness: 'fresh',
    availability,
    limitations: ['Daily-close data only; provider permissions may limit some fields'],
  };
}

function compactDate(value: IsoDate): string {
  return value.replaceAll('-', '');
}

function currentDate(now: () => Date): IsoDate {
  return isoDate(now().toISOString().slice(0, 10));
}

function latestProviderRow(
  rows: Array<Record<string, unknown>>,
  code: StockCode,
  asOf: IsoDate | undefined,
): Record<string, unknown> | undefined {
  const cutoff = asOf === undefined ? undefined : compactDate(asOf);

  return rows
    .filter(
      (row) =>
        row.ts_code === code &&
        typeof row.trade_date === 'string' &&
        (cutoff === undefined || row.trade_date <= cutoff),
    )
    .sort((left, right) => String(left.trade_date).localeCompare(String(right.trade_date)))
    .at(-1);
}

async function optionalPermissionTable(
  client: TushareClient,
  query: TushareQuery,
): Promise<{ table: TushareTable; permissionMissing: boolean }> {
  try {
    return { table: await client.query(query), permissionMissing: false };
  } catch (error) {
    if (error instanceof AppError && error.code === 'PROVIDER_PERMISSION') {
      return {
        table: { fields: [...query.fields], items: [] },
        permissionMissing: true,
      };
    }

    throw error;
  }
}

function forwardAdjust(history: DailyPrice[]): DailyPrice[] {
  const latestFactor = history.at(-1)?.adjustmentFactor;
  if (history.length > 0 && (latestFactor === null || latestFactor === undefined)) {
    throw providerUnavailable('MISSING_ADJUSTMENT');
  }

  if (latestFactor === null || latestFactor === undefined) {
    return history;
  }

  return history.map((row) => {
    if (row.adjustmentFactor === null) {
      throw providerUnavailable('MISSING_ADJUSTMENT');
    }

    const ratio = row.adjustmentFactor / latestFactor;
    return {
      ...row,
      open: row.open * ratio,
      high: row.high * ratio,
      low: row.low * ratio,
      close: row.close * ratio,
    };
  });
}
