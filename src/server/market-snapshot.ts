import { z } from 'zod';

import { AppError, normalizeError, safeErrorMessage } from '../domain/errors';
import type {
  DailyMarketSnapshot,
  DailyPrice,
  IsoDate,
  MarketSnapshotStatus,
  StockSearchResult,
  TradingCalendarDay,
} from '../domain/stock';
import { isoDate, stockCode } from '../domain/stock';
import { MARKET_SNAPSHOT_KEY, type SafeSnapshotFailure, type SnapshotStore } from './cache';
import { createTushareClient, type TushareClient, type TushareTable } from './tushare/client';
import { mapDailyRows, mapStockRows } from './tushare/mapper';

export interface MarketSnapshotSource {
  loadStockDirectory(): Promise<readonly StockSearchResult[]>;
  loadTradingCalendar(input: {
    start: IsoDate;
    end: IsoDate;
  }): Promise<readonly TradingCalendarDay[]>;
  loadDailyClose(input: { date: IsoDate }): Promise<readonly DailyPrice[]>;
}

export function createTushareMarketSnapshotSource(client: TushareClient): MarketSnapshotSource {
  return {
    async loadStockDirectory() {
      const table = await client.query({
        apiName: 'stock_basic',
        params: { list_status: 'L' },
        fields: ['ts_code', 'name', 'cnspell', 'list_status'],
      });
      return mapProviderSnapshotRows(() => mapStockRows(tableRecords(table)));
    },

    async loadTradingCalendar(input) {
      const table = await client.query({
        apiName: 'trade_cal',
        params: {
          exchange: 'SSE',
          start_date: compactDate(input.start),
          end_date: compactDate(input.end),
        },
        fields: ['cal_date', 'is_open'],
      });
      return mapProviderSnapshotRows(() =>
        tableRecords(table)
          .map((row) => {
            if (typeof row.cal_date !== 'string' || (row.is_open !== '0' && row.is_open !== '1')) {
              throw new TypeError('Invalid provider trading calendar row');
            }
            return {
              date: providerDate(row.cal_date),
              isOpen: row.is_open === '1',
            };
          })
          .sort((left, right) => left.date.localeCompare(right.date)),
      );
    },

    async loadDailyClose(input) {
      const table = await client.query({
        apiName: 'daily',
        params: { trade_date: compactDate(input.date) },
        fields: ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'vol', 'amount'],
      });
      const rows = mapProviderSnapshotRows(() => mapDailyRows(tableRecords(table)));
      if (rows.some((row) => row.date !== input.date)) {
        throw unavailable('DAILY_DATE_MISMATCH');
      }
      return rows;
    },
  };
}

export function createTushareMarketSnapshotSourceFromEnvironment(): MarketSnapshotSource {
  return createTushareMarketSnapshotSource(
    createTushareClient({ token: process.env.TUSHARE_TOKEN ?? '' }),
  );
}

interface RefreshMarketSnapshotOptions {
  store: SnapshotStore;
  source: MarketSnapshotSource;
  now?: (() => Date) | undefined;
}

interface ReadMarketSnapshotOptions {
  store: SnapshotStore;
  now?: (() => Date) | undefined;
}

const isoTimestampSchema = z.string().datetime({ offset: true });
const stockSchema = z
  .object({
    code: z.string().transform((value) => stockCode(value)),
    name: z.string().min(1),
    pinyinAbbreviation: z.string().min(1),
  })
  .strict();
const calendarDaySchema = z
  .object({
    date: z.string().transform((value) => isoDate(value)),
    isOpen: z.boolean(),
  })
  .strict();
