import { useEffect, useMemo, useState } from 'react';

import { calculateTechnicalIndicators, type TechnicalIndicators } from '../analysis/indicators';
import {
  calculateQualityScore,
  calculateTrendScore,
  calculateValuationScore,
  type ExplainableScore,
} from '../analysis/scores';
import {
  isoDate,
  stockCode,
  type AvailabilityMap,
  type DailyPrice,
  type IsoDate,
  type MarketEnvelope,
  type MarketSnapshotStatus,
  type StockCode,
  type StockFundamentals,
  type StockOverview,
} from '../domain/stock';

export type WorkspaceFetchClient = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type WorkspaceResource<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'success'; readonly envelope: MarketEnvelope<T> }
  | { readonly status: 'error'; readonly message: string };

export type WorkspaceDataStatus = 'loading' | 'fresh' | 'stale' | 'partial' | 'error';

type WorkspaceResourceStatus =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | {
      readonly status: 'success';
      readonly envelope: { readonly freshness: MarketEnvelope<unknown>['freshness'] };
    };

export interface WorkspaceAnalysis {
  readonly technical: TechnicalIndicators | null;
  readonly trend: ExplainableScore;
  readonly quality: ExplainableScore;
  readonly valuation: ExplainableScore;
}

export interface StockWorkspaceState {
  readonly code: StockCode;
  readonly cutoff: IsoDate;
  readonly source: 'Tushare Pro';
  readonly freshness: MarketEnvelope<unknown>['freshness'];
  readonly dataStatus: WorkspaceDataStatus;
  readonly marketState: string;
  readonly lastSuccessfulAt?: string | undefined;
  readonly overview: WorkspaceResource<StockOverview>;
  readonly history: WorkspaceResource<readonly DailyPrice[]>;
  readonly fundamentals: WorkspaceResource<StockFundamentals>;
  readonly marketStatus: WorkspaceResource<MarketSnapshotStatus>;
  readonly analysis: WorkspaceAnalysis;
}

export interface UseStockWorkspaceOptions {
  readonly code: StockCode;
  readonly asOf: IsoDate;
  readonly fetchClient?: WorkspaceFetchClient | undefined;
  readonly now?: (() => Date) | undefined;
}

const SAFE_RESOURCE_ERROR = '该数据项暂时不可用，请稍后重试。';

