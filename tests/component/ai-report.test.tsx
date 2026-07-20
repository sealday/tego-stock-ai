import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { AiStreamEvent } from '../../src/ai/client';
import { REPORT_SECTION_HEADINGS, type ReportContext } from '../../src/ai/report-contract';
import {
  AiReportPanel,
  type AiReportStreamer,
  type GeneratedAiReport,
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
    limitations: ['仅包含历史日线收盘数据'],
  };
}

function completeReport(firstSection = '数据截止 2026-07-17。'): string {
  return REPORT_SECTION_HEADINGS.map(
    (heading, index) => `## ${heading}\n${index === 0 ? firstSection : `第 ${index + 1} 节内容。`}`,
  ).join('\n\n');
}

function eventStream(events: readonly AiStreamEvent[]): AiReportStreamer {
  return async function* () {
    for (const event of events) {
      yield event;
    }
  };
}

describe('AiReportPanel', () => {
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
    const onSaveReport = vi.fn<(report: GeneratedAiReport) => void>();
    const { container } = render(
      <AiReportPanel
        context={reportContext()}
        settings={SETTINGS}
        stream={stream}
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
    expect(screen.getByText('完整报告已交给本地保存回调')).toBeVisible();
  });

  it('cancels an active stream and labels partial output as an interrupted draft', async () => {
    const user = userEvent.setup();
    const stream: AiReportStreamer = async function* (configuration) {
      yield { type: 'delta', text: '## 数据摘要与截止日期\n流式草稿内容。' };
      await new Promise<void>((resolve) => {
        configuration.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { type: 'aborted' };
    };
    render(<AiReportPanel context={reportContext()} settings={SETTINGS} stream={stream} />);

    await user.click(screen.getByRole('button', { name: '生成 AI 报告' }));
    await screen.findByText('流式草稿内容。');
    await user.click(screen.getByRole('button', { name: '取消生成' }));

    expect(await screen.findByText('未完成草稿 · 生成已取消')).toBeVisible();
    expect(screen.getByRole('button', { name: '仅重试 AI 生成' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '保存完整报告' })).toBeNull();
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

    await user.click(screen.getByRole('button', { name: '仅重试 AI 生成' }));
    await screen.findByText('报告已完成');
    expect(stream).toHaveBeenCalledTimes(2);
    expect(screen.getByText('趋势评分 78.2 / 100')).toBeVisible();
  });

  it('keeps an invalid completed response as a non-saveable interrupted draft', async () => {
    const user = userEvent.setup();
    const onSaveReport = vi.fn<(report: GeneratedAiReport) => void>();
    render(
      <AiReportPanel
        context={reportContext()}
        settings={SETTINGS}
        stream={eventStream([
          {
            type: 'delta',
            text: `${completeReport()}\n\n## 明确买卖建议\n不允许的章节。`,
          },
          { type: 'complete' },
        ])}
        onSaveReport={onSaveReport}
      />,
    );

    await user.click(screen.getByRole('button', { name: '生成 AI 报告' }));

    expect(await screen.findByText('未完成草稿 · 响应未通过七章节契约校验')).toBeVisible();
    expect(screen.getByRole('alert').textContent).toMatch(/AI 返回内容无效/);
    expect(screen.queryByRole('button', { name: '保存完整报告' })).toBeNull();
    expect(onSaveReport).not.toHaveBeenCalled();
  });

  it('marks a stream error after deltas as an interrupted draft', async () => {
    const user = userEvent.setup();
    render(
      <AiReportPanel
        context={reportContext()}
        settings={SETTINGS}
        stream={eventStream([
          { type: 'delta', text: '## 数据摘要与截止日期\n部分内容。' },
          { type: 'error', code: 'network', message: '无法连接 AI 提供商，请稍后重试。' },
        ])}
      />,
    );

    await user.click(screen.getByRole('button', { name: '生成 AI 报告' }));

    expect(await screen.findByText('未完成草稿 · 流式响应中断')).toBeVisible();
    expect(screen.getByRole('alert').textContent).toContain('无法连接 AI 提供商');
    expect(screen.getByText('部分内容。')).toBeVisible();
  });

  it('disables generation until the model and key are explicitly configured', () => {
    render(
      <AiReportPanel context={reportContext()} settings={{ ...SETTINGS, model: '', apiKey: '' }} />,
    );

    expect(screen.getByRole('button', { name: '生成 AI 报告' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/请先填写有效的 Base URL、模型和 API key/)).toBeVisible();
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
