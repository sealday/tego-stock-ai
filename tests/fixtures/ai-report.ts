import type { ReportContext } from '../../src/ai/report-contract';
import { REPORT_METRIC_IDS, REPORT_SECTION_HEADINGS } from '../../src/ai/report-contract';
import type { CompleteAiReport, DraftAiReport } from '../../src/ai/report-model';

export const REPORT_TEST_API_KEY = 'storage-test-sensitive-key';

export function reportContext(): ReportContext {
  return {
    version: 1,
    stock: { code: '600519.SH', name: '贵州茅台' },
    price: { close: 1430.4, previousClose: 1420, changePercent: 0.7324 },
    fundamentals: {
      peTtm: 24.6,
      pb: 8.1,
      totalMarketValueCny: 1_796_000_000_000,
      roe: 0.31,
      grossMargin: 0.91,
      revenueGrowth: 0.12,
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
      trend: signal(78.2, 'constructive'),
      valuation: signal(62, 'constructive'),
      quality: signal(82, 'strong'),
    },
    availability: REPORT_METRIC_IDS.map((metric) => ({ metric, status: 'available' })),
    cutoffs: {
      overview: '2026-07-17',
      history: '2026-07-17',
      fundamentals: '2026-07-17',
      trend: '2026-07-17',
      valuation: '2026-07-17',
      quality: '2026-07-17',
    },
    cutoff: '2026-07-17',
    freshness: {
      workspace: 'fresh',
      overview: 'fresh',
      history: 'fresh',
      fundamentals: 'fresh',
      marketStatus: 'fresh',
    },
    source: 'Tushare Pro',
    limitations: ['历史日线收盘口径，不是实时行情', '材料仅供研究与教育使用，不构成投资建议'],
  };
}

export function completeReport(overrides: Partial<CompleteAiReport> = {}): CompleteAiReport {
  const sections = REPORT_SECTION_HEADINGS.map((heading, index) => ({
    heading,
    content: `第 ${index + 1} 节已验证内容。`,
  }));
  return {
    status: 'complete',
    completedAt: '2026-07-20T01:02:03.000Z',
    provider: {
      baseUrl: 'https://provider.example/v1',
      model: 'research-model',
      rememberApiKey: true,
    },
    context: reportContext(),
    rawText: sections.map((section) => `## ${section.heading}\n${section.content}`).join('\n\n'),
    sections,
    ...overrides,
  };
}

export function draftReport(overrides: Partial<DraftAiReport> = {}): DraftAiReport {
  return {
    status: 'draft',
    interruptedAt: '2026-07-20T01:01:00.000Z',
    provider: {
      baseUrl: 'https://provider.example/v1',
      model: 'research-model',
      rememberApiKey: false,
    },
    context: reportContext(),
    rawText: '## 数据摘要与截止日期\n流式草稿。',
    sections: REPORT_SECTION_HEADINGS.map((heading, index) => ({
      heading,
      content: index === 0 ? '流式草稿。' : '',
    })),
    reason: 'stream-interrupted',
    errorMessage: 'AI 响应流意外中断。',
    ...overrides,
  };
}

function signal(score: number, band: 'constructive' | 'strong') {
  return {
    score,
    band,
    status: 'complete' as const,
    cutoff: '2026-07-17',
    calculationVersion: '1.0.0',
    observations: ['已验证观察'],
    missingInputs: [],
  };
}