export function useStockWorkspace({
  code,
  asOf,
  fetchClient = fetch,
  now = currentTime,
}: UseStockWorkspaceOptions): StockWorkspaceState {
  const [overview, setOverview] = useState<WorkspaceResource<StockOverview>>({ status: 'loading' });
  const [history, setHistory] = useState<WorkspaceResource<readonly DailyPrice[]>>({
    status: 'loading',
  });
  const [fundamentals, setFundamentals] = useState<WorkspaceResource<StockFundamentals>>({
    status: 'loading',
  });
  const [marketStatus, setMarketStatus] = useState<WorkspaceResource<MarketSnapshotStatus>>({
    status: 'loading',
  });

  useEffect(() => {
    const controller = new AbortController();
    const request = <T>(
      url: string,
      parse: (value: unknown) => MarketEnvelope<T>,
      write: (resource: WorkspaceResource<T>) => void,
    ) => {
      void fetchClient(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error('Workspace request failed');
          }
          const body: unknown = await response.json();
          return parse(body);
        })
        .then((envelope) => {
          if (!controller.signal.aborted) {
            write({ status: 'success', envelope });
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            write({ status: 'error', message: SAFE_RESOURCE_ERROR });
          }
        });
    };

    setOverview({ status: 'loading' });
    setHistory({ status: 'loading' });
    setFundamentals({ status: 'loading' });
    setMarketStatus({ status: 'loading' });

    const historyStart = previousYear(asOf);
    request(`/api/stocks/${code}/overview?asOf=${asOf}`, parseOverviewEnvelope, setOverview);
    request(
      `/api/stocks/${code}/history?start=${historyStart}&end=${asOf}&adjust=forward`,
      parseHistoryEnvelope,
      setHistory,
    );
    request(
      `/api/stocks/${code}/fundamentals?asOf=${asOf}`,
      parseFundamentalsEnvelope,
      setFundamentals,
    );
    request('/api/market/status', parseMarketStatusEnvelope, setMarketStatus);

    return () => controller.abort();
  }, [asOf, code, fetchClient]);

  const analysis = useMemo(
    () =>
      createWorkspaceAnalysis(
        history.status === 'success' ? history.envelope.data : [],
        overview.status === 'success' ? overview.envelope.data : null,
        fundamentals.status === 'success' ? fundamentals.envelope.data : null,
        asOf,
      ),
    [asOf, fundamentals, history, overview],
  );

  const hasStaleResource = [overview, history, fundamentals, marketStatus].some(
    (resource) => resource.status === 'success' && resource.envelope.freshness === 'stale',
  );
  const snapshot = marketStatus.status === 'success' ? marketStatus.envelope.data : undefined;
  const resources = [overview, history, fundamentals, marketStatus];

  return {
    code,
    cutoff: overview.status === 'success' ? overview.envelope.asOf : asOf,
    source: 'Tushare Pro',
    freshness: hasStaleResource || snapshot?.freshness === 'stale' ? 'stale' : 'fresh',
    dataStatus: aggregateWorkspaceDataStatus(resources),
    marketState: deriveMarketState(marketStatus, now()),
    ...(snapshot === undefined ? {} : { lastSuccessfulAt: snapshot.lastSuccessfulAt }),
    overview,
    history,
    fundamentals,
    marketStatus,
    analysis,
  };
}

export function aggregateWorkspaceDataStatus(
  resources: readonly WorkspaceResourceStatus[],
): WorkspaceDataStatus {
  if (
    resources.some(
      (resource) => resource.status === 'success' && resource.envelope.freshness === 'stale',
    )
  ) {
    return 'stale';
  }
  if (resources.some((resource) => resource.status === 'loading')) {
    return 'loading';
  }

  const successCount = resources.filter((resource) => resource.status === 'success').length;
  const errorCount = resources.filter((resource) => resource.status === 'error').length;
  if (successCount === 0 && errorCount > 0) {
    return 'error';
  }
  if (successCount > 0 && errorCount > 0) {
    return 'partial';
  }
  return 'fresh';
}

export function deriveMarketState(
  marketStatus: WorkspaceResource<MarketSnapshotStatus>,
  now: Date,
): string {
  if (marketStatus.status === 'loading') {
    return '市场状态加载中';
  }
  if (marketStatus.status === 'error' || Number.isNaN(now.valueOf())) {
    return '市场状态不可用';
  }

  const { envelope } = marketStatus;
  if (envelope.freshness === 'stale' || envelope.data.freshness === 'stale') {
    return '市场状态延迟';
  }

  const current = shanghaiTimeParts(now);
  const nextTradingDate = shanghaiTimeParts(new Date(envelope.data.nextExpectedCloseAt)).date;
  if (current.date === nextTradingDate) {
    const minutes = current.hour * 60 + current.minute;
    if (minutes < 9 * 60 + 30) {
      return '未开盘';
    }
    if (minutes < 11 * 60 + 30) {
      return '交易时段（非实时）';
    }
    if (minutes < 13 * 60) {
      return '午间休市';
    }
    if (minutes < 15 * 60) {
      return '交易时段（非实时）';
    }
    return '已收盘';
  }

  if (envelope.data.asOf === current.date) {
    return '已收盘';
  }
  return '休市';
}

