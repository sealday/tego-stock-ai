import { describe, expect, it } from 'vitest';

import {
  MAX_REPORT_CONTEXT_BYTES,
  REPORT_SECTION_HEADINGS,
  REPORT_SYSTEM_INSTRUCTION,
  createIncrementalReportParser,
  createReportMessages,
  createWorkspaceReportContext,
  parseCompleteReport,
  validateReportContext,
  type ReportContext,
} from '../../src/ai/report-contract';
import {
  isoDate,
  stockCode,
  type DailyPrice,
  type MarketEnvelope,
  type StockFundamentals,
  type StockOverview,
} from '../../src/domain/stock';
import {
  createWorkspaceAnalysis,
  type StockWorkspaceState,
} from '../../src/hooks/use-stock-workspace';

function validContext(): ReportContext {
  return {
    version: 1,
    stock: { code: '600519.SH', name: '贵州茅台' },
    price: {
      close: 1430.4,
      previousClose: 1420,
      changePercent: 0.7324,
    },
    fundamentals: {
      peTtm: null,
      pb: 8.1,
      totalMarketValueCny: 1_796_000_000_000,
      roe: 0.31,
      grossMargin: 0.91,
      revenueGrowth: null,
      profitGrowth: 0.16,
      operatingCashToNetProfit: 1.08,
      debtToAssets: 0.12,
    },
    technical: {
      ma5: 1421.2,
      ma20: 1388.6,
      ma60: 1340.1,
      rsi14: 61.4,
      macdHistogram: 2.31,
      volumeRatio20: 1.08,
      realizedVolatility20: 0.19,
      maximumDrawdown: -0.12,
    },
    signals: {
      trend: {
        score: 78.2,
        band: 'constructive',
        status: 'complete',
        cutoff: '2026-07-16',
        calculationVersion: '1.0.0',
        observations: ['收盘价高于 MA20 与 MA60'],
        missingInputs: [],
      },
      valuation: {
        score: null,
        band: null,
        status: 'insufficient',
        cutoff: '2026-07-17',
        calculationVersion: '1.0.0',
        observations: [],
        missingInputs: ['pe', 'dividendYield'],
      },
      quality: {
        score: 82,
        band: 'strong',
        status: 'partial',
        cutoff: '2026-07-15',
        calculationVersion: '1.0.0',
        observations: ['ROE 与毛利率可用'],
        missingInputs: ['revenueGrowth'],
      },
    },
    availability: completeAvailability(),
    cutoffs: {
      overview: '2026-07-17',
      history: '2026-07-16',
      fundamentals: '2026-07-15',
      trend: '2026-07-16',
      valuation: '2026-07-17',
      quality: '2026-07-15',
    },
    cutoff: '2026-07-17',
    freshness: {
      workspace: 'stale',
      overview: 'stale',
      history: 'fresh',
      fundamentals: 'fresh',
      marketStatus: 'stale',
    },
    source: 'Tushare Pro',
    limitations: ['仅包含历史日线收盘数据', '估值参考样本不足'],
  };
}

function completeAvailability(): ReportContext['availability'] {
  return [
    { metric: 'close', status: 'available' },
    { metric: 'previousClose', status: 'available' },
    { metric: 'changePercent', status: 'available' },
    { metric: 'peTtm', status: 'missing', reason: '当前权限未返回市盈率' },
    { metric: 'pb', status: 'available' },
    { metric: 'totalMarketValueCny', status: 'available' },
    { metric: 'roe', status: 'available' },
    { metric: 'grossMargin', status: 'available' },
    { metric: 'revenueGrowth', status: 'missing', reason: '当前报告期未披露营收增长' },
    { metric: 'profitGrowth', status: 'available' },
    { metric: 'operatingCashToNetProfit', status: 'available' },
    { metric: 'debtToAssets', status: 'available' },
    { metric: 'ma5', status: 'available' },
    { metric: 'ma20', status: 'available' },
    { metric: 'ma60', status: 'available' },
    { metric: 'rsi14', status: 'available' },
    { metric: 'macdHistogram', status: 'available' },
    { metric: 'volumeRatio20', status: 'available' },
    { metric: 'realizedVolatility20', status: 'available' },
    { metric: 'maximumDrawdown', status: 'available' },
    { metric: 'trendScore', status: 'available' },
    { metric: 'valuationScore', status: 'missing', reason: '估值评分参考样本不足' },
    { metric: 'qualityScore', status: 'available' },
  ];
}

function envelope<T>(data: T, asOf: string): MarketEnvelope<T> {
  return {
    data,
    asOf: isoDate(asOf),
    source: 'Tushare Pro',
    freshness: 'fresh',
    availability: {},
    limitations: [`${asOf} fixture`],
  };
}

