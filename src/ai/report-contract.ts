import { z } from 'zod';

import { CALCULATION_VERSION, type ExplainableScore } from '../analysis/scores';
import type { StockWorkspaceState } from '../hooks/use-stock-workspace';

export const MAX_REPORT_CONTEXT_BYTES = 200 * 1024;

export const REPORT_SECTION_HEADINGS = [
  '数据摘要与截止日期',
  '技术结构与支持观察',
  '基本面、估值与财务质量',
  '多空情景',
  '关键风险与失效条件',
  '缺失信息与待研究问题',
  '数据来源与限制',
] as const;

export type ReportSectionHeading = (typeof REPORT_SECTION_HEADINGS)[number];

export const REPORT_SYSTEM_INSTRUCTION = `你是一个谨慎的 A 股研究助手。只可引用用户提供的结构化上下文，必须明确数据截止日期、来源、缺失信息和限制。
不得编造（must not invent）任何指标或事实，不得把缺失值推断为权威数据。
不得提供投资建议（investment advice）、买入（buy）或卖出（sell）指令、目标价（target price）、保证收益（guaranteed return）或类似承诺。
材料仅供研究与教育使用。严格使用用户指定的七个章节标题和顺序，不得添加其他章节。`;

const nullableMetric = z.number().finite().nullable();
const nonemptyString = z.string().trim().min(1);

const scoreSignalSchema = z.strictObject({
  score: nullableMetric,
  band: z.enum(['weak', 'mixed', 'constructive', 'strong']).nullable(),
  status: z.enum(['complete', 'partial', 'insufficient']),
  calculationVersion: nonemptyString,
  observations: z.array(nonemptyString),
  missingInputs: z.array(nonemptyString),
});

const reportMetricSchema = z.enum([
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
]);

const availabilitySchema = z.discriminatedUnion('status', [
  z.strictObject({ metric: reportMetricSchema, status: z.literal('available') }),
  z.strictObject({
    metric: reportMetricSchema,
    status: z.literal('missing'),
    reason: nonemptyString,
  }),
]);

const reportContextSchema = z.strictObject({
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
  cutoff: z.string().date(),
  source: nonemptyString,
  limitations: z.array(nonemptyString),
});

export type ReportContext = z.infer<typeof reportContextSchema>;

export interface ReportMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

export interface ReportSection {
  readonly heading: ReportSectionHeading;
  readonly content: string;
}

export function createWorkspaceReportContext(state: StockWorkspaceState): ReportContext | null {
  if (state.cutoff === null) {
    return null;
  }

  const overview = state.overview.status === 'success' ? state.overview.envelope : null;
  const fundamentals = state.fundamentals.status === 'success' ? state.fundamentals.envelope : null;
  const technical = state.analysis.technical;
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
  const trendSignal = reportSignal(state.analysis.trend, 'trendSource');
  const valuationSignal = reportSignal(state.analysis.valuation, 'valuationSource');
  const qualitySignal = reportSignal(state.analysis.quality, 'qualitySource');

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
    cutoff: state.cutoff,
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

export function createReportMessages(value: unknown): readonly ReportMessage[] {
  const context = validateReportContext(value);
  const requiredHeadings = REPORT_SECTION_HEADINGS.map((heading) => `## ${heading}`).join('\n');

  return [
    { role: 'system', content: REPORT_SYSTEM_INSTRUCTION },
    {
      role: 'user',
      content: `请根据下列结构化上下文生成研究报告。严格按以下标题和顺序输出，每节必须有内容：\n${requiredHeadings}\n\n结构化上下文：\n${JSON.stringify(context)}`,
    },
  ];
}

export function parseCompleteReport(text: string): readonly ReportSection[] {
  const sections: Array<{ heading: string; lines: string[] }> = [];
  const preamble: string[] = [];
  let current: { heading: string; lines: string[] } | undefined;

  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1];
    if (heading !== undefined) {
      current = { heading, lines: [] };
      sections.push(current);
    } else if (current === undefined) {
      if (line.trim().length > 0) {
        preamble.push(line);
      }
    } else {
      current.lines.push(line);
    }
  }

  if (preamble.length > 0 || sections.length !== REPORT_SECTION_HEADINGS.length) {
    throw new TypeError('Report must contain exactly the seven approved section headings');
  }

  return sections.map((section, index): ReportSection => {
    const expectedHeading = REPORT_SECTION_HEADINGS[index];
    if (expectedHeading === undefined || section.heading !== expectedHeading) {
      throw new TypeError('Report contains an unknown or out-of-order section heading');
    }
    const content = section.lines.join('\n').trim();
    if (content.length === 0) {
      throw new TypeError(`Report section is empty: ${expectedHeading}`);
    }
    return { heading: expectedHeading, content };
  });
}

function reportSignal(score: ExplainableScore | null, missingInput: string) {
  if (score === null) {
    return {
      score: null,
      band: null,
      status: 'insufficient' as const,
      calculationVersion: CALCULATION_VERSION,
      observations: [],
      missingInputs: [missingInput],
    };
  }
  return {
    score: score.score,
    band: score.band,
    status: score.status,
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
