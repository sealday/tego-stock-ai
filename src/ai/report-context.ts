import { z } from 'zod';

import { CALCULATION_VERSION, type ExplainableScore } from '../analysis/scores';
import type { StockWorkspaceState } from '../hooks/use-stock-workspace';

export const MAX_REPORT_CONTEXT_BYTES = 200 * 1024;

const nullableMetric = z.number().finite().nullable();
const nonemptyString = z.string().trim().min(1);
const freshnessSchema = z.enum(['fresh', 'stale']);

const scoreSignalSchema = z.strictObject({
  score: nullableMetric,
  band: z.enum(['weak', 'mixed', 'constructive', 'strong']).nullable(),
  status: z.enum(['complete', 'partial', 'insufficient']),
  cutoff: z.string().date().nullable(),
  calculationVersion: nonemptyString,
  observations: z.array(nonemptyString),
  missingInputs: z.array(nonemptyString),
});

export const REPORT_METRIC_IDS = [
  'close',
  'previousClose',
  'changePercent',
  'peTtm',
  'pb',
  'totalMarketValueCny',
  'roe',
  'grossMargin',
  'revenueGrowth',
  'profitGrowth',
  'operatingCashToNetProfit',
  'debtToAssets',
  'ma5',
  'ma20',
  'ma60',
  'rsi14',
  'macdHistogram',
  'volumeRatio20',
  'realizedVolatility20',
  'maximumDrawdown',
  'trendScore',
  'valuationScore',
  'qualityScore',
] as const;

export type ReportMetricId = (typeof REPORT_METRIC_IDS)[number];

const reportMetricSchema = z.enum(REPORT_METRIC_IDS);

const availabilitySchema = z.discriminatedUnion('status', [
  z.strictObject({ metric: reportMetricSchema, status: z.literal('available') }),
  z.strictObject({
    metric: reportMetricSchema,
    status: z.literal('missing'),
    reason: nonemptyString,
  }),
]);