export function formatShanghaiTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return value;
  }
  const parts = shanghaiTimeParts(date);
  return `${parts.date} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

function currentTime(): Date {
  return new Date();
}

function shanghaiTimeParts(date: Date): {
  readonly date: string;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
} {
  const values: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)) {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  }

  const year = values.year ?? '0000';
  const month = values.month ?? '00';
  const day = values.day ?? '00';
  return {
    date: `${year}-${month}-${day}`,
    hour: Number(values.hour ?? 0),
    minute: Number(values.minute ?? 0),
    second: Number(values.second ?? 0),
  };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function createWorkspaceAnalysis(
  history: readonly DailyPrice[],
  overview: StockOverview | null,
  fundamentals: StockFundamentals | null,
  cutoff: IsoDate,
): WorkspaceAnalysis {
  const sortedHistory = [...history].sort((left, right) => left.date.localeCompare(right.date));
  const closes = sortedHistory.map(({ close }) => close);
  const volumes = sortedHistory.map(({ volumeShares }) => volumeShares);
  const technical = closes.length === 0 ? null : calculateTechnicalIndicators({ closes, volumes });
  const latestIndex = closes.length - 1;
  const previousIndex = latestIndex - 1;

  return {
    technical,
    trend: calculateTrendScore(
      {
        close: closes[latestIndex] ?? null,
        ma20: seriesValue(technical?.sma20, latestIndex),
        ma60: seriesValue(technical?.sma60, latestIndex),
        previousMa20: seriesValue(technical?.sma20, previousIndex),
        macdHistogram: seriesValue(technical?.macd.histogram, latestIndex),
        volumeRatio20: seriesValue(technical?.volumeRatio20.values, latestIndex),
        dailyReturn: overview?.changePercent ?? null,
      },
      cutoff,
    ),
    quality: calculateQualityScore(
      {
        roe: fundamentals?.roe ?? null,
        grossMargin: fundamentals?.grossMargin ?? null,
        revenueGrowth: fundamentals?.revenueGrowth ?? null,
        profitGrowth: fundamentals?.profitGrowth ?? null,
        operatingCashToNetProfit: fundamentals?.operatingCashToNetProfit ?? null,
        debtToAssets: fundamentals?.debtToAssets ?? null,
      },
      cutoff,
    ),
    valuation: calculateValuationScore(
      {
        pe:
          overview?.peTtm === null || overview === null
            ? null
            : { current: overview.peTtm, reference: [] },
        pb:
          overview?.pb === null || overview === null
            ? null
            : { current: overview.pb, reference: [] },
        dividendYield: null,
      },
      cutoff,
    ),
  };
}

function seriesValue(values: readonly (number | null)[] | undefined, index: number): number | null {
  return index < 0 ? null : (values?.[index] ?? null);
}

function previousYear(value: IsoDate): IsoDate {
  const year = Number(value.slice(0, 4)) - 1;
  const monthAndDay = value.slice(4);
  if (monthAndDay === '-02-29') {
    return isoDate(`${year}-02-28`);
  }
  return isoDate(`${year}${monthAndDay}`);
}

function parseOverviewEnvelope(value: unknown): MarketEnvelope<StockOverview> {
  return parseEnvelope(value, (data) => {
    const record = readRecord(data, 'overview');
    return {
      code: stockCode(readString(record, 'code')),
      name: readString(record, 'name'),
      date: isoDate(readString(record, 'date')),
      close: readNumber(record, 'close'),
      previousClose: readNullableNumber(record, 'previousClose'),
      changePercent: readNullableNumber(record, 'changePercent'),
      peTtm: readNullableNumber(record, 'peTtm'),
      pb: readNullableNumber(record, 'pb'),
      totalMarketValueCny: readNullableNumber(record, 'totalMarketValueCny'),
    };
  });
}

function parseHistoryEnvelope(value: unknown): MarketEnvelope<readonly DailyPrice[]> {
  return parseEnvelope(value, (data) => {
    if (!Array.isArray(data)) {
      throw new TypeError('Invalid history');
    }
    return data.map((entry) => {
      const record = readRecord(entry, 'history row');
      return {
        code: stockCode(readString(record, 'code')),
        date: isoDate(readString(record, 'date')),
        open: readNumber(record, 'open'),
        high: readNumber(record, 'high'),
        low: readNumber(record, 'low'),
        close: readNumber(record, 'close'),
        volumeShares: readNumber(record, 'volumeShares'),
        turnoverCny: readNumber(record, 'turnoverCny'),
        adjustmentFactor: readNullableNumber(record, 'adjustmentFactor'),
      };
    });
  });
}

function parseFundamentalsEnvelope(value: unknown): MarketEnvelope<StockFundamentals> {
  return parseEnvelope(value, (data) => {
    const record = readRecord(data, 'fundamentals');
    return {
      code: stockCode(readString(record, 'code')),
      date: isoDate(readString(record, 'date')),
      roe: readNullableNumber(record, 'roe'),
      grossMargin: readNullableNumber(record, 'grossMargin'),
      revenueGrowth: readNullableNumber(record, 'revenueGrowth'),
      profitGrowth: readNullableNumber(record, 'profitGrowth'),
      operatingCashToNetProfit: readNullableNumber(record, 'operatingCashToNetProfit'),
      debtToAssets: readNullableNumber(record, 'debtToAssets'),
    };
  });
}

function parseMarketStatusEnvelope(value: unknown): MarketEnvelope<MarketSnapshotStatus> {
  return parseEnvelope(value, (data) => {
    const record = readRecord(data, 'market status');
    const freshness = readString(record, 'freshness');
    if (freshness !== 'fresh' && freshness !== 'stale') {
      throw new TypeError('Invalid market freshness');
    }
    return {
      asOf: isoDate(readString(record, 'asOf')),
      lastSuccessfulAt: readTimestamp(record, 'lastSuccessfulAt'),
      nextExpectedCloseAt: readTimestamp(record, 'nextExpectedCloseAt'),
      freshness,
    };
  });
}

function parseEnvelope<T>(value: unknown, parseData: (data: unknown) => T): MarketEnvelope<T> {
  const record = readRecord(value, 'market envelope');
  const source = readString(record, 'source');
  const freshness = readString(record, 'freshness');
  if (source !== 'Tushare Pro' || (freshness !== 'fresh' && freshness !== 'stale')) {
    throw new TypeError('Invalid market envelope metadata');
  }
  const limitations = record.limitations;
  if (!Array.isArray(limitations) || !limitations.every((item) => typeof item === 'string')) {
    throw new TypeError('Invalid market limitations');
  }
  return {
    data: parseData(record.data),
    asOf: isoDate(readString(record, 'asOf')),
    source,
    freshness,
    availability: parseAvailability(record.availability),
    limitations,
  };
}

function parseAvailability(value: unknown): AvailabilityMap {
  const record = readRecord(value, 'availability');
  const result: Record<string, AvailabilityMap[string]> = {};
  for (const [key, entry] of Object.entries(record)) {
    const availability = readRecord(entry, 'availability entry');
    if (availability.status === 'available' && 'value' in availability) {
      result[key] = { status: 'available', value: availability.value };
    } else if (availability.status === 'missing' && typeof availability.reason === 'string') {
      result[key] = { status: 'missing', reason: availability.reason };
    } else {
      throw new TypeError('Invalid availability entry');
    }
  }
  return result;
}

function readRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`Invalid ${name}`);
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new TypeError(`Invalid ${key}`);
  }
  return value;
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Invalid ${key}`);
  }
  return value;
}

function readNullableNumber(record: Record<string, unknown>, key: string): number | null {
  return record[key] === null ? null : readNumber(record, key);
}

function readTimestamp(record: Record<string, unknown>, key: string): string {
  const value = readString(record, key);
  if (Number.isNaN(Date.parse(value))) {
    throw new TypeError(`Invalid ${key}`);
  }
  return value;
}