const dailyPriceSchema = z
  .object({
    code: z.string().transform((value) => stockCode(value)),
    date: z.string().transform((value) => isoDate(value)),
    open: z.number().finite().positive(),
    high: z.number().finite().positive(),
    low: z.number().finite().positive(),
    close: z.number().finite().positive(),
    volumeShares: z.number().finite().nonnegative(),
    turnoverCny: z.number().finite().nonnegative(),
    adjustmentFactor: z.number().finite().positive().nullable(),
  })
  .strict()
  .superRefine((row, context) => {
    if (row.high < Math.max(row.open, row.close, row.low)) {
      context.addIssue({ code: 'custom', path: ['high'], message: 'Invalid OHLC high' });
    }
    if (row.low > Math.min(row.open, row.close, row.high)) {
      context.addIssue({ code: 'custom', path: ['low'], message: 'Invalid OHLC low' });
    }
  });
const snapshotSchema = z
  .object({
    version: z.literal(1),
    asOf: z.string().transform((value) => isoDate(value)),
    lastSuccessfulAt: isoTimestampSchema,
    nextExpectedCloseAt: isoTimestampSchema,
    stockDirectory: z.array(stockSchema).min(1),
    tradingCalendar: z.array(calendarDaySchema).min(1),
    dailyClose: z.array(dailyPriceSchema).min(1),
    limitations: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .superRefine((snapshot, context) => {
    addDuplicateIssue(
      snapshot.stockDirectory.map((stock) => stock.code),
      'stockDirectory',
      context,
    );
    addDuplicateIssue(
      snapshot.tradingCalendar.map((day) => day.date),
      'tradingCalendar',
      context,
    );
    addDuplicateIssue(
      snapshot.dailyClose.map((row) => row.code),
      'dailyClose',
      context,
    );

    if (!isAscending(snapshot.tradingCalendar.map((day) => day.date))) {
      context.addIssue({
        code: 'custom',
        path: ['tradingCalendar'],
        message: 'Trading calendar must be sorted',
      });
    }
    if (!snapshot.tradingCalendar.some((day) => day.isOpen && day.date === snapshot.asOf)) {
      context.addIssue({
        code: 'custom',
        path: ['asOf'],
        message: 'Snapshot cutoff must be an open trading day',
      });
    }
    const nextTradingDate = snapshot.tradingCalendar.find(
      (day) => day.isOpen && day.date > snapshot.asOf,
    )?.date;
    if (
      nextTradingDate === undefined ||
      snapshot.nextExpectedCloseAt !== marketCloseTimestamp(nextTradingDate)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['nextExpectedCloseAt'],
        message: 'Freshness deadline must match the next open trading day',
      });
    }

    const directoryCodes = new Set(snapshot.stockDirectory.map((stock) => stock.code));
    for (const [index, row] of snapshot.dailyClose.entries()) {
      if (row.date !== snapshot.asOf) {
        context.addIssue({
          code: 'custom',
          path: ['dailyClose', index, 'date'],
          message: 'Daily close date must match the snapshot cutoff',
        });
      }
      if (!directoryCodes.has(row.code)) {
        context.addIssue({
          code: 'custom',
          path: ['dailyClose', index, 'code'],
          message: 'Daily close code must exist in the stock directory',
        });
      }
    }
  });

export async function refreshMarketSnapshot(
  options: RefreshMarketSnapshotOptions,
): Promise<DailyMarketSnapshot> {
  const now = (options.now ?? (() => new Date()))();

  try {
    const marketDate = chinaMarketDate(now);
    const calendarEnd = addDays(marketDate, 45);
    const [stockDirectory, tradingCalendar] = await Promise.all([
      options.source.loadStockDirectory(),
      options.source.loadTradingCalendar({ start: addDays(marketDate, -14), end: calendarEnd }),
    ]);
    const normalizedCalendar = [...tradingCalendar].sort((left, right) =>
      left.date.localeCompare(right.date),
    );
    const asOf = normalizedCalendar
      .filter((day) => day.isOpen && day.date <= marketDate)
      .at(-1)?.date;
    const nextTradingDate = normalizedCalendar.find(
      (day) => day.isOpen && day.date > marketDate,
    )?.date;
    if (asOf === undefined || nextTradingDate === undefined) {
      throw unavailable('CALENDAR_INCOMPLETE');
    }

    const dailyClose = await options.source.loadDailyClose({ date: asOf });
    const candidate = {
      version: 1 as const,
      asOf,
      lastSuccessfulAt: now.toISOString(),
      nextExpectedCloseAt: marketCloseTimestamp(nextTradingDate),
      stockDirectory: [...stockDirectory].sort((left, right) =>
        left.code.localeCompare(right.code),
      ),
      tradingCalendar: normalizedCalendar,
      dailyClose: [...dailyClose].sort((left, right) => left.code.localeCompare(right.code)),
      limitations: ['Daily-close data only; suspended stocks may not have a close row'],
    };
    const snapshot = parseSnapshot(candidate);

    await options.store.writeAtomically(MARKET_SNAPSHOT_KEY, snapshot);
    return snapshot;
  } catch (caught) {
    const error = normalizeError(caught);
    const failure: SafeSnapshotFailure = {
      code: error.code,
      message: safeErrorMessage(error.code),
      retryable: error.retryable,
      occurredAt: now.toISOString(),
    };
    await options.store.recordFailure(MARKET_SNAPSHOT_KEY, failure).catch(() => undefined);
    throw caught;
  }
}

