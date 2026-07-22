import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { MAX_AI_REPORT_TEXT_BYTES, type AiStreamEvent } from '../../src/ai/client';
import { REPORT_SECTION_HEADINGS, type ReportContext } from '../../src/ai/report-contract';
import {
  AiReportPanel,
  type AiReportStreamer,
  type CompleteAiReport,
  type DraftAiReport,
} from '../../src/components/ai/AiReportPanel';
import type { AiProviderSettings } from '../../src/components/ai/AiSettings';

const SETTINGS: AiProviderSettings = {
  baseUrl: 'https://provider.example/v1',
  model: 'research-model',
  apiKey: 'sk-browser-secret',
  rememberApiKey: false,
};

function reportContext(): ReportContext {
  return {
    version: 1,
    stock: { code: '600519.SH', name: '贵州茅台' },
    price: { close: 1430.4, previousClose: 1420, changePercent: 0.7324 },
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
        missingInputs: ['pe', 'dividendYield', 'pe'],
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
    limitations: ['仅包含历史日线收盘数据'],
  };
}

function completeAvailability(): ReportContext['availability'] {
  const missing = new Map([
    ['peTtm', '当前权限未返回市盈率'],
    ['revenueGrowth', '当前报告期未披露营收增长'],
    ['valuationScore', '估值评分参考样本不足'],
  ]);
  return [
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
  ].map((metric) => {
    const reason = missing.get(metric);
    return reason === undefined
      ? { metric, status: 'available' as const }
      : { metric, status: 'missing' as const, reason };
  }) as ReportContext['availability'];
}

function nextReportContext(): ReportContext {
  const initial = reportContext();
  return {
    ...initial,
    stock: { code: '000001.SZ', name: '平安银行' },
    price: { ...initial.price, close: 12.34 },
    signals: {
      trend: { ...initial.signals.trend, cutoff: '2026-07-19' },
      valuation: { ...initial.signals.valuation, cutoff: '2026-07-19' },
      quality: { ...initial.signals.quality, cutoff: '2026-07-19' },
    },
    cutoffs: {
      overview: '2026-07-19',
      history: '2026-07-19',
      fundamentals: '2026-07-19',
      trend: '2026-07-19',
      valuation: '2026-07-19',
      quality: '2026-07-19',
    },
    cutoff: '2026-07-19',
  };
}

function completeReport(firstSection = '数据截止 2026-07-17。'): string {
  return REPORT_SECTION_HEADINGS.map(
    (heading, index) => `## ${heading}\n${index === 0 ? firstSection : `第 ${index + 1} 节内容。`}`,
  ).join('\n\n');
}

function reportWithEmptySection(
  emptySectionIndex: number,
  sectionCount: number = REPORT_SECTION_HEADINGS.length,
): string {
  return REPORT_SECTION_HEADINGS.slice(0, sectionCount)
    .map((heading, index) =>
      index === emptySectionIndex ? `## ${heading}` : `## ${heading}\n第 ${index + 1} 节内容。`,
    )
    .join('\n');
}

function eventStream(events: readonly AiStreamEvent[]): AiReportStreamer {
  return async function* () {
    for (const event of events) {
      yield event;
    }
  };
}

type InterruptedTerminal = 'aborted' | 'error' | 'eof' | 'throw';

function interruptedStream(pendingText: string, terminal: InterruptedTerminal): AiReportStreamer {
  return async function* () {
    yield { type: 'delta', text: pendingText };
    if (terminal === 'aborted') {
      yield { type: 'aborted' };
    } else if (terminal === 'error') {
      yield { type: 'error', code: 'provider', message: '提供商中断。' };
    } else if (terminal === 'throw') {
      throw new Error('stream failed');
    }
  };
}

