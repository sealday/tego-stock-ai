declare const stockCodeBrand: unique symbol;
declare const isoDateBrand: unique symbol;

export type StockCode = string & { readonly [stockCodeBrand]: 'StockCode' };
export type IsoDate = string & { readonly [isoDateBrand]: 'IsoDate' };

export type Availability<T> =
  | { status: 'available'; value: T }
  | { status: 'missing'; reason: string };

export type AvailabilityMap = Readonly<Record<string, Availability<unknown>>>;

export interface MarketEnvelope<T> {
  data: T;
  asOf: IsoDate;
  source: 'Tushare Pro';
  freshness: 'fresh' | 'stale';
  availability: AvailabilityMap;
  limitations: readonly string[];
}

export interface DailyPrice {
  code: StockCode;
  date: IsoDate;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeShares: number;
  turnoverCny: number;
  adjustmentFactor: number | null;
}

export interface StockSearchResult {
  code: StockCode;
  name: string;
  pinyinAbbreviation: string;
}

export interface StockOverview {
  code: StockCode;
  name: string;
  date: IsoDate;
  close: number;
  previousClose: number | null;
  changePercent: number | null;
  peTtm: number | null;
  pb: number | null;
  totalMarketValueCny: number | null;
}

export interface StockFundamentals {
  code: StockCode;
  date: IsoDate;
  roe: number | null;
  grossMargin: number | null;
  revenueGrowth: number | null;
  profitGrowth: number | null;
  operatingCashToNetProfit: number | null;
  debtToAssets: number | null;
}

const CANONICAL_STOCK_CODE = /^(\d{6})\.(SH|SZ|BJ)$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function stockCode(value: string): StockCode {
  const match = CANONICAL_STOCK_CODE.exec(value);
  const numericCode = match?.[1];
  const exchange = match?.[2];

  if (
    numericCode === undefined ||
    exchange === undefined ||
    exchangeFor(numericCode) !== exchange
  ) {
    throw new TypeError('Invalid A-share stock code');
  }

  return value as StockCode;
}

export function isoDate(value: string): IsoDate {
  const match = ISO_DATE.exec(value);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);

  if (!match || year < 1900 || year > 2100) {
    throw new TypeError('Invalid ISO date');
  }

  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    throw new TypeError('Invalid ISO date');
  }

  return value as IsoDate;
}

function exchangeFor(numericCode: string): 'SH' | 'SZ' | 'BJ' | undefined {
  if (/^(?:600|601|603|605|688|689)/.test(numericCode)) {
    return 'SH';
  }

  if (/^(?:000|001|002|003|300|301)/.test(numericCode)) {
    return 'SZ';
  }

  if (/^[489]/.test(numericCode)) {
    return 'BJ';
  }

  return undefined;
}