function mixedDateWorkspaceState(): StockWorkspaceState {
  const code = stockCode('600519.SH');
  const overview = envelope<StockOverview>(
    {
      code,
      name: '贵州茅台',
      date: isoDate('2026-07-17'),
      close: 1430.4,
      previousClose: 1420,
      changePercent: 0.7324,
      peTtm: 24.6,
      pb: 8.1,
      totalMarketValueCny: 1_796_000_000_000,
    },
    '2026-07-17',
  );
  const history = envelope<readonly DailyPrice[]>(
    [
      {
        code,
        date: isoDate('2026-07-16'),
        open: 1410,
        high: 1435,
        low: 1400,
        close: 1420,
        volumeShares: 2_000_000,
        turnoverCny: 2_800_000_000,
        adjustmentFactor: 1,
      },
    ],
    '2026-07-16',
  );
  const fundamentals = envelope<StockFundamentals>(
    {
      code,
      date: isoDate('2026-07-15'),
      roe: 0.31,
      grossMargin: 0.91,
      revenueGrowth: 0.12,
      profitGrowth: 0.16,
      operatingCashToNetProfit: 1.08,
      debtToAssets: 0.12,
    },
    '2026-07-15',
  );

  return {
    code,
    cutoff: isoDate('2026-07-15'),
    source: 'Tushare Pro',
    freshness: 'fresh',
    dataStatus: 'fresh',
    marketState: '已收盘',
    overview: { status: 'success', envelope: overview },
    history: { status: 'success', envelope: history },
    fundamentals: { status: 'success', envelope: fundamentals },
    marketStatus: { status: 'loading' },
    analysis: createWorkspaceAnalysis({ overview, history, fundamentals }),
  };
}

function completeReport(): string {
  return REPORT_SECTION_HEADINGS.map(
    (heading, index) => `## ${heading}\n第 ${index + 1} 节仅引用提供的数据。`,
  ).join('\n\n');
}