export async function readMarketSnapshot(
  options: ReadMarketSnapshotOptions,
): Promise<MarketSnapshotStatus> {
  const stored = await options.store.read<DailyMarketSnapshot>(MARKET_SNAPSHOT_KEY);
  if (stored === null) {
    throw unavailable('SNAPSHOT_MISSING');
  }

  let snapshot: DailyMarketSnapshot;
  try {
    snapshot = parseSnapshot(stored);
  } catch {
    throw unavailable('SNAPSHOT_INVALID');
  }
  const now = (options.now ?? (() => new Date()))();

  return {
    asOf: snapshot.asOf,
    lastSuccessfulAt: snapshot.lastSuccessfulAt,
    nextExpectedCloseAt: snapshot.nextExpectedCloseAt,
    freshness: now.toISOString() <= snapshot.nextExpectedCloseAt ? 'fresh' : 'stale',
  };
}

function parseSnapshot(value: unknown): DailyMarketSnapshot {
  try {
    return snapshotSchema.parse(value);
  } catch (error) {
    throw unavailable('SNAPSHOT_VALIDATION', error);
  }
}

function addDuplicateIssue(
  values: readonly string[],
  path: string,
  context: z.RefinementCtx,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: 'custom', path: [path], message: 'Duplicate snapshot values' });
  }
}

function isAscending(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || value > values[index - 1]!);
}

function chinaMarketDate(value: Date): IsoDate {
  return isoDate(new Date(value.getTime() + 8 * 60 * 60 * 1_000).toISOString().slice(0, 10));
}

function addDays(value: IsoDate, days: number): IsoDate {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date.toISOString().slice(0, 10));
}

function marketCloseTimestamp(date: IsoDate): string {
  return `${date}T07:00:00.000Z`;
}

function compactDate(value: IsoDate): string {
  return value.replaceAll('-', '');
}

function providerDate(value: string): IsoDate {
  if (!/^\d{8}$/.test(value)) {
    throw new TypeError('Invalid provider date');
  }
  return isoDate(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`);
}

function tableRecords(table: TushareTable): Array<Record<string, unknown>> {
  if (new Set(table.fields).size !== table.fields.length) {
    throw unavailable('DUPLICATE_FIELDS');
  }

  return table.items.map((item) => {
    if (item.length !== table.fields.length) {
      throw unavailable('ROW_WIDTH');
    }
    return Object.fromEntries(table.fields.map((field, index) => [field, item[index]]));
  });
}

function mapProviderSnapshotRows<T>(map: () => T): T {
  try {
    return map();
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw unavailable('INVALID_SCHEMA', error);
  }
}

function unavailable(providerCode: string, cause?: unknown): AppError {
  return new AppError('PROVIDER_UNAVAILABLE', safeErrorMessage('PROVIDER_UNAVAILABLE'), {
    status: 503,
    retryable: true,
    providerCode,
    ...(cause === undefined ? {} : { cause }),
  });
}
