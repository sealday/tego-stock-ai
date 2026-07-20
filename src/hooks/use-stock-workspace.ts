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
  readonly trend: ExplainableScore | null;
  readonly quality: ExplainableScore | null;
  readonly valuation: ExplainableScore | null;
}

export interface StockWorkspaceState {
  readonly code: StockCode;
  readonly cutoff: IsoDate | null;
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

interface KeyedWorkspaceResource<T> {
  readonly key: string;
  readonly resource: WorkspaceResource<T>;
}

export function useStockWorkspace({
  code,
  asOf,
  fetchClient = fetch,
  now = currentTime,
}: UseStockWorkspaceOptions): StockWorkspaceState {
  const requestKey = `${code}:${asOf}`;
  const [overviewState, setOverview] = useState<KeyedWorkspaceResource<StockOverview>>(() => ({
    key: requestKey,
    resource: { status: 'loading' },
  }));
  const [historyState, setHistory] = useState<KeyedWorkspaceResource<readonly DailyPrice[]>>(
    () => ({ key: requestKey, resource: { status: 'loading' } }),
  );
  const [fundamentalsState, setFundamentals] = useState<KeyedWorkspaceResource<StockFundamentals>>(
    () => ({ key: requestKey, resource: { status: 'loading' } }),
  );
  const [marketStatus, setMarketStatus] = useState<WorkspaceResource<MarketSnapshotStatus>>({
    status: 'loading',
  });

  const overview = visibleResource(overviewState, requestKey);
  const history = visibleResource(historyState, requestKey);
  const fundamentals = visibleResource(fundamentalsState, requestKey);
  useEffect(() => {
    const controller = new AbortController();
    const request = <T>(
      url: string,
      parse: (value: unknown) => MarketEnvelope<T>,
      write: (resource: KeyedWorkspaceResource<T>) => void,
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
            write({ key: requestKey, resource: { status: 'success', envelope } });
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            write({
              key: requestKey,
              resource: { status: 'error', message: SAFE_RESOURCE_ERROR },
            });
          }
        });
    };

    const loading = { key: requestKey, resource: { status: 'loading' } } as const;
    setOverview(loading);
    setHistory(loading);
    setFundamentals(loading);

    const historyStart = previousYear(asOf);
    request(
      `/api/stocks/${code}/overview?asOf=${asOf}`,
      (value) => parseOverviewEnvelope(value, code, asOf),
      setOverview,
    );
    request(
      `/api/stocks/${code}/history?start=${historyStart}&end=${asOf}&adjust=forward`,
      (value) => parseHistoryEnvelope(value, code, historyStart, asOf),
      setHistory,
    );
    request(
      `/api/stocks/${code}/fundamentals?asOf=${asOf}`,
      (value) => parseFundamentalsEnvelope(value, code, asOf),
      setFundamentals,
    );