describe('report context contract', () => {
  it('accepts bounded normalized values, deterministic signals, availability, and provenance', () => {
    const context = validateReportContext(validContext());
    const messages = createReportMessages(context);

    expect(context.price.close).toBe(1430.4);
    expect(context.fundamentals.roe).toBe(0.31);
    expect(context.signals.trend.score).toBe(78.2);
    expect(context.signals.trend.cutoff).toBe('2026-07-16');
    expect(context.availability).toContainEqual({
      metric: 'peTtm',
      status: 'missing',
      reason: '当前权限未返回市盈率',
    });
    expect(context.cutoff).toBe('2026-07-17');
    expect(context.cutoffs).toEqual({
      overview: '2026-07-17',
      history: '2026-07-16',
      fundamentals: '2026-07-15',
      trend: '2026-07-16',
      valuation: '2026-07-17',
      quality: '2026-07-15',
    });
    expect(context.freshness).toEqual({
      workspace: 'stale',
      overview: 'stale',
      history: 'fresh',
      fundamentals: 'fresh',
      marketStatus: 'stale',
    });
    expect(context.source).toBe('Tushare Pro');
    expect(context.limitations).toContain('仅包含历史日线收盘数据');
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toContain('"close":1430.4');
    expect(messages[1]?.content).toContain('"history":"2026-07-16"');
    expect(messages[1]?.content).toContain('"workspace":"stale"');
  });

  it('preserves mixed source and score cutoffs and uses the latest authoritative date', () => {
    const context = createWorkspaceReportContext(mixedDateWorkspaceState());

    expect(context?.cutoff).toBe('2026-07-17');
    expect(context?.cutoffs).toEqual({
      overview: '2026-07-17',
      history: '2026-07-16',
      fundamentals: '2026-07-15',
      trend: '2026-07-16',
      valuation: '2026-07-17',
      quality: '2026-07-15',
    });
    expect(context?.signals.trend.cutoff).toBe('2026-07-16');
    expect(context?.signals.valuation.cutoff).toBe('2026-07-17');
    expect(context?.signals.quality.cutoff).toBe('2026-07-15');
    expect(context?.freshness).toEqual({
      workspace: 'fresh',
      overview: 'fresh',
      history: 'fresh',
      fundamentals: 'fresh',
      marketStatus: null,
    });
  });

  it('drops metrics and signals when their source resource is unavailable', () => {
    const state = mixedDateWorkspaceState();
    const context = createWorkspaceReportContext({
      ...state,
      history: { status: 'error', message: '历史不可用' },
      fundamentals: { status: 'error', message: '基本面不可用' },
    });

    expect(context?.cutoffs.history).toBeNull();
    expect(context?.technical).toEqual({
      ma5: null,
      ma20: null,
      ma60: null,
      rsi14: null,
      macdHistogram: null,
      volumeRatio20: null,
      realizedVolatility20: null,
      maximumDrawdown: null,
    });
    expect(context?.signals.trend).toMatchObject({ score: null, cutoff: null });
    expect(context?.cutoffs.fundamentals).toBeNull();
    expect(context?.fundamentals.roe).toBeNull();
    expect(context?.signals.quality).toMatchObject({ score: null, cutoff: null });
  });

  it('drops a signal whose cutoff does not match its available source resource', () => {
    const state = mixedDateWorkspaceState();
    const context = createWorkspaceReportContext({
      ...state,
      analysis: {
        ...state.analysis,
        trend:
          state.analysis.trend === null
            ? null
            : { ...state.analysis.trend, cutoff: isoDate('2026-07-14') },
      },
    });

    expect(context?.cutoffs.history).toBe('2026-07-16');
    expect(context?.signals.trend).toMatchObject({
      score: null,
      status: 'insufficient',
      cutoff: null,
    });
    expect(context?.cutoffs.trend).toBeNull();
  });

  it.each([
    ['overview', { overview: null }],
    ['history', { history: null }],
    ['fundamentals', { fundamentals: null }],
  ] as const)(
    'requires a %s cutoff when its normalized metrics are populated',
    (_name, cutoffs) => {
      const context = validContext();
      expect(() =>
        validateReportContext({
          ...context,
          cutoffs: { ...context.cutoffs, ...cutoffs },
        }),
      ).toThrow(/cutoff|provenance|source/i);
    },
  );

  it.each([
    ['trend', 'history', '2026-07-14'],
    ['valuation', 'overview', '2026-07-16'],
    ['quality', 'fundamentals', '2026-07-14'],
  ] as const)(
    'requires the %s signal cutoff to equal the %s resource cutoff',
    (signal, _resource, cutoff) => {
      const context = validContext();
      expect(() =>
        validateReportContext({
          ...context,
          signals: {
            ...context.signals,
            [signal]: { ...context.signals[signal], cutoff },
          },
          cutoffs: { ...context.cutoffs, [signal]: cutoff },
        }),
      ).toThrow(/cutoff|provenance|resource/i);
    },
  );

  it('allows an unavailable overview resource when all overview-derived values are null', () => {
    const context = validContext();
    const overviewMetrics = new Set([
      'close',
      'previousClose',
      'changePercent',
      'peTtm',
      'pb',
      'totalMarketValueCny',
      'valuationScore',
    ]);
    const unavailable = validateReportContext({
      ...context,
      price: { close: null, previousClose: null, changePercent: null },
      fundamentals: {
        ...context.fundamentals,
        peTtm: null,
        pb: null,
        totalMarketValueCny: null,
      },
      signals: {
        ...context.signals,
        valuation: {
          ...context.signals.valuation,
          score: null,
          band: null,
          status: 'insufficient',
          cutoff: null,
        },
      },
      availability: context.availability.map((entry) =>
        overviewMetrics.has(entry.metric)
          ? { metric: entry.metric, status: 'missing', reason: '行情资源不可用' }
          : entry,
      ),
      cutoffs: { ...context.cutoffs, overview: null, valuation: null },
      cutoff: '2026-07-16',
      freshness: { ...context.freshness, overview: null },
    });

    expect(unavailable.cutoffs.overview).toBeNull();
    expect(unavailable.freshness.overview).toBeNull();
  });

  it('requires strict workspace and per-resource freshness metadata', () => {
    const { freshness: _freshness, ...withoutFreshness } = validContext();

    expect(() => validateReportContext(withoutFreshness)).toThrow(/freshness|required/i);
  });

  it('requires exactly one availability entry for every allowlisted metric', () => {
    const context = validContext();
    expect(() =>
      validateReportContext({ ...context, availability: context.availability.slice(1) }),
    ).toThrow(/availability|metric/i);
    expect(() =>
      validateReportContext({
        ...context,
        availability: [...context.availability, { metric: 'targetPrice', status: 'available' }],
      }),
    ).toThrow(/availability|metric|invalid/i);
  });

  it('cross-checks availability status against each normalized numeric value', () => {
    const context = validContext();
    const mismatched = context.availability.map((entry) =>
      entry.metric === 'close'
        ? { metric: 'close' as const, status: 'missing' as const, reason: '错误状态' }
        : entry,
    );

    expect(() => validateReportContext({ ...context, availability: mismatched })).toThrow(
      /availability|match|non-null/i,
    );
  });

  it('rejects a top-level cutoff that is not the latest included source or signal date', () => {
    expect(() => validateReportContext({ ...validContext(), cutoff: '2026-07-15' })).toThrow(
      /cutoff|latest/i,
    );
  });

  it('rejects unknown authoritative metrics instead of silently accepting them', () => {
    const context = validContext();
    const unsafe = {
      ...context,
      price: { ...context.price, targetPrice: 1800 },
    };

    expect(() => validateReportContext(unsafe)).toThrow(/unknown|unrecognized/i);
  });

  it('measures the 200 KB context cap in UTF-8 bytes', () => {
    const context = validContext();
    const chineseCharacterBytes = new TextEncoder().encode('限').byteLength;
    expect(chineseCharacterBytes).toBe(3);

    const oversized = {
      ...context,
      limitations: ['限'.repeat(Math.ceil(MAX_REPORT_CONTEXT_BYTES / chineseCharacterBytes))],
    };

    expect(JSON.stringify(oversized).length).toBeLessThan(MAX_REPORT_CONTEXT_BYTES);
    expect(() => validateReportContext(oversized)).toThrow(/200 KB/i);
  });

  it.each([
    ['cutoff', ''],
    ['source', ''],
  ] as const)('rejects a missing %s', (field, value) => {
    expect(() => validateReportContext({ ...validContext(), [field]: value })).toThrow();
  });

  it('accepts exactly the seven approved report headings in order', () => {
    const sections = parseCompleteReport(completeReport());

    expect(sections.map(({ heading }) => heading)).toEqual(REPORT_SECTION_HEADINGS);
    expect(sections).toHaveLength(7);
  });

  it('rejects report sections outside the seven approved headings', () => {
    expect(() =>
      parseCompleteReport(`${completeReport()}\n\n## 明确买卖建议\n不允许的额外章节`),
    ).toThrow(/section|heading|章节/i);
  });

  it('forbids invented metrics, advice, trade instructions, targets, and guarantees', () => {
    expect(REPORT_SYSTEM_INSTRUCTION).toMatch(/不得编造|must not invent/i);
    expect(REPORT_SYSTEM_INSTRUCTION).toMatch(/投资建议|investment advice/i);
    expect(REPORT_SYSTEM_INSTRUCTION).toMatch(/买入|buy/i);
    expect(REPORT_SYSTEM_INSTRUCTION).toMatch(/卖出|sell/i);
    expect(REPORT_SYSTEM_INSTRUCTION).toMatch(/目标价|target price/i);
    expect(REPORT_SYSTEM_INSTRUCTION).toMatch(/保证收益|guaranteed return/i);
  });
});

