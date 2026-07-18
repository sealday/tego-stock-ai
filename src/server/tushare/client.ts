import { AppError, notFound } from '../../domain/errors';
import type {
  Availability,
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
import {
  parseCashflowStatementRows,
  parseIncomeStatementRows,
  parseProviderResponse,
} from './schemas';

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
const OVERVIEW_LOOKBACK_DAYS = [14, 90, 366, 1_826] as const;

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
      const dailyRows = tableRecords(dailyTable);
      const adjustmentRows = tableRecords(adjustmentTable);
      validateHistoryProviderRows(dailyRows, input.code, input.start, input.end);
      validateHistoryProviderRows(adjustmentRows, input.code, input.start, input.end);
      const adjustments = new Map(
        adjustmentRows.map((row) => [
          `${String(row.ts_code)}:${String(row.trade_date)}`,
          row.adj_factor,
        ]),
      );
      const rows = dailyRows.map((row) => ({
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
      const cutoff = input.asOf ?? currentDate(now);
      const daily = await resolveLatestDailyRow(client, input.code, cutoff);
      if (daily === undefined) {
        throw notFound();
      }
      const tradeDate = String(daily.trade_date);
      const valuationQuery = {
        apiName: 'daily_basic',
        params: { ts_code: input.code, trade_date: tradeDate },
        fields: ['ts_code', 'trade_date', 'pe_ttm', 'pb', 'total_mv'],
      } as const;
      const [stockTable, valuationResult] = await Promise.all([
        client.query({
          apiName: 'stock_basic',
          params: { ts_code: input.code },
          fields: ['ts_code', 'name'],
        }),
        optionalPermissionTable(client, valuationQuery),
      ]);
      const stockRows = tableRecords(stockTable);
      const valuationRows = tableRecords(valuationResult.table);
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
      const cutoff = input.asOf ?? currentDate(now);
      const table = await client.query({
        apiName: 'fina_indicator',
        params: { ts_code: input.code, end_date: compactDate(cutoff) },
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
        .filter((row) => row.announcedAt <= cutoff)
        .at(-1);
      if (mapped === undefined) {
        throw notFound();
      }
      if (mapped.data.code !== input.code) {
        throw providerUnavailable('CODE_MISMATCH');
      }

      const period = compactDate(mapped.data.date);
      const incomeQuery = {
        apiName: 'income',
        params: { ts_code: input.code, period, report_type: '1' },
        fields: [
          'ts_code',
          'ann_date',
          'end_date',
          'report_type',
          'n_income_attr_p',
          'update_flag',
        ],
      } as const;
      const cashflowQuery = {
        apiName: 'cashflow',
        params: { ts_code: input.code, period, report_type: '1' },
        fields: ['ts_code', 'ann_date', 'end_date', 'report_type', 'n_cashflow_act', 'update_flag'],
      } as const;
      const [incomeResult, cashflowResult] = await Promise.all([
        optionalPermissionTable(client, incomeQuery),
        optionalPermissionTable(client, cashflowQuery),
      ]);
      const quality = operatingCashToNetProfit({
        incomeResult,
        cashflowResult,
        code: input.code,
        period,
        cutoff,
      });
      const data = {
        ...mapped.data,
        operatingCashToNetProfit: quality.value,
      };
      const availability = {
        ...mapped.availability,
        operatingCashToNetProfit: quality.availability,
      };

      return marketEnvelope(
        data,
        latestDate(mapped.announcedAt, quality.announcedAt),
        availability,
      );
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
  start: IsoDate,
  end: IsoDate,
): Record<string, unknown> | undefined {
  const compactStart = compactDate(start);
  const compactEnd = compactDate(end);

  return rows
    .filter(
      (row) =>
        row.ts_code === code &&
        typeof row.trade_date === 'string' &&
        row.trade_date >= compactStart &&
        row.trade_date <= compactEnd,
    )
    .sort((left, right) => String(left.trade_date).localeCompare(String(right.trade_date)))
    .at(-1);
}

async function resolveLatestDailyRow(
  client: TushareClient,
  code: StockCode,
  cutoff: IsoDate,
): Promise<Record<string, unknown> | undefined> {
  const attemptedStarts = new Set<IsoDate>();

  for (const lookbackDays of OVERVIEW_LOOKBACK_DAYS) {
    const start = subtractDays(cutoff, lookbackDays);
    if (attemptedStarts.has(start)) {
      continue;
    }
    attemptedStarts.add(start);

    const table = await client.query({
      apiName: 'daily',
      params: {
        ts_code: code,
        start_date: compactDate(start),
        end_date: compactDate(cutoff),
      },
      fields: ['ts_code', 'trade_date', 'close', 'pre_close', 'pct_chg'],
    });
    const rows = tableRecords(table);
    const daily = latestProviderRow(rows, code, start, cutoff);
    if (daily !== undefined) {
      return daily;
    }
    if (rows.some((row) => row.ts_code !== code)) {
      throw providerUnavailable('CODE_MISMATCH');
    }
  }

  return undefined;
}

function subtractDays(value: IsoDate, days: number): IsoDate {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  const result = date.toISOString().slice(0, 10);

  return isoDate(result < '1900-01-01' ? '1900-01-01' : result);
}

function validateHistoryProviderRows(
  rows: Array<Record<string, unknown>>,
  code: StockCode,
  start: IsoDate,
  end: IsoDate,
): void {
  const compactStart = compactDate(start);
  const compactEnd = compactDate(end);

  for (const row of rows) {
    if (row.ts_code !== code) {
      throw providerUnavailable('CODE_MISMATCH');
    }
    if (typeof row.trade_date !== 'string') {
      throw providerUnavailable('INVALID_SCHEMA');
    }
    if (row.trade_date < compactStart || row.trade_date > compactEnd) {
      throw providerUnavailable('DATE_RANGE_MISMATCH');
    }
  }
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

interface OptionalTableResult {
  table: TushareTable;
  permissionMissing: boolean;
}

interface OperatingCashMetric {
  value: number | null;
  availability: Availability<number>;
  announcedAt?: IsoDate;
}

function operatingCashToNetProfit(input: {
  incomeResult: OptionalTableResult;
  cashflowResult: OptionalTableResult;
  code: StockCode;
  period: string;
  cutoff: IsoDate;
}): OperatingCashMetric {
  if (input.incomeResult.permissionMissing) {
    return missingOperatingCashMetric('Income statement permission unavailable');
  }
  if (input.cashflowResult.permissionMissing) {
    return missingOperatingCashMetric('Cash-flow statement permission unavailable');
  }

  const incomeRows = optionalStatementRows(input.incomeResult.table, parseIncomeStatementRows);
  const cashflowRows = optionalStatementRows(
    input.cashflowResult.table,
    parseCashflowStatementRows,
  );
  const income = selectStatementRow(incomeRows, input.code, input.period, input.cutoff);
  if (income === undefined || incomeRows === undefined) {
    return missingOperatingCashMetric('Income statement is unavailable for the selected period');
  }
  const cashflow = selectStatementRow(cashflowRows, input.code, input.period, input.cutoff);
  if (cashflow === undefined || cashflowRows === undefined) {
    return missingOperatingCashMetric('Cash-flow statement is unavailable for the selected period');
  }
  if (income.n_income_attr_p === null) {
    return missingOperatingCashMetric(
      'Parent-attributable net profit is unavailable for the selected period',
    );
  }
  if (cashflow.n_cashflow_act === null) {
    return missingOperatingCashMetric('Operating cash flow is unavailable for the selected period');
  }
  if (income.n_income_attr_p === 0) {
    return missingOperatingCashMetric('Parent-attributable net profit is zero');
  }

  const value = cashflow.n_cashflow_act / income.n_income_attr_p;
  return {
    value,
    availability: { status: 'available', value },
    announcedAt: latestDate(providerDate(income.ann_date), providerDate(cashflow.ann_date)),
  };
}

function optionalStatementRows<T>(
  table: TushareTable,
  parse: (value: unknown) => T[],
): T[] | undefined {
  try {
    return parse(tableRecords(table));
  } catch {
    return undefined;
  }
}

function selectStatementRow<
  T extends {
    ts_code: string;
    ann_date: string;
    end_date: string;
    report_type: string;
    update_flag?: '0' | '1' | undefined;
  },
>(rows: T[] | undefined, code: StockCode, period: string, cutoff: IsoDate): T | undefined {
  const compactCutoff = compactDate(cutoff);
  return rows
    ?.filter(
      (row) =>
        row.ts_code === code &&
        row.end_date === period &&
        row.report_type === '1' &&
        row.ann_date <= compactCutoff,
    )
    .sort(
      (left, right) =>
        left.ann_date.localeCompare(right.ann_date) ||
        (left.update_flag ?? '0').localeCompare(right.update_flag ?? '0'),
    )
    .at(-1);
}

function missingOperatingCashMetric(reason: string): OperatingCashMetric {
  return { value: null, availability: { status: 'missing', reason } };
}

function providerDate(value: string): IsoDate {
  if (!/^\d{8}$/.test(value)) {
    throw providerUnavailable('INVALID_SCHEMA');
  }

  try {
    return isoDate(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`);
  } catch {
    throw providerUnavailable('INVALID_SCHEMA');
  }
}

function latestDate(left: IsoDate, right: IsoDate | undefined): IsoDate {
  return right === undefined || left >= right ? left : right;
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