describe('AiReportPanel', () => {
  it('exposes one bounded polite status and marks only the report panel busy while streaming', async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stream: AiReportStreamer = async function* () {
      yield { type: 'delta', text: '## 数据摘要与截止日期\n正在生成的内容。' };
      await gate;
      yield { type: 'delta', text: completeReport().slice(completeReport().indexOf('\n\n')) };
      yield { type: 'complete' };
    };
    const onSaveReport = vi.fn<(report: CompleteAiReport) => void>();
    const { container } = render(
      <AiReportPanel
        context={reportContext()}
        settings={SETTINGS}
        stream={stream}
        onSaveReport={onSaveReport}
      />,
    );

    const panel = container.querySelector('.ai-report');
    expect(panel?.getAttribute('aria-busy')).toBe('false');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
    expect(screen.getByRole('status').getAttribute('aria-atomic')).toBe('true');

    await user.click(screen.getByRole('button', { name: '生成 AI 报告' }));
    await screen.findByText('正在生成的内容。');
    expect(panel?.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status').textContent).toContain('正在流式生成');
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(1);

    release();
    await screen.findByText('报告已完成');
    expect(panel?.getAttribute('aria-busy')).toBe('false');
    await user.click(screen.getByRole('button', { name: '保存完整报告' }));
    expect(screen.getByRole('status').textContent).toContain('完整报告已交给本地保存回调');
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('waits for an explicit action, renders seven safe structured sections, and saves only complete reports', async () => {
    const user = userEvent.setup();
    const rawReport = completeReport('<img src=x onerror=alert(1)> 作为纯文本。');
    const stream = vi.fn<AiReportStreamer>(
      eventStream([
        { type: 'delta', text: rawReport.slice(0, 80) },
        { type: 'delta', text: rawReport.slice(80) },
        { type: 'complete' },
      ]),
    );
    const onSaveReport = vi.fn<(report: CompleteAiReport, generationEpoch: number) => void>();
    const { container } = render(
      <AiReportPanel
        context={reportContext()}
        settings={SETTINGS}
        stream={stream}
        storageEpoch={7}
        onSaveReport={onSaveReport}
      />,
    );

    expect(stream).not.toHaveBeenCalled();
    expect(screen.queryByText('报告已完成')).toBeNull();
    await user.click(screen.getByRole('button', { name: '生成 AI 报告' }));

    await screen.findByText('报告已完成');
    const reportSections = [...container.querySelectorAll('.ai-report__section')];
    expect(reportSections).toHaveLength(7);
    expect(reportSections.map((section) => section.querySelector('h4')?.textContent)).toEqual(
      REPORT_SECTION_HEADINGS,
    );
    expect(container.querySelector('.ai-report__section img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)> 作为纯文本。')).toBeVisible();
    expect(onSaveReport).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '保存完整报告' }));
    expect(onSaveReport).toHaveBeenCalledOnce();
    const saved = onSaveReport.mock.calls[0]?.[0];
    expect(saved?.status).toBe('complete');
    expect(saved?.sections).toHaveLength(7);
    expect(saved?.provider).toEqual({
      baseUrl: 'https://provider.example/v1',
      model: 'research-model',
      rememberApiKey: false,
    });
    expect(JSON.stringify(saved)).not.toContain('sk-browser-secret');
    expect(onSaveReport.mock.calls[0]?.[1]).toBe(7);
    expect(screen.getByText('完整报告已交给本地保存回调')).toBeVisible();
  });

  it('reports a complete report as saved only after persistence succeeds and retries safely', async () => {
    const user = userEvent.setup();
    let rejectFirst: (reason?: unknown) => void = () => undefined;
    let resolveSecond: () => void = () => undefined;
    const firstSave = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const secondSave = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const onSaveReport = vi
      .fn<(report: CompleteAiReport) => Promise<void>>()
      .mockReturnValueOnce(firstSave)
      .mockReturnValueOnce(secondSave);
    render(
      <AiReportPanel
        context={reportContext()}
        settings={SETTINGS}
        stream={eventStream([{ type: 'delta', text: completeReport() }, { type: 'complete' }])}
        onSaveReport={onSaveReport}
      />,
    );

    await user.click(screen.getByRole('button', { name: '生成 AI 报告' }));
    await screen.findByText('报告已完成');
    await user.click(screen.getByRole('button', { name: '保存完整报告' }));

    const pendingButton = screen.getByRole('button', { name: '正在保存…' });
    expect(pendingButton).toHaveProperty('disabled', true);
    expect(onSaveReport).toHaveBeenCalledOnce();
    expect(screen.queryByText('完整报告已交给本地保存回调')).toBeNull();
    rejectFirst(new Error('IndexedDB internals'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('完整报告未能保存到当前浏览器，请重试。');
    expect(alert.textContent).not.toContain('IndexedDB');
    await user.click(screen.getByRole('button', { name: '重试保存完整报告' }));
    expect(onSaveReport).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: '正在保存…' })).toHaveProperty('disabled', true);
    resolveSecond();

    expect(await screen.findByText('完整报告已交给本地保存回调')).toBeVisible();
    expect(screen.queryByText('完整报告未能保存到当前浏览器，请重试。')).toBeNull();
  });

  it('cancels an active stream and hands off one non-saveable draft', async () => {
    const user = userEvent.setup();
    const onDraftReport = vi.fn<(report: DraftAiReport, generationEpoch: number) => void>();
    const stream: AiReportStreamer = async function* (configuration) {
      yield { type: 'delta', text: '## 数据摘要与截止日期\n流式草稿内容。' };
      await new Promise<void>((resolve) => {
        configuration.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { type: 'aborted' };
    };
    render(
      <AiReportPanel
        context={reportContext()}
        settings={SETTINGS}
        stream={stream}
        storageEpoch={9}
        onDraftReport={onDraftReport}
      />,
    );

    await user.click(screen.getByRole('button', { name: '生成 AI 报告' }));
    await screen.findByText('流式草稿内容。');
    await user.click(screen.getByRole('button', { name: '取消生成' }));

    expect(await screen.findByText('未完成草稿 · 生成已取消')).toBeVisible();
    expect(screen.getByRole('button', { name: '仅重试 AI 生成' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '保存完整报告' })).toBeNull();
    expect(onDraftReport).toHaveBeenCalledOnce();
    expect(onDraftReport.mock.calls[0]?.[0]).toMatchObject({
      status: 'draft',
      reason: 'cancelled',
      context: { stock: { code: '600519.SH' } },
    });
    expect(onDraftReport.mock.calls[0]?.[1]).toBe(9);
  });

  it('finalizes a pending structural violation when the user cancels generation', async () => {
    const user = userEvent.setup();
    const onDraftReport = vi.fn<(report: DraftAiReport) => void>();
    const stream: AiReportStreamer = async function* (configuration) {
      yield {
        type: 'delta',
        text: '## 数据摘要与截止日期\n取消前草稿。\n## 未批准的最终章节',
      };
      await new Promise<void>((resolve) => {
        configuration.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { type: 'aborted' };
    };
    render(
      <AiReportPanel
        context={reportContext()}
        settings={SETTINGS}
        stream={stream}
        onDraftReport={onDraftReport}
      />,
    );

    await user.click(screen.getByRole('button', { name: '生成 AI 报告' }));
    expect(await screen.findByText('取消前草稿。')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '取消生成' }));

    expect(screen.getByText('未完成草稿 · 响应未通过七章节契约校验')).toBeVisible();
    expect(onDraftReport).toHaveBeenCalledOnce();
    expect(onDraftReport.mock.calls[0]?.[0]).toMatchObject({
      reason: 'contract-invalid',
      contractFailure: 'unknown-heading',
    });
  });

  it('keeps a trailing empty section as a cancelled draft when the user cancels', async () => {
    const user = userEvent.setup();
    const onDraftReport = vi.fn<(report: DraftAiReport) => void>();
    const stream: AiReportStreamer = async function* (configuration) {
      yield {
        type: 'delta',
        text: reportWithEmptySection(REPORT_SECTION_HEADINGS.length - 1),
      };
      await new Promise<void>((resolve) => {
        configuration.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { type: 'aborted' };
    };
    render(
      <AiReportPanel
        context={reportContext()}
        settings={SETTINGS}
        stream={stream}
        onDraftReport={onDraftReport}
      />,
    );

    await user.click(screen.getByRole('button', { name: '生成 AI 报告' }));
    expect(await screen.findByText('第 1 节内容。')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '取消生成' }));

    expect(screen.getByText('未完成草稿 · 生成已取消')).toBeVisible();
    expect(onDraftReport).toHaveBeenCalledOnce();
    expect(onDraftReport.mock.calls[0]?.[0]).toMatchObject({ reason: 'cancelled' });
    expect(onDraftReport.mock.calls[0]?.[0].contractFailure).toBeUndefined();
  });

  it('keeps a trailing empty section as an interrupted draft on provider error', async () => {
    const user = userEvent.setup();
    const onDraftReport = vi.fn<(report: DraftAiReport) => void>();
    render(
      <AiReportPanel
        context={reportContext()}
        settings={SETTINGS}
        stream={interruptedStream(
          reportWithEmptySection(REPORT_SECTION_HEADINGS.length - 1),
          'error',
        )}
        onDraftReport={onDraftReport}
      />,
    );

    await user.click(screen.getByRole('button', { name: '生成 AI 报告' }));

    expect(await screen.findByText('未完成草稿 · 流式响应中断')).toBeVisible();
    expect(onDraftReport).toHaveBeenCalledOnce();
    expect(onDraftReport.mock.calls[0]?.[0]).toMatchObject({ reason: 'stream-interrupted' });
    expect(onDraftReport.mock.calls[0]?.[0].contractFailure).toBeUndefined();
  });

  it('rejects a proven empty middle section when a provider error interrupts the stream', async () => {
    const user = userEvent.setup();
    const onDraftReport = vi.fn<(report: DraftAiReport) => void>();
    render(
      <AiReportPanel
        context={reportContext()}
        settings={SETTINGS}
        stream={interruptedStream(reportWithEmptySection(1, 4), 'error')}
        onDraftReport={onDraftReport}
      />,
    );

    await user.click(screen.getByRole('button', { name: '生成 AI 报告' }));

    expect(await screen.findByText('未完成草稿 · 响应未通过七章节契约校验')).toBeVisible();
    expect(onDraftReport.mock.calls[0]?.[0]).toMatchObject({
      reason: 'contract-invalid',
      contractFailure: 'empty-section',
    });
  });

  it('rejects a trailing empty section when the provider marks the response complete', async () => {
    const user = userEvent.setup();
    const onDraftReport = vi.fn<(report: DraftAiReport) => void>();
    render(
      <AiReportPanel
        context={reportContext()}
        settings={SETTINGS}
        stream={eventStream([
          {
            type: 'delta',
            text: reportWithEmptySection(REPORT_SECTION_HEADINGS.length - 1),
          },
          { type: 'complete' },
        ])}
        onDraftReport={onDraftReport}
      />,
    );

    await user.click(screen.getByRole('button', { name: '生成 AI 报告' }));

    expect(await screen.findByText('未完成草稿 · 响应未通过七章节契约校验')).toBeVisible();
    expect(onDraftReport.mock.calls[0]?.[0]).toMatchObject({
      reason: 'contract-invalid',
      contractFailure: 'empty-section',
    });
  });

  it('keeps deterministic context and missing metrics usable through provider failure and AI-only retry', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const stream = vi.fn<AiReportStreamer>(async function* () {
      attempt += 1;
      if (attempt === 1) {
        yield {
          type: 'error',
          code: 'provider',
          message: 'AI 服务返回错误，请检查提供商设置。',
        };
        return;
      }
      yield { type: 'delta', text: completeReport() };
      yield { type: 'complete' };
    });
    render(<AiReportPanel context={reportContext()} settings={SETTINGS} stream={stream} />);

    await user.click(screen.getByRole('button', { name: '生成 AI 报告' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'AI 服务返回错误，请检查提供商设置。',
    );
    expect(screen.getByText('趋势评分 78.2 / 100')).toBeVisible();
    expect(screen.getByText('当前权限未返回市盈率')).toBeVisible();
    expect(screen.getByText('当前报告期未披露营收增长')).toBeVisible();
    expect(screen.getByText('peTtm')).toBeVisible();
    expect(screen.getAllByText('revenueGrowth')).toHaveLength(2);
    expect(screen.getByText('贵州茅台 · 600519.SH')).toBeVisible();
    expect(screen.getByText('历史数据 2026-07-16')).toBeVisible();
    expect(screen.getByText('基本面数据 2026-07-15')).toBeVisible();
    const freshness = screen.getByRole('group', { name: '数据新鲜度明细' });
    expect(within(freshness).getByText('整体 延迟')).toBeVisible();
    expect(within(freshness).getByText('行情 延迟')).toBeVisible();
    expect(within(freshness).getByText('历史 新鲜')).toBeVisible();
    const valuationMissing = screen.getByRole('group', { name: '估值评分缺失输入' });
    expect(within(valuationMissing).getAllByText('pe')).toHaveLength(1);
    expect(within(valuationMissing).getByText('dividendYield')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '仅重试 AI 生成' }));
    await screen.findByText('报告已完成');
    expect(stream).toHaveBeenCalledTimes(2);
    expect(screen.getByText('趋势评分 78.2 / 100')).toBeVisible();
  });

  it('keeps an invalid completed response as a non-saveable interrupted draft', async () => {
    const user = userEvent.setup();
    const onSaveReport = vi.fn<(report: CompleteAiReport) => void>();
    const onDraftReport = vi.fn<(report: DraftAiReport) => void>();
    let requestAborted = false;
    const stream: AiReportStreamer = async function* (configuration) {
      try {
        yield {
          type: 'delta',
          text: '## 数据摘要与截止日期\n有效内容。\n## 明确买卖建议\n',
        };
        yield { type: 'delta', text: '结构错误后不应继续消费。' };
        yield { type: 'complete' };
      } finally {
        requestAborted = configuration.signal.aborted;
      }
    };
    render(
      <AiReportPanel
        context={reportContext()}
        settings={SETTINGS}
        stream={stream}
        onSaveReport={onSaveReport}
        onDraftReport={onDraftReport}
      />,
    );

    await user.click(screen.getByRole('button', { name: '生成 AI 报告' }));

    expect(await screen.findByText('未完成草稿 · 响应未通过七章节契约校验')).toBeVisible();
    expect(screen.getByRole('alert').textContent).toMatch(/AI 返回内容无效/);
    expect(screen.queryByRole('button', { name: '保存完整报告' })).toBeNull();
    expect(onSaveReport).not.toHaveBeenCalled();
    expect(onDraftReport).toHaveBeenCalledOnce();
    expect(onDraftReport.mock.calls[0]?.[0]).toMatchObject({
      status: 'draft',
      reason: 'contract-invalid',
      contractFailure: 'unknown-heading',
    });
    await waitFor(() => expect(requestAborted).toBe(true));
  });

  it('marks a stream error after deltas as an interrupted draft', async () => {
    const user = userEvent.setup();
    const onDraftReport = vi.fn<(report: DraftAiReport) => void>();
    render(
      <AiReportPanel
        context={reportContext()}
        settings={SETTINGS}
        stream={eventStream([
          { type: 'delta', text: '## 数据摘要与截止日期\n部分内容。' },
          { type: 'error', code: 'network', message: '无法连接 AI 提供商，请稍后重试。' },
        ])}
        onDraftReport={onDraftReport}
      />,
    );

    await user.click(screen.getByRole('button', { name: '生成 AI 报告' }));

    expect(await screen.findByText('未完成草稿 · 流式响应中断')).toBeVisible();
    expect(screen.getByRole('alert').textContent).toContain('无法连接 AI 提供商');
    expect(screen.getByText('部分内容。')).toBeVisible();
    expect(onDraftReport).toHaveBeenCalledOnce();
    expect(onDraftReport.mock.calls[0]?.[0]).toMatchObject({
      status: 'draft',
      reason: 'stream-interrupted',
    });
  });

  it('bounds report text even when an injected streamer emits an oversized delta', async () => {
    const user = userEvent.setup();
    const onSaveReport = vi.fn<(report: CompleteAiReport) => void>();
    const onDraftReport = vi.fn<(report: DraftAiReport) => void>();
    const retainedText = '## 数据摘要与截止日期\n安全保留的草稿。';
    let requestAborted = false;
    const stream: AiReportStreamer = async function* (configuration) {
      try {
        yield { type: 'delta', text: retainedText };
        yield {
          type: 'delta',
          text: '限'.repeat(Math.floor(MAX_AI_REPORT_TEXT_BYTES / 3) + 1),
        };
        yield { type: 'complete' };
      } finally {
        requestAborted = configuration.signal.aborted;
      }
    };
    render(
      <AiReportPanel
        context={reportContext()}
        settings={SETTINGS}
        stream={stream}
        onSaveReport={onSaveReport}
        onDraftReport={onDraftReport}
      />,
    );

    await user.click(screen.getByRole('button', { name: '生成 AI 报告' }));

    expect(await screen.findByText('未完成草稿 · 流式响应中断')).toBeVisible();
    expect(screen.getByRole('alert').textContent).toBe('AI 响应超过安全大小限制。');
    expect(onDraftReport).toHaveBeenCalledOnce();
    const draft = onDraftReport.mock.calls[0]?.[0];
    expect(draft?.rawText).toBe(retainedText);
    expect(new TextEncoder().encode(draft?.rawText).byteLength).toBeLessThanOrEqual(
      MAX_AI_REPORT_TEXT_BYTES,
    );
    expect(JSON.stringify(draft?.sections)).not.toContain('限'.repeat(100));
    expect(onSaveReport).not.toHaveBeenCalled();
    await waitFor(() => expect(requestAborted).toBe(true));
  });

  it.each([
    [
      'aborted event',
      'aborted',
      '## 数据摘要与截止日期\n有效内容。\n## 未批准章节',
      'unknown-heading',
    ],
    [
      'provider error',
      'error',
      '## 数据摘要与截止日期\n有效内容。\n## 数据摘要与截止日期',
      'duplicate-heading',
    ],
    ['unexpected EOF', 'eof', '## 技术结构与支持观察', 'out-of-order-heading'],
    ['thrown stream', 'throw', '未批准的前言', 'nonempty-preamble'],
  ] as const)(
    'finalizes a pending structural violation before handling %s',
    async (_name, terminal, pendingText, contractFailure) => {
      const user = userEvent.setup();
      const onDraftReport = vi.fn<(report: DraftAiReport) => void>();
      render(
        <AiReportPanel
          context={reportContext()}
          settings={SETTINGS}
          stream={interruptedStream(pendingText, terminal)}
          onDraftReport={onDraftReport}
        />,
      );

      await user.click(screen.getByRole('button', { name: '生成 AI 报告' }));

      expect(await screen.findByText('未完成草稿 · 响应未通过七章节契约校验')).toBeVisible();
      expect(onDraftReport).toHaveBeenCalledOnce();
      expect(onDraftReport.mock.calls[0]?.[0]).toMatchObject({
        status: 'draft',
        reason: 'contract-invalid',
        contractFailure,
      });
    },
  );

  it.each([
    ['aborted', 'cancelled'],
    ['error', 'stream-interrupted'],
    ['eof', 'stream-interrupted'],
    ['throw', 'stream-interrupted'],
  ] as const)(
    'keeps a valid partial report as %s when only later approved sections are absent',
    async (terminal, reason) => {
      const user = userEvent.setup();
      const onDraftReport = vi.fn<(report: DraftAiReport) => void>();
      render(
        <AiReportPanel
          context={reportContext()}
          settings={SETTINGS}
          stream={interruptedStream('## 数据摘要与截止日期\n有效但未完成的第一节。', terminal)}
          onDraftReport={onDraftReport}
        />,
      );

      await user.click(screen.getByRole('button', { name: '生成 AI 报告' }));

      await waitFor(() => expect(onDraftReport).toHaveBeenCalledOnce());
      expect(onDraftReport.mock.calls[0]?.[0]).toMatchObject({ status: 'draft', reason });
      expect(onDraftReport.mock.calls[0]?.[0].contractFailure).toBeUndefined();
    },
  );

  it('binds streaming, completed output, and saving to the generation snapshot', async () => {
    const user = userEvent.setup();
    let releaseStream: () => void = () => {};
    const holdStream = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const onSaveReport = vi.fn<(report: CompleteAiReport) => void>();
    const rawReport = completeReport();
    const stream = vi.fn<AiReportStreamer>(async function* () {
      const splitAt = rawReport.indexOf('截止日期') + 2;
      yield { type: 'delta', text: rawReport.slice(0, splitAt) };
      await holdStream;
      yield { type: 'delta', text: rawReport.slice(splitAt) };
      yield { type: 'complete' };
    });
    const { rerender } = render(
      <AiReportPanel
        context={reportContext()}
        settings={SETTINGS}
        stream={stream}
        onSaveReport={onSaveReport}
      />,
    );

    await user.click(screen.getByRole('button', { name: '生成 AI 报告' }));
    await screen.findByText('正在流式生成');
    rerender(
      <AiReportPanel
        context={nextReportContext()}
        settings={SETTINGS}
        stream={stream}
        onSaveReport={onSaveReport}
      />,
    );
    expect(screen.getByText('贵州茅台 · 600519.SH')).toBeVisible();
    expect(screen.queryByText('平安银行 · 000001.SZ')).toBeNull();

    releaseStream();
    await screen.findByText('报告已完成');
    expect(screen.getByText('贵州茅台 · 600519.SH')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '保存完整报告' }));
    expect(onSaveReport.mock.calls[0]?.[0].context.stock).toEqual({
      code: '600519.SH',
      name: '贵州茅台',
    });
  });

  it('captures the current context when retrying after a failed request', async () => {
    const user = userEvent.setup();
    const onSaveReport = vi.fn<(report: CompleteAiReport) => void>();
    let attempt = 0;
    const stream = vi.fn<AiReportStreamer>(async function* () {
      attempt += 1;
      if (attempt === 1) {
        yield { type: 'error', code: 'network', message: '第一次失败。' };
        return;
      }
      yield { type: 'delta', text: completeReport('第二次生成。') };
      yield { type: 'complete' };
    });
    const { rerender } = render(
      <AiReportPanel
        context={reportContext()}
        settings={SETTINGS}
        stream={stream}
        onSaveReport={onSaveReport}
      />,
    );
    await user.click(screen.getByRole('button', { name: '生成 AI 报告' }));
    await screen.findByText('AI 生成失败');

    rerender(
      <AiReportPanel
        context={nextReportContext()}
        settings={SETTINGS}
        stream={stream}
        onSaveReport={onSaveReport}
      />,
    );
    await user.click(screen.getByRole('button', { name: '仅重试 AI 生成' }));
    await screen.findByText('报告已完成');
    expect(screen.getByText('平安银行 · 000001.SZ')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '保存完整报告' }));
    expect(onSaveReport.mock.calls[0]?.[0].context.stock.code).toBe('000001.SZ');
  });

  it('disables generation until the model and key are explicitly configured', () => {
    render(
      <AiReportPanel context={reportContext()} settings={{ ...SETTINGS, model: '', apiKey: '' }} />,
    );

    expect(screen.getByRole('button', { name: '生成 AI 报告' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/请先填写有效的 Base URL、模型和 API key/)).toBeVisible();
  });

  it('invalidates an old generation on a storage epoch change without delivering a draft', async () => {
    const user = userEvent.setup();
    const onDraftReport = vi.fn<(report: DraftAiReport) => void>();
    const stream: AiReportStreamer = async function* (configuration) {
      yield { type: 'delta', text: '## 数据摘要与截止日期\n清空前的旧流。' };
      await new Promise<void>((resolve) => {
        configuration.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { type: 'aborted' };
    };
    const { rerender } = render(
      <AiReportPanel
        context={reportContext()}
        settings={SETTINGS}
        stream={stream}
        storageEpoch={0}
        onDraftReport={onDraftReport}
      />,
    );

    await user.click(screen.getByRole('button', { name: '生成 AI 报告' }));
    await screen.findByText('清空前的旧流。');
    rerender(
      <AiReportPanel
        context={reportContext()}
        settings={SETTINGS}
        stream={stream}
        storageEpoch={1}
        storageDisabled
        onDraftReport={onDraftReport}
      />,
    );

    expect(await screen.findByText('尚未生成')).toBeVisible();
    expect(screen.queryByText('清空前的旧流。')).toBeNull();
    expect(screen.getByRole('button', { name: '生成 AI 报告' })).toHaveProperty('disabled', true);
    await waitFor(() => expect(onDraftReport).not.toHaveBeenCalled());
  });

  it('keeps the in-memory report while rendering no hidden report content on an inactive tab', async () => {
    const user = userEvent.setup();
    const stream = vi.fn<AiReportStreamer>(
      eventStream([{ type: 'delta', text: completeReport() }, { type: 'complete' }]),
    );
    const { rerender } = render(
      <AiReportPanel context={reportContext()} settings={SETTINGS} stream={stream} active />,
    );
    await user.click(screen.getByRole('button', { name: '生成 AI 报告' }));
    await screen.findByText('报告已完成');

    rerender(
      <AiReportPanel
        context={reportContext()}
        settings={SETTINGS}
        stream={stream}
        active={false}
      />,
    );
    expect(screen.queryByText('报告已完成')).toBeNull();
    expect(screen.queryByText('仅包含历史日线收盘数据')).toBeNull();

    rerender(
      <AiReportPanel context={reportContext()} settings={SETTINGS} stream={stream} active />,
    );
    expect(screen.getByText('报告已完成')).toBeVisible();
    expect(stream).toHaveBeenCalledOnce();
  });
});
