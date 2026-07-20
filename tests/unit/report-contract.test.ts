import { describe, expect, it } from 'vitest';

import {
  MAX_REPORT_CONTEXT_BYTES,
  REPORT_SECTION_HEADINGS,
  REPORT_SYSTEM_INSTRUCTION,
  createReportMessages,
  parseCompleteReport,
  validateReportContext,
  type ReportContext,
} from '../../src/ai/report-contract';

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
        calculationVersion: '1.0.0',
        observations: ['收盘价高于 MA20 与 MA60'],
        missingInputs: [],
      },
      valuation: {
        score: null,
        band: null,
        status: 'insufficient',
        calculationVersion: '1.0.0',
        observations: [],
        missingInputs: ['pe', 'dividendYield'],
      },
      quality: {
        score: 82,
        band: 'strong',
        status: 'partial',
        calculationVersion: '1.0.0',
        observations: ['ROE 与毛利率可用'],
        missingInputs: ['revenueGrowth'],
      },
    },
    availability: [
      { metric: 'close', status: 'available' },
      { metric: 'peTtm', status: 'missing', reason: '当前权限未返回市盈率' },
      { metric: 'revenueGrowth', status: 'missing', reason: '当前报告期未披露营收增长' },
    ],
    cutoff: '2026-07-17',
    source: 'Tushare Pro',
    limitations: ['仅包含历史日线收盘数据', '估值参考样本不足'],
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
    expect(context.availability).toContainEqual({
      metric: 'peTtm',
      status: 'missing',
      reason: '当前权限未返回市盈率',
    });
    expect(context.cutoff).toBe('2026-07-17');
    expect(context.source).toBe('Tushare Pro');
    expect(context.limitations).toContain('仅包含历史日线收盘数据');
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toContain('"close":1430.4');
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
