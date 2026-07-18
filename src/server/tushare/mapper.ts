import type {
  Availability,
  AvailabilityMap,
  DailyPrice,
  IsoDate,
  StockFundamentals,
  StockOverview,
  StockSearchResult,
} from '../../domain/stock';
import { isoDate, stockCode } from '../../domain/stock';
import { parseDailyRows, parseFundamentalRows, parseOverviewRows, parseStockRows } from './schemas';

export function mapDailyRows(value: unknown): DailyPrice[] {
  return parseDailyRows(value)
    .map((row) => ({
      code: stockCode(row.ts_code),
      date: providerDate(row.trade_date),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volumeShares: row.vol * 100,
      turnoverCny: row.amount * 1_000,
      adjustmentFactor: row.adj_factor ?? null,
    }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

export function mapStockRows(value: unknown): StockSearchResult[] {
  return parseStockRows(value)
    .filter((row) => row.list_status === 'L')
    .map((row) => ({
      code: stockCode(row.ts_code),
      name: row.name,
      pinyinAbbreviation: row.cnspell.toUpperCase(),
    }))
    .sort((left, right) => left.code.localeCompare(right.code));
}

export function mapFundamentalRows(
  value: unknown,
): Array<{ data: StockFundamentals; availability: AvailabilityMap; announcedAt: IsoDate }> {
  return parseFundamentalRows(value)
    .sort(
      (left, right) =>
        left.end_date.localeCompare(right.end_date) ||
        left.ann_date.localeCompare(right.ann_date) ||
        (left.update_flag ?? '0').localeCompare(right.update_flag ?? '0'),
    )
    .map((row) => {
      const roe = percentage(row.roe);
      const grossMargin = percentage(row.grossprofit_margin);
      const revenueGrowth = percentage(row.or_yoy);
      const profitGrowth = percentage(row.netprofit_yoy);
      const operatingCashToNetProfit = null;
      const debtToAssets = percentage(row.debt_to_assets);

      return {
        announcedAt: providerDate(row.ann_date),
        data: {
          code: stockCode(row.ts_code),
          date: providerDate(row.end_date),
          roe,
          grossMargin,
          revenueGrowth,
          profitGrowth,
          operatingCashToNetProfit,
          debtToAssets,
        },
        availability: {
          roe: availability(roe),
          grossMargin: availability(grossMargin),
          revenueGrowth: availability(revenueGrowth),
          profitGrowth: availability(profitGrowth),
          operatingCashToNetProfit: {
            status: 'missing',
            reason: 'Requires comparable cash-flow and net-profit statements',
          },
          debtToAssets: availability(debtToAssets),
        },
      };
    });
}

export function mapOverviewRows(value: unknown): {
  data: StockOverview;
  availability: AvailabilityMap;
} {
  const parsed = parseOverviewRows(value);
  const daily = parsed.daily[0];
  const stock = parsed.stocks[0];
  const valuation = parsed.valuation[0];

  if (daily === undefined || stock === undefined) {
    throw new TypeError('Provider overview is missing required rows');
  }

  if (
    stock.ts_code !== daily.ts_code ||
    (valuation !== undefined &&
      (valuation.ts_code !== daily.ts_code || valuation.trade_date !== daily.trade_date))
  ) {
    throw new TypeError('Provider overview rows do not align');
  }

  const peTtm = valuation?.pe_ttm ?? null;
  const pb = valuation?.pb ?? null;
  const totalMarketValueCny =
    valuation?.total_mv === null || valuation?.total_mv === undefined
      ? null
      : valuation.total_mv * 10_000;

  return {
    data: {
      code: stockCode(daily.ts_code),
      name: stock.name,
      date: providerDate(daily.trade_date),
      close: daily.close,
      previousClose: daily.pre_close,
      changePercent: daily.pct_chg,
      peTtm,
      pb,
      totalMarketValueCny,
    },
    availability: {
      previousClose: availability(daily.pre_close),
      changePercent: availability(daily.pct_chg),
      peTtm: availability(peTtm),
      pb: availability(pb),
      totalMarketValueCny: availability(totalMarketValueCny),
    },
  };
}

function providerDate(value: string) {
  if (!/^\d{8}$/.test(value)) {
    throw new TypeError('Invalid provider trading date');
  }

  return isoDate(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`);
}

function percentage(value: number | null): number | null {
  return value === null ? null : value / 100;
}

function availability(value: number | null): Availability<number> {
  return value === null
    ? { status: 'missing', reason: 'Provider field unavailable' }
    : { status: 'available', value };
}