const reportContextSchema = z
  .strictObject({
    version: z.literal(1),
    stock: z.strictObject({ code: nonemptyString, name: nonemptyString }),
    price: z.strictObject({
      close: nullableMetric,
      previousClose: nullableMetric,
      changePercent: nullableMetric,
    }),
    fundamentals: z.strictObject({
      peTtm: nullableMetric,
      pb: nullableMetric,
      totalMarketValueCny: nullableMetric,
      roe: nullableMetric,
      grossMargin: nullableMetric,
      revenueGrowth: nullableMetric,
      profitGrowth: nullableMetric,
      operatingCashToNetProfit: nullableMetric,
      debtToAssets: nullableMetric,
    }),
    technical: z.strictObject({
      ma5: nullableMetric,
      ma20: nullableMetric,
      ma60: nullableMetric,
      rsi14: nullableMetric,
      macdHistogram: nullableMetric,
      volumeRatio20: nullableMetric,
      realizedVolatility20: nullableMetric,
      maximumDrawdown: nullableMetric,
    }),
    signals: z.strictObject({
      trend: scoreSignalSchema,
      valuation: scoreSignalSchema,
      quality: scoreSignalSchema,
    }),
    availability: z.array(availabilitySchema).superRefine((items, context) => {
      const metrics = new Set<string>();
      for (const [index, item] of items.entries()) {
        if (metrics.has(item.metric)) {
          context.addIssue({
            code: 'custom',
            message: `Duplicate availability metric: ${item.metric}`,
            path: [index, 'metric'],
          });
        }
        metrics.add(item.metric);
      }
    }),
    cutoffs: z.strictObject({
      overview: z.string().date().nullable(),
      history: z.string().date().nullable(),
      fundamentals: z.string().date().nullable(),
      trend: z.string().date().nullable(),
      valuation: z.string().date().nullable(),
      quality: z.string().date().nullable(),
    }),
    cutoff: z.string().date(),
    freshness: z.strictObject({
      workspace: freshnessSchema,
      overview: freshnessSchema.nullable(),
      history: freshnessSchema.nullable(),
      fundamentals: freshnessSchema.nullable(),
      marketStatus: freshnessSchema.nullable(),
    }),
    source: nonemptyString,
    limitations: z.array(nonemptyString),
  })
  .superRefine((value, context) => {
    const availabilityByMetric = new Map(
      value.availability.map((item) => [item.metric, item] as const),
    );
    for (const metric of REPORT_METRIC_IDS) {
      const availability = availabilityByMetric.get(metric);
      if (availability === undefined) {
        context.addIssue({
          code: 'custom',
          message: `Missing availability metric: ${metric}`,
          path: ['availability'],
        });
        continue;
      }
      const metricValue = normalizedMetricValue(value, metric);
      if (metricValue === null && availability.status !== 'missing') {
        context.addIssue({
          code: 'custom',
          message: `Availability must be missing for null metric: ${metric}`,
          path: ['availability'],
        });
      } else if (metricValue !== null && availability.status !== 'available') {
        context.addIssue({
          code: 'custom',
          message: `Availability must be available for non-null metric: ${metric}`,
          path: ['availability'],
        });
      }
    }

    for (const signal of ['trend', 'valuation', 'quality'] as const) {
      if (value.signals[signal].cutoff !== value.cutoffs[signal]) {
        context.addIssue({
          code: 'custom',
          message: `Signal cutoff must match cutoffs.${signal}`,
          path: ['signals', signal, 'cutoff'],
        });
      }
    }

    const resourceMetrics = {
      overview: [
        ...Object.values(value.price),
        value.fundamentals.peTtm,
        value.fundamentals.pb,
        value.fundamentals.totalMarketValueCny,
      ],
      history: Object.values(value.technical),
      fundamentals: [
        value.fundamentals.roe,
        value.fundamentals.grossMargin,
        value.fundamentals.revenueGrowth,
        value.fundamentals.profitGrowth,
        value.fundamentals.operatingCashToNetProfit,
        value.fundamentals.debtToAssets,
      ],
    } as const;
    for (const resource of ['overview', 'history', 'fundamentals'] as const) {
      if (
        resourceMetrics[resource].some((metric) => metric !== null) &&
        value.cutoffs[resource] === null
      ) {
        context.addIssue({
          code: 'custom',
          message: `Populated ${resource} metrics require their resource cutoff`,
          path: ['cutoffs', resource],
        });
      }
    }

    const signalResources = {
      trend: 'history',
      valuation: 'overview',
      quality: 'fundamentals',
    } as const;
    for (const signal of ['trend', 'valuation', 'quality'] as const) {
      const resource = signalResources[signal];
      const signalCutoff = value.signals[signal].cutoff;
      if (signalCutoff !== null && signalCutoff !== value.cutoffs[resource]) {
        context.addIssue({
          code: 'custom',
          message: `${signal} signal cutoff must equal the ${resource} resource cutoff`,
          path: ['signals', signal, 'cutoff'],
        });
      }
      if (value.signals[signal].score !== null && signalCutoff === null) {
        context.addIssue({
          code: 'custom',
          message: `Populated ${signal} signal requires a resource cutoff`,
          path: ['signals', signal, 'cutoff'],
        });
      }
    }

    const includedCutoffs = Object.values(value.cutoffs).filter(
      (cutoff): cutoff is string => cutoff !== null,
    );
    const latestCutoff = [...includedCutoffs].sort().at(-1);
    if (latestCutoff === undefined || value.cutoff !== latestCutoff) {
      context.addIssue({
        code: 'custom',
        message: 'Top-level cutoff must equal the latest included source or signal cutoff',
        path: ['cutoff'],
      });
    }
  });

export type ReportContext = z.infer<typeof reportContextSchema>;