    return () => controller.abort();
  }, [asOf, code, fetchClient, requestKey]);

  useEffect(() => {
    const controller = new AbortController();
    setMarketStatus({ status: 'loading' });
    void fetchClient('/api/market/status', {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Workspace request failed');
        }
        const body: unknown = await response.json();
        return parseMarketStatusEnvelope(body);
      })
      .then((envelope) => {
        if (!controller.signal.aborted) {
          setMarketStatus({ status: 'success', envelope });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setMarketStatus({ status: 'error', message: SAFE_RESOURCE_ERROR });
        }
      });

    return () => controller.abort();
  }, [fetchClient]);

  const historyEnvelope = history.status === 'success' ? history.envelope : null;
  const overviewEnvelope = overview.status === 'success' ? overview.envelope : null;
  const fundamentalsEnvelope = fundamentals.status === 'success' ? fundamentals.envelope : null;
  const technical = useMemo(() => calculateWorkspaceTechnical(historyEnvelope), [historyEnvelope]);
  const trend = useMemo(
    () => calculateWorkspaceTrend(historyEnvelope, technical),
    [historyEnvelope, technical],
  );
  const quality = useMemo(
    () => calculateWorkspaceQuality(fundamentalsEnvelope),
    [fundamentalsEnvelope],
  );
  const valuation = useMemo(
    () => calculateWorkspaceValuation(overviewEnvelope),
    [overviewEnvelope],
  );
  const analysis = useMemo(
    () => ({ technical, trend, quality, valuation }),
    [quality, technical, trend, valuation],
  );

  const hasStaleResource = [overview, history, fundamentals, marketStatus].some(
    (resource) => resource.status === 'success' && resource.envelope.freshness === 'stale',
  );
  const snapshot = marketStatus.status === 'success' ? marketStatus.envelope.data : undefined;
  const resources = [overview, history, fundamentals, marketStatus];

  return {
    code,
    cutoff: earliestDataCutoff(overview, history, fundamentals),
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

function visibleResource<T>(
  state: KeyedWorkspaceResource<T>,
  requestKey: string,
): WorkspaceResource<T> {
  return state.key === requestKey ? state.resource : { status: 'loading' };
}

export function aggregateWorkspaceDataStatus(
  resources: readonly WorkspaceResourceStatus[],
): WorkspaceDataStatus {
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
  if (
    resources.some(
      (resource) => resource.status === 'success' && resource.envelope.freshness === 'stale',
    )
  ) {
    return 'stale';
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

export function toShanghaiIsoDate(value: Date): IsoDate {
  if (Number.isNaN(value.valueOf())) {
    throw new RangeError('A valid date is required');
  }
  return isoDate(shanghaiTimeParts(value).date);
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

export interface WorkspaceAnalysisSources {
  readonly history: MarketEnvelope<readonly DailyPrice[]> | null;
  readonly overview: MarketEnvelope<StockOverview> | null;
  readonly fundamentals: MarketEnvelope<StockFundamentals> | null;
}

export function createWorkspaceAnalysis({
  history,
  overview,
  fundamentals,
}: WorkspaceAnalysisSources): WorkspaceAnalysis {
  const technical = calculateWorkspaceTechnical(history);

  return {
    technical,
    trend: calculateWorkspaceTrend(history, technical),
    quality: calculateWorkspaceQuality(fundamentals),
    valuation: calculateWorkspaceValuation(overview),
  };
}

function calculateWorkspaceTechnical(
  history: MarketEnvelope<readonly DailyPrice[]> | null,
): TechnicalIndicators | null {
  const historyRows = history?.data ?? [];
  const sortedHistory = [...historyRows].sort((left, right) => left.date.localeCompare(right.date));
  const closes = sortedHistory.map(({ close }) => close);
  const volumes = sortedHistory.map(({ volumeShares }) => volumeShares);
  return closes.length === 0 ? null : calculateTechnicalIndicators({ closes, volumes });
}

function calculateWorkspaceTrend(
  history: MarketEnvelope<readonly DailyPrice[]> | null,
  technical: TechnicalIndicators | null,
): ExplainableScore | null {
  if (history === null) {
    return null;
  }
  const sortedHistory = [...history.data].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  const closes = sortedHistory.map(({ close }) => close);
  const latestIndex = closes.length - 1;
  const previousIndex = latestIndex - 1;
  const latestClose = closes[latestIndex];
  const previousClose = closes[previousIndex];

  return calculateTrendScore(
    {
      close: latestClose ?? null,
      ma20: seriesValue(technical?.sma20, latestIndex),
      ma60: seriesValue(technical?.sma60, latestIndex),
      previousMa20: seriesValue(technical?.sma20, previousIndex),
      macdHistogram: seriesValue(technical?.macd.histogram, latestIndex),
      volumeRatio20: seriesValue(technical?.volumeRatio20.values, latestIndex),
      dailyReturn:
        latestClose === undefined || previousClose === undefined
          ? null
          : latestClose / previousClose - 1,
    },
    history.asOf,
  );
}

function calculateWorkspaceQuality(
  fundamentals: MarketEnvelope<StockFundamentals> | null,
): ExplainableScore | null {
  return fundamentals === null
    ? null
    : calculateQualityScore(
        {
          roe: fundamentals.data.roe,
          grossMargin: fundamentals.data.grossMargin,
          revenueGrowth: fundamentals.data.revenueGrowth,
          profitGrowth: fundamentals.data.profitGrowth,
          operatingCashToNetProfit: fundamentals.data.operatingCashToNetProfit,
          debtToAssets: fundamentals.data.debtToAssets,
        },
        fundamentals.asOf,
      );
}

function calculateWorkspaceValuation(
  overview: MarketEnvelope<StockOverview> | null,
): ExplainableScore | null {
  return overview === null
    ? null
    : calculateValuationScore(
        {
          pe: overview.data.peTtm === null ? null : { current: overview.data.peTtm, reference: [] },
          pb: overview.data.pb === null ? null : { current: overview.data.pb, reference: [] },
          dividendYield: null,
        },
        overview.asOf,
      );
}

function earliestDataCutoff(
  overview: WorkspaceResource<StockOverview>,
  history: WorkspaceResource<readonly DailyPrice[]>,
  fundamentals: WorkspaceResource<StockFundamentals>,
): IsoDate | null {
  const dates = [overview, history, fundamentals]
    .flatMap((resource) => (resource.status === 'success' ? [resource.envelope.asOf] : []))
    .sort();
  return dates[0] ?? null;
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

function parseOverviewEnvelope(
  value: unknown,
  expectedCode: StockCode,
  requestedAsOf: IsoDate,
): MarketEnvelope<StockOverview> {
  const envelope = parseEnvelope<StockOverview>(value, (data) => {
    const record = readRecord(data, 'overview');
    const name = readString(record, 'name');
    const overview = {
      code: stockCode(readString(record, 'code')),
      name,
      date: isoDate(readString(record, 'date')),
      close: readNumber(record, 'close'),
      previousClose: readNullableNumber(record, 'previousClose'),
      changePercent: readNullableNumber(record, 'changePercent'),
      peTtm: readNullableNumber(record, 'peTtm'),
      pb: readNullableNumber(record, 'pb'),
      totalMarketValueCny: readNullableNumber(record, 'totalMarketValueCny'),
    };
    assertExpectedCode(overview.code, expectedCode);
    if (
      overview.name.trim().length === 0 ||
      overview.close <= 0 ||
      (overview.previousClose !== null && overview.previousClose <= 0) ||
      (overview.totalMarketValueCny !== null && overview.totalMarketValueCny < 0)
    ) {
      throw new TypeError('Invalid overview values');
    }
    return overview;
  });
  if (envelope.asOf > requestedAsOf || envelope.data.date !== envelope.asOf) {
    throw new TypeError('Invalid overview cutoff identity');
  }
  return envelope;
}

function parseHistoryEnvelope(
  value: unknown,
  expectedCode: StockCode,
  start: IsoDate,
  end: IsoDate,
): MarketEnvelope<readonly DailyPrice[]> {
  const envelope = parseEnvelope(value, (data) => {
    if (!Array.isArray(data)) {
      throw new TypeError('Invalid history');
    }
    const dates = new Set<IsoDate>();
    return data.map((entry) => {
      const record = readRecord(entry, 'history row');
      const row = {
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
      assertExpectedCode(row.code, expectedCode);
      if (
        row.open <= 0 ||
        row.high <= 0 ||
        row.low <= 0 ||
        row.close <= 0 ||
        row.high < Math.max(row.open, row.close) ||
        row.low > Math.min(row.open, row.close) ||
        row.high < row.low ||
        row.volumeShares < 0 ||
        row.turnoverCny < 0 ||
        (row.adjustmentFactor !== null && row.adjustmentFactor <= 0) ||
        row.date < start ||
        row.date > end ||
        dates.has(row.date)
      ) {
        throw new TypeError('Invalid history row values');
      }
      dates.add(row.date);
      return row;
    });
  });
  if (envelope.asOf < start || envelope.asOf > end) {
    throw new TypeError('Invalid history cutoff identity');
  }
  const dates = envelope.data.map(({ date }) => date);
  if (
    dates.some((date) => date > envelope.asOf) ||
    (dates.length > 0 &&
      dates.reduce((latest, date) => (date > latest ? date : latest)) !== envelope.asOf)
  ) {
    throw new TypeError('Invalid history cutoff identity');
  }
  return envelope;
}

function parseFundamentalsEnvelope(
  value: unknown,
  expectedCode: StockCode,
  requestedAsOf: IsoDate,
): MarketEnvelope<StockFundamentals> {
  const envelope = parseEnvelope(value, (data) => {
    const record = readRecord(data, 'fundamentals');
    const fundamentals = {
      code: stockCode(readString(record, 'code')),
      date: isoDate(readString(record, 'date')),
      roe: readNullableNumber(record, 'roe'),
      grossMargin: readNullableNumber(record, 'grossMargin'),
      revenueGrowth: readNullableNumber(record, 'revenueGrowth'),
      profitGrowth: readNullableNumber(record, 'profitGrowth'),
      operatingCashToNetProfit: readNullableNumber(record, 'operatingCashToNetProfit'),
      debtToAssets: readNullableNumber(record, 'debtToAssets'),
    };
    assertExpectedCode(fundamentals.code, expectedCode);
    return fundamentals;
  });
  if (envelope.asOf > requestedAsOf || envelope.data.date > envelope.asOf) {
    throw new TypeError('Invalid fundamentals cutoff identity');
  }
  return envelope;
}

function assertExpectedCode(actual: StockCode, expected: StockCode): void {
  if (actual !== expected) {
    throw new TypeError('Unexpected stock code');
  }
}

function parseMarketStatusEnvelope(value: unknown): MarketEnvelope<MarketSnapshotStatus> {
  const envelope = parseEnvelope<MarketSnapshotStatus>(value, (data) => {
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
  if (envelope.asOf !== envelope.data.asOf || envelope.freshness !== envelope.data.freshness) {
    throw new TypeError('Invalid market status identity');
  }
  return envelope;
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
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new TypeError(`Invalid ${key}`);
  }
  return value;
}