describe('incremental report structure parser', () => {
  it('keeps a heading split across chunks pending until its line is complete', () => {
    const parser = createIncrementalReportParser();

    expect(parser.push('## 数据摘要与截')).toMatchObject({ status: 'valid' });
    const firstTwo = parser.push('止日期\n第一节内容。\n## 技术结构与支持观察\n第二节内容。\n');
    expect(firstTwo).toMatchObject({ status: 'valid' });
    expect(firstTwo.sections[0]?.content).toBe('第一节内容。');
    expect(firstTwo.sections[1]?.content).toBe('第二节内容。');

    parser.push(
      REPORT_SECTION_HEADINGS.slice(2)
        .map((heading, index) => `## ${heading}\n第 ${index + 3} 节内容。\n`)
        .join(''),
    );
    const finished = parser.finish();
    expect(finished.status).toBe('complete');
    expect(finished.sections).toHaveLength(7);
  });

  it.each([
    ['nonempty preamble', '未批准的前言\n', 'nonempty-preamble'],
    ['unknown heading', '## 未批准章节\n', 'unknown-heading'],
    [
      'duplicate heading',
      '## 数据摘要与截止日期\n内容\n## 数据摘要与截止日期\n',
      'duplicate-heading',
    ],
    ['out-of-order heading', '## 技术结构与支持观察\n', 'out-of-order-heading'],
  ] as const)('rejects a completed %s immediately', (_name, chunk, reason) => {
    const result = createIncrementalReportParser().push(chunk);

    expect(result).toMatchObject({ status: 'invalid', reason });
  });

  it('validates the final partial line at terminal time', () => {
    const parser = createIncrementalReportParser();
    expect(parser.push('## 数据摘要与截止日期\n第一节内容。\n## 未批准的最终章节')).toMatchObject({
      status: 'valid',
    });

    expect(parser.finish()).toMatchObject({ status: 'invalid', reason: 'unknown-heading' });
  });
});