export function createWorkspaceReportContext(state: StockWorkspaceState): ReportContext | null {
  const overview = state.overview.status === 'success' ? state.overview.envelope : null;
  const history = state.history.status === 'success' ? state.history.envelope : null;
  const fundamentals = state.fundamentals.status === 'success' ? state.fundamentals.envelope : null;
  const technical = history === null ? null : state.analysis.technical;
  const price = {
    close: overview?.data.close ?? null,
    previousClose: overview?.data.previousClose ?? null,
    changePercent: overview?.data.changePercent ?? null,
  };
  const fundamentalValues = {
    peTtm: overview?.data.peTtm ?? null,
    pb: overview?.data.pb ?? null,
    totalMarketValueCny: overview?.data.totalMarketValueCny ?? null,
    roe: fundamentals?.data.roe ?? null,
    grossMargin: fundamentals?.data.grossMargin ?? null,
    revenueGrowth: fundamentals?.data.revenueGrowth ?? null,
    profitGrowth: fundamentals?.data.profitGrowth ?? null,
    operatingCashToNetProfit: fundamentals?.data.operatingCashToNetProfit ?? null,
    debtToAssets: fundamentals?.data.debtToAssets ?? null,
  };
  const technicalValues = {
    ma5: latestSeriesValue(technical?.sma5),
    ma20: latestSeriesValue(technical?.sma20),
    ma60: latestSeriesValue(technical?.sma60),
    rsi14: latestSeriesValue(technical?.rsi14),
    macdHistogram: latestSeriesValue(technical?.macd.histogram),
    volumeRatio20: latestSeriesValue(technical?.volumeRatio20.values),
    realizedVolatility20: latestSeriesValue(technical?.realizedVolatility20),
    maximumDrawdown: technical?.drawdown.maximum ?? null,
  };
  const trendSignal = reportSignal(state.analysis.trend, 'trendSource', history?.asOf ?? null);
  const valuationSignal = reportSignal(
    state.analysis.valuation,
    'valuationSource',
    overview?.asOf ?? null,
  );
  const qualitySignal = reportSignal(
    state.analysis.quality,
    'qualitySource',
    fundamentals?.asOf ?? null,
  );
  const cutoffs = {
    overview: overview?.asOf ?? null,
    history: history?.asOf ?? null,
    fundamentals: fundamentals?.asOf ?? null,
    trend: trendSignal.cutoff,
    valuation: valuationSignal.cutoff,
    quality: qualitySignal.cutoff,
  };
  const includedCutoffs: string[] = Object.values(cutoffs).flatMap((value) =>
    value === null ? [] : [value],
  );
  const cutoff = includedCutoffs.sort().at(-1);
  if (cutoff === undefined) {
    return null;
  }

  const context: ReportContext = {
    version: 1,
    stock: {
      code: state.code,
      name: overview?.data.name ?? state.code,
    },
    price,
    fundamentals: fundamentalValues,
    technical: technicalValues,
    signals: {
      trend: trendSignal,
      valuation: valuationSignal,
      quality: qualitySignal,
    },
    availability: [
      reportAvailability('close', price.close, overviewReason(state, 'close')),
      reportAvailability(
        'previousClose',
        price.previousClose,
        overviewReason(state, 'previousClose'),
      ),
      reportAvailability(
        'changePercent',
        price.changePercent,
        overviewReason(state, 'changePercent'),
      ),
      reportAvailability('peTtm', fundamentalValues.peTtm, overviewReason(state, 'peTtm')),
      reportAvailability('pb', fundamentalValues.pb, overviewReason(state, 'pb')),
      reportAvailability(
        'totalMarketValueCny',
        fundamentalValues.totalMarketValueCny,
        overviewReason(state, 'totalMarketValueCny'),
      ),
      reportAvailability('roe', fundamentalValues.roe, fundamentalsReason(state, 'roe')),
      reportAvailability(
        'grossMargin',
        fundamentalValues.grossMargin,
        fundamentalsReason(state, 'grossMargin'),
      ),
      reportAvailability(
        'revenueGrowth',
        fundamentalValues.revenueGrowth,
        fundamentalsReason(state, 'revenueGrowth'),
      ),
      reportAvailability(
        'profitGrowth',
        fundamentalValues.profitGrowth,
        fundamentalsReason(state, 'profitGrowth'),
      ),
      reportAvailability(
        'operatingCashToNetProfit',
        fundamentalValues.operatingCashToNetProfit,
        fundamentalsReason(state, 'operatingCashToNetProfit'),
      ),
      reportAvailability(
        'debtToAssets',
        fundamentalValues.debtToAssets,
        fundamentalsReason(state, 'debtToAssets'),
      ),
      reportAvailability('ma5', technicalValues.ma5, technicalReason(state, 'MA5')),
      reportAvailability('ma20', technicalValues.ma20, technicalReason(state, 'MA20')),
      reportAvailability('ma60', technicalValues.ma60, technicalReason(state, 'MA60')),
      reportAvailability('rsi14', technicalValues.rsi14, technicalReason(state, 'RSI14')),
      reportAvailability(
        'macdHistogram',
        technicalValues.macdHistogram,
        technicalReason(state, 'MACD histogram'),
      ),
      reportAvailability(
        'volumeRatio20',
        technicalValues.volumeRatio20,
        technicalReason(state, '20-day volume ratio'),
      ),
      reportAvailability(
        'realizedVolatility20',
        technicalValues.realizedVolatility20,
        technicalReason(state, '20-day realized volatility'),
      ),
      reportAvailability(
        'maximumDrawdown',
        technicalValues.maximumDrawdown,
        technicalReason(state, 'maximum drawdown'),
      ),
      reportAvailability('trendScore', trendSignal.score, '趋势评分输入不足'),
      reportAvailability('valuationScore', valuationSignal.score, '估值评分参考样本不足'),
      reportAvailability('qualityScore', qualitySignal.score, '财务质量评分输入不足'),
    ],
    cutoffs,
    cutoff,
    freshness: {
      workspace: state.freshness,
      overview: overview?.freshness ?? null,
      history: history?.freshness ?? null,
      fundamentals: fundamentals?.freshness ?? null,
      marketStatus:
        state.marketStatus.status === 'success' ? state.marketStatus.envelope.freshness : null,
    },
    source: state.source,
    limitations: [
      ...workspaceLimitations(state),
      '历史日线收盘口径，不是实时行情',
      '材料仅供研究与教育使用，不构成投资建议',
    ].filter((limitation, index, all) => all.indexOf(limitation) === index),
  };

  return validateReportContext(context);
}

export function validateReportContext(value: unknown): ReportContext {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError('Report context must be JSON serializable');
  }

  const byteLength = new TextEncoder().encode(serialized).byteLength;
  if (byteLength > MAX_REPORT_CONTEXT_BYTES) {
    throw new RangeError('Report context exceeds the 200 KB UTF-8 limit');
  }

  return reportContextSchema.parse(value);
}

function reportSignal(
  score: ExplainableScore | null,
  missingInput: string,
  resourceCutoff: string | null,
) {
  if (score === null || resourceCutoff === null || score.cutoff !== resourceCutoff) {
    return {
      score: null,
      band: null,
      status: 'insufficient' as const,
      cutoff: null,
      calculationVersion: CALCULATION_VERSION,
      observations: [],
      missingInputs: [missingInput],
    };
  }
  return {
    score: score.score,
    band: score.band,
    status: score.status,
    cutoff: score.cutoff,
    calculationVersion: score.calculationVersion,
    observations: score.observations.map(
      (observation) => `${observation.label}: ${JSON.stringify(observation.raw)}`,
    ),
    missingInputs: [...score.missingInputs],
  };
}

function reportAvailability(
  metric: ReportContext['availability'][number]['metric'],
  value: number | null,
  reason: string,
): ReportContext['availability'][number] {
  return value === null ? { metric, status: 'missing', reason } : { metric, status: 'available' };
}

function overviewReason(state: StockWorkspaceState, metric: string): string {
  if (state.overview.status !== 'success') {
    return state.overview.status === 'loading' ? '行情数据加载中' : state.overview.message;
  }
  const availability = state.overview.envelope.availability[metric];
  return availability?.status === 'missing' ? availability.reason : '行情数据源未提供该指标';
}

function fundamentalsReason(state: StockWorkspaceState, metric: string): string {
  if (state.fundamentals.status !== 'success') {
    return state.fundamentals.status === 'loading'
      ? '基本面数据加载中'
      : state.fundamentals.message;
  }
  const availability = state.fundamentals.envelope.availability[metric];
  return availability?.status === 'missing' ? availability.reason : '基本面数据源未提供该指标';
}

function technicalReason(state: StockWorkspaceState, metric: string): string {
  if (state.history.status !== 'success') {
    return state.history.status === 'loading' ? '历史数据加载中' : state.history.message;
  }
  return `${metric} 所需历史样本不足`;
}

function latestSeriesValue(series: readonly (number | null)[] | undefined): number | null {
  return series?.at(-1) ?? null;
}

function workspaceLimitations(state: StockWorkspaceState): readonly string[] {
  return [state.overview, state.history, state.fundamentals, state.marketStatus]
    .flatMap((resource) =>
      resource.status === 'success' ? [...resource.envelope.limitations] : [],
    )
    .filter((limitation, index, all) => all.indexOf(limitation) === index);
}

function normalizedMetricValue(
  context: z.infer<typeof reportContextSchema>,
  metric: ReportMetricId,
): number | null {
  if (metric in context.price) {
    return context.price[metric as keyof typeof context.price];
  }
  if (metric in context.fundamentals) {
    return context.fundamentals[metric as keyof typeof context.fundamentals];
  }
  if (metric in context.technical) {
    return context.technical[metric as keyof typeof context.technical];
  }
  if (metric === 'trendScore') {
    return context.signals.trend.score;
  }
  if (metric === 'valuationScore') {
    return context.signals.valuation.score;
  }
  return context.signals.quality.score;
}
