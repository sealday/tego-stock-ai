import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { createChart } from 'lightweight-charts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StockWorkspace } from '../../src/components/workspace/StockWorkspace';
import {
  isoDate,
  stockCode,
  type DailyPrice,
  type MarketEnvelope,
  type MarketSnapshotStatus,
} from '../../src/domain/stock';
import {
  aggregateWorkspaceDataStatus,
  createWorkspaceAnalysis,
  deriveMarketState,
  formatShanghaiTimestamp,
  toShanghaiIsoDate,
  useStockWorkspace,
  type StockWorkspaceState,
  type WorkspaceFetchClient,
  type WorkspaceResource,
} from '../../src/hooks/use-stock-workspace';

vi.mock('lightweight-charts', () => {
  const createSeries = () => ({ setData: vi.fn() });
  return {
    CandlestickSeries: 'CandlestickSeries',
    HistogramSeries: 'HistogramSeries',
    LineSeries: 'LineSeries',
    createChart: vi.fn(() => ({
      addSeries: vi.fn(createSeries),
      applyOptions: vi.fn(),
      remove: vi.fn(),
      timeScale: vi.fn(() => ({ fitContent: vi.fn() })),
    })),
  };
});

const CODE = stockCode('600519.SH');
const AS_OF = isoDate('2026-07-17');

function envelope<T>(
  data: T,
  options: Partial<Omit<MarketEnvelope<T>, 'data'>> = {},
): MarketEnvelope<T> {
  return {
    data,
    asOf: AS_OF,
    source: 'Tushare Pro',
    freshness: 'fresh',
    availability: {},
    limitations: ['仅包含日线收盘数据'],
    ...options,
  };
}

function historyFixture(): readonly DailyPrice[] {
  return Array.from({ length: 70 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 4, 9 + index));
    const close = 1320 + index * 1.6;
    return {
      code: CODE,
      date: isoDate(date.toISOString().slice(0, 10)),
      open: close - 2,
      high: close + 5,
      low: close - 6,
      close,
      volumeShares: 2_000_000 + index * 10_000,
      turnoverCny: 2_800_000_000 + index * 15_000_000,
      adjustmentFactor: 1,
    };
  });
}

function readyState(overrides: Partial<StockWorkspaceState> = {}): StockWorkspaceState {
  const history = historyFixture();
  const overview = {
    code: CODE,
    name: '贵州茅台',
    date: AS_OF,
    close: 1430.4,
    previousClose: 1420,
    changePercent: 0.7324,
    peTtm: null,
    pb: 8.1,
    totalMarketValueCny: 1_796_000_000_000,
  };
  const fundamentals = {
    code: CODE,
    date: AS_OF,
    roe: 0.31,
    grossMargin: 0.91,
    revenueGrowth: null,
    profitGrowth: 0.16,
    operatingCashToNetProfit: 1.08,
    debtToAssets: 0.12,
  };

  return {
    code: CODE,
    cutoff: AS_OF,
    source: 'Tushare Pro',
    freshness: 'stale',
    dataStatus: 'stale',
    marketState: '市场状态延迟',
    lastSuccessfulAt: '2026-07-17T08:31:00.000Z',
    overview: {
      status: 'success',
      envelope: envelope(overview, {
        freshness: 'stale',
        availability: {
          peTtm: { status: 'missing', reason: '当前权限未返回市盈率' },
        },
      }),
    },
    history: { status: 'success', envelope: envelope(history) },
    fundamentals: {
      status: 'success',
      envelope: envelope(fundamentals, {
        availability: {
          revenueGrowth: { status: 'missing', reason: '当前报告期未披露营收增长' },
        },
      }),
    },
    marketStatus: {
      status: 'success',
      envelope: envelope(
        {
          asOf: AS_OF,
          lastSuccessfulAt: '2026-07-17T08:31:00.000Z',
          nextExpectedCloseAt: '2026-07-20T07:00:00.000Z',
          freshness: 'stale',
        },
        { freshness: 'stale' },
      ),
    },
    analysis: createWorkspaceAnalysis({
      history: envelope(history),
      overview: envelope(overview),
      fundamentals: envelope(fundamentals),
    }),
    ...overrides,
  };
}

function freshState(): StockWorkspaceState {
  const history = historyFixture();
  const overview = {
    code: CODE,
    name: '贵州茅台',
    date: AS_OF,
    close: 1430.4,
    previousClose: 1420,
    changePercent: 0.7324,
    peTtm: 24.6,
    pb: 8.1,
    totalMarketValueCny: 1_796_000_000_000,
  };
  const fundamentals = {
    code: CODE,
    date: AS_OF,
    roe: 0.31,
    grossMargin: 0.91,
    revenueGrowth: 0.12,
    profitGrowth: 0.16,
    operatingCashToNetProfit: 1.08,
    debtToAssets: 0.12,
  };

  return {
    code: CODE,
    cutoff: AS_OF,
    source: 'Tushare Pro',
    freshness: 'fresh',
    dataStatus: 'fresh',
    marketState: '已收盘',
    lastSuccessfulAt: '2026-07-17T08:31:00.000Z',
    overview: {
      status: 'success',
      envelope: envelope(overview, {
        limitations: ['仅包含日线收盘数据', '估值仅显示当前值'],
      }),
    },
    history: {
      status: 'success',
      envelope: envelope(history, { limitations: ['仅包含日线收盘数据'] }),
    },
    fundamentals: {
      status: 'success',
      envelope: envelope(fundamentals, { limitations: ['财务数据按报告期披露'] }),
    },
    marketStatus: {
      status: 'success',
      envelope: envelope(
        {
          asOf: AS_OF,
          lastSuccessfulAt: '2026-07-17T08:31:00.000Z',
          nextExpectedCloseAt: '2026-07-20T07:00:00.000Z',
          freshness: 'fresh',
        },
        { limitations: ['仅包含日线收盘数据'] },
      ),
    },
    analysis: createWorkspaceAnalysis({
      history: envelope(history),
      overview: envelope(overview),
      fundamentals: envelope(fundamentals),
    }),
  };
}

type WorkspaceEndpoint = 'overview' | 'history' | 'fundamentals' | 'marketStatus';

function validWorkspaceBodies(): Record<WorkspaceEndpoint, MarketEnvelope<unknown>> {
  const state = readyState();
  if (
    state.overview.status !== 'success' ||
    state.history.status !== 'success' ||
    state.fundamentals.status !== 'success' ||
    state.marketStatus.status !== 'success'
  ) {
    throw new Error('Expected successful workspace fixtures');
  }
  return {
    overview: state.overview.envelope,
    history: state.history.envelope,
    fundamentals: state.fundamentals.envelope,
    marketStatus: state.marketStatus.envelope,
  };
}

function workspaceFetchClient(
  bodies: Record<WorkspaceEndpoint, MarketEnvelope<unknown>>,
): WorkspaceFetchClient {
  return async (input) => {
    const url = String(input);
    if (url.includes('/overview')) {
      return Response.json(bodies.overview);
    }
    if (url.includes('/history')) {
      return Response.json(bodies.history);
    }
    if (url.includes('/fundamentals')) {
      return Response.json(bodies.fundamentals);
    }
    return Response.json(bodies.marketStatus);
  };
}

describe('StockWorkspace', () => {
  it('exposes all tabs, deterministic evidence, and the browser-only AI report controls', () => {
    render(<StockWorkspace state={readyState()} />);

    expect(screen.getByRole('heading', { name: '贵州茅台量化研究' })).toBeVisible();
    expect(screen.getByText('趋势评分')).toBeVisible();
    expect(screen.getByText('财务质量')).toBeVisible();
    expect(screen.getByText('估值位置')).toBeVisible();
    expect(screen.getByRole('heading', { name: '主要价格图' })).toBeVisible();
    expect(screen.getByText(/Copyright \(с\) 2025 TradingView/)).toBeVisible();
    expect(screen.getByText('Moving-average alignment')).toBeVisible();
    expect(screen.getAllByText(/加权贡献/).length).toBeGreaterThan(0);
    expect(screen.getByText('Price to earnings percentile')).toBeVisible();
    expect(screen.getAllByText('参考样本不足（0/4）').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: '数据限制' })).toBeVisible();
    expect(screen.getAllByText('仅包含日线收盘数据')).toHaveLength(1);
    expect(screen.queryByText(/Task 6/)).toBeNull();

    for (const tab of ['技术分析', '基本面', '财务趋势', 'AI 报告', '概览']) {
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      expect(screen.getByRole('tab', { name: tab }).getAttribute('aria-selected')).toBe('true');
    }

    fireEvent.click(screen.getByRole('tab', { name: 'AI 报告' }));
    expect(screen.getByRole('heading', { name: 'AI 提供商设置' })).toBeVisible();
    expect(screen.getByRole('button', { name: '生成 AI 报告' })).toBeVisible();
    expect(screen.getByText(/确定性分析摘要/)).toBeVisible();
  });

  it('keeps every tab control attached to a persistent hidden or visible tabpanel', () => {
    render(<StockWorkspace state={readyState()} />);

    for (const tab of screen.getAllByRole('tab')) {
      const panelId = tab.getAttribute('aria-controls');
      const panel = document.getElementById(panelId ?? '');
      expect(panel).not.toBeNull();
      expect(panel?.getAttribute('role')).toBe('tabpanel');
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);
      expect((panel as HTMLElement).hidden).toBe(tab.getAttribute('aria-selected') !== 'true');
    }
  });

  it('renders a fully fresh fixture with available metrics, score evidence, and limitations', () => {
    const state = freshState();
    render(<StockWorkspace state={state} />);

    expect(state.dataStatus).toBe('fresh');
    expect(screen.getByText('行情：可用')).toBeVisible();
    expect(screen.getByText('24.6 倍')).toBeVisible();
    expect(screen.getByText('Revenue growth')).toBeVisible();
    expect(screen.getAllByText(/加权贡献/).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: '数据限制' })).toBeVisible();
    expect(screen.getAllByText('仅包含日线收盘数据')).toHaveLength(1);
    expect(screen.queryByText('缺失：未提供')).toBeNull();
  });

  it('preserves weighted contribution values that are already expressed as 0–100 points', () => {
    const state = readyState();
    const trend = state.analysis.trend;
    const observation = trend?.observations[0];
    if (trend === null || observation === undefined) {
      throw new Error('Expected a trend observation fixture');
    }

    render(
      <StockWorkspace
        state={{
          ...state,
          analysis: {
            ...state.analysis,
            trend: {
              ...trend,
              observations: [{ ...observation, weightedContribution: 40 }],
            },
          },
        }}
      />,
    );

    expect(screen.getByText(/加权贡献：40\.0 分/)).toBeVisible();
    expect(screen.queryByText(/加权贡献：4000\.0 分/)).toBeNull();
  });

  it('labels a zero daily change as flat instead of positive', () => {
    const state = readyState();
    if (state.overview.status !== 'success') {
      throw new Error('Expected an overview fixture');
    }
    render(
      <StockWorkspace
        state={{
          ...state,
          overview: {
            status: 'success',
            envelope: {
              ...state.overview.envelope,
              data: { ...state.overview.envelope.data, changePercent: 0 },
            },
          },
        }}
      />,
    );

    expect(screen.getByText('平盘 0.00%')).toBeVisible();
    expect(screen.queryByText('上涨 +0.00%')).toBeNull();
  });

  it('supports looping horizontal-tab keyboard navigation with roving focus', () => {
    render(<StockWorkspace state={readyState()} />);
    const overview = screen.getByRole('tab', { name: '概览' });
    overview.focus();

    fireEvent.keyDown(overview, { key: 'ArrowLeft' });
    const aiReport = screen.getByRole('tab', { name: 'AI 报告' });
    expect(document.activeElement).toBe(aiReport);
    expect(aiReport.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(aiReport, { key: 'Home' });
    expect(document.activeElement).toBe(overview);
    expect(overview.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(overview, { key: 'End' });
    expect(document.activeElement).toBe(aiReport);
    fireEvent.keyDown(aiReport, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(overview);
  });

  it('does not recreate the chart when identical props rerender', () => {
    const state = readyState();
    const createChartMock = vi.mocked(createChart);
    createChartMock.mockClear();
    const { rerender } = render(<StockWorkspace state={state} />);
    expect(createChartMock).toHaveBeenCalledTimes(1);

    rerender(<StockWorkspace state={state} />);

    expect(createChartMock).toHaveBeenCalledTimes(1);
  });

  it('shows the complete Lightweight Charts v5.2.0 attribution notice', () => {
    render(<StockWorkspace state={readyState()} />);

    const attribution = screen.getByRole('link', {
      name: 'TradingView Lightweight Charts™ Copyright (с) 2025 TradingView, Inc. https://www.tradingview.com/',
    });
    expect(attribution.getAttribute('href')).toBe('https://www.tradingview.com/');
  });

  it('associates the chart overlay label and announces the selected overlay', () => {
    render(<StockWorkspace state={readyState()} />);

    const selector = screen.getByRole('combobox', { name: '叠加指标' });
    const label = screen.getByText('叠加指标', { selector: 'label' });
    expect(selector.id).not.toBe('chart-overlay');
    expect(label.getAttribute('for')).toBe(selector.id);
    expect(screen.getByText(/当前叠加指标：MA5、MA20、MA60/)).toBeVisible();

    fireEvent.change(selector, { target: { value: 'bollinger' } });
    expect(screen.getByText(/当前叠加指标：布林带、MA5、MA20、MA60/)).toBeVisible();
  });

  it.each([
    { overview: { status: 'loading' } as const },
    { overview: { status: 'error', message: 'safe' } as const },
    {
      history: { status: 'success', envelope: envelope([]) } as const,
      analysis: createWorkspaceAnalysis({
        history: envelope([]),
        overview: null,
        fundamentals: null,
      }),
    },
  ])('keeps the required attribution visible when chart data is unavailable', (overrides) => {
    render(<StockWorkspace state={readyState(overrides)} />);

    expect(
      screen.getByRole('link', {
        name: 'TradingView Lightweight Charts™ Copyright (с) 2025 TradingView, Inc. https://www.tradingview.com/',
      }),
    ).toBeVisible();
  });

  it('shows each score cutoff at the exact source date', () => {
    const state = readyState();
    const analysis = {
      ...state.analysis,
      trend:
        state.analysis.trend === null
          ? null
          : { ...state.analysis.trend, cutoff: isoDate('2026-07-16') },
      quality:
        state.analysis.quality === null
          ? null
          : { ...state.analysis.quality, cutoff: isoDate('2026-07-15') },
      valuation:
        state.analysis.valuation === null
          ? null
          : { ...state.analysis.valuation, cutoff: isoDate('2026-07-17') },
    };
    render(<StockWorkspace state={readyState({ analysis })} />);

    for (const cutoff of ['2026-07-16', '2026-07-15', '2026-07-17']) {
      const timestamp = screen.getByText(`数据截止 ${cutoff}`);
      expect(timestamp.tagName).toBe('TIME');
      expect(timestamp.getAttribute('datetime')).toBe(cutoff);
    }
  });

  it('distinguishes delayed market snapshots from other delayed resources', () => {
    const staleMarket = readyState();
    const { unmount } = render(<StockWorkspace state={staleMarket} />);
    expect(
      screen.getByText(
        (_content, element) =>
          element?.classList.contains('stale-banner') === true &&
          element.textContent?.includes('市场快照最后成功更新') === true,
      ),
    ).toBeVisible();
    unmount();

    const fresh = freshState();
    if (fresh.history.status !== 'success') {
      throw new Error('Expected history fixture');
    }
    render(
      <StockWorkspace
        state={{
          ...fresh,
          freshness: 'stale',
          dataStatus: 'stale',
          history: {
            status: 'success',
            envelope: { ...fresh.history.envelope, freshness: 'stale' },
          },
        }}
      />,
    );
    expect(screen.getByText('数据含延迟项')).toBeVisible();
    expect(screen.queryByText(/市场快照最后成功更新/)).toBeNull();
  });

  it('shows an unavailable cutoff when no successful market-data envelope exists', () => {
    render(<StockWorkspace state={readyState({ cutoff: null })} />);

    expect(screen.getByText('不可用', { selector: '.workspace-provenance dd' })).toBeVisible();
    expect(screen.queryByText('null')).toBeNull();
  });

  it('discloses missing, stale, and endpoint-error states while preserving usable panels', () => {
    render(
      <StockWorkspace
        state={readyState({
          fundamentals: { status: 'error', message: '基本面数据暂时不可用' },
        })}
      />,
    );

    expect(
      screen.getByText(
        (_content, element) => element?.tagName === 'P' && element.textContent === '上涨 +0.73%',
      ),
    ).toBeVisible();
    expect(screen.getByText('缺失：当前权限未返回市盈率')).toBeVisible();
    expect(screen.getAllByText(/数据延迟/).length).toBeGreaterThan(0);
    expect(screen.getByText('2026-07-17 16:31:00')).toBeVisible();
    expect(screen.getAllByText('Tushare Pro').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2026-07-17').length).toBeGreaterThan(0);
    expect(screen.getByText(/仅供研究与教育使用，不构成投资建议/)).toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: '基本面' }));
    expect(screen.getByRole('alert').textContent).toContain('基本面数据暂时不可用');

    fireEvent.click(screen.getByRole('tab', { name: '技术分析' }));
    expect(screen.getByRole('heading', { name: '价格与成交量' })).toBeVisible();
    expect(screen.getByText(/Copyright \(с\) 2025 TradingView/)).toBeVisible();
  });

  it('shows explicit current-period limitations instead of fabricating a trend series', () => {
    render(<StockWorkspace state={readyState()} />);
    fireEvent.click(screen.getByRole('tab', { name: '财务趋势' }));

    expect(screen.getByRole('columnheader', { name: '报告期' })).toBeVisible();
    expect(screen.getByRole('columnheader', { name: '单位' })).toBeVisible();
    expect(screen.getByRole('columnheader', { name: '状态' })).toBeVisible();
    expect(screen.getByText('当前可用报告期：2026-07-17')).toBeVisible();
    expect(screen.getByText('缺失：当前报告期未披露营收增长')).toBeVisible();
    expect(screen.getByText('暂无可比历史，不生成推测序列。')).toBeVisible();
  });

  it('shows explicit unavailable and insufficient states for the overview price chart', () => {
    const sourceState = readyState();
    const { unmount } = render(
      <StockWorkspace
        state={readyState({
          history: { status: 'error', message: '历史行情暂时不可用' },
        })}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('主要价格图不可用：历史行情暂时不可用');
    unmount();

    render(
      <StockWorkspace
        state={readyState({
          history: { status: 'success', envelope: envelope([]) },
          analysis: createWorkspaceAnalysis({
            history: envelope([]),
            overview:
              sourceState.overview.status === 'success' ? sourceState.overview.envelope : null,
            fundamentals:
              sourceState.fundamentals.status === 'success'
                ? sourceState.fundamentals.envelope
                : null,
          }),
        })}
      />,
    );
    expect(screen.getByText('历史数据不足，无法显示主要价格图。')).toBeVisible();
  });

  it('shows loading score semantics before the source requests settle', () => {
    const fetchClient = vi.fn<WorkspaceFetchClient>(() => new Promise(() => undefined));
    function Harness() {
      const state = useStockWorkspace({ code: CODE, asOf: AS_OF, fetchClient });
      return <StockWorkspace state={state} />;
    }
    render(<Harness />);

    expect(screen.getAllByText('对应数据加载中')).toHaveLength(3);
    expect(screen.queryByText('对应数据不可用')).toBeNull();
    expect(fetchClient).toHaveBeenCalledTimes(4);
  });

  it('preserves independent analysis and charts when the overview endpoint fails', () => {
    const state = readyState();
    const createChartMock = vi.mocked(createChart);
    createChartMock.mockClear();
    render(
      <StockWorkspace
        state={{
          ...state,
          overview: { status: 'error', message: '行情概览暂时不可用' },
          analysis: { ...state.analysis, valuation: null },
        }}
      />,
    );

    expect(screen.getByRole('alert').textContent).toContain('行情概览暂时不可用');
    expect(screen.getByText('趋势评分')).toBeVisible();
    expect(screen.getByText('财务质量')).toBeVisible();
    expect(screen.getByText('估值位置')).toBeVisible();
    expect(screen.getAllByText('数据截止 2026-07-17')).toHaveLength(2);
    expect(screen.getByText('对应数据不可用')).toBeVisible();
    expect(screen.getByRole('heading', { name: '主要价格图' })).toBeVisible();
    expect(createChartMock).toHaveBeenCalledTimes(1);
  });
});

describe('workspace status derivation', () => {
  const freshMarketStatus = (): WorkspaceResource<MarketSnapshotStatus> => ({
    status: 'success',
    envelope: envelope({
      asOf: AS_OF,
      lastSuccessfulAt: '2026-07-17T08:31:00.000Z',
      nextExpectedCloseAt: '2026-07-20T07:00:00.000Z',
      freshness: 'fresh' as const,
    }),
  });

  it.each([
    ['2026-07-20T01:29:00.000Z', '未开盘'],
    ['2026-07-20T01:30:00.000Z', '交易时段（非实时）'],
    ['2026-07-20T03:29:00.000Z', '交易时段（非实时）'],
    ['2026-07-20T03:30:00.000Z', '午间休市'],
    ['2026-07-20T04:59:00.000Z', '午间休市'],
    ['2026-07-20T05:00:00.000Z', '交易时段（非实时）'],
    ['2026-07-20T06:59:00.000Z', '交易时段（非实时）'],
    ['2026-07-20T07:00:00.000Z', '已收盘'],
  ])('uses Shanghai trading boundaries at %s', (now, expected) => {
    expect(deriveMarketState(freshMarketStatus(), new Date(now))).toBe(expected);
  });

  it('reports closed-market days and delayed snapshots without using machine local time', () => {
    expect(deriveMarketState(freshMarketStatus(), new Date('2026-07-19T04:00:00.000Z'))).toBe(
      '休市',
    );
    const stale = freshMarketStatus();
    if (stale.status !== 'success') {
      throw new Error('Expected fixture success');
    }
    expect(
      deriveMarketState(
        {
          status: 'success',
          envelope: {
            ...stale.envelope,
            freshness: 'stale',
            data: { ...stale.envelope.data, freshness: 'stale' },
          },
        },
        new Date('2026-07-20T01:30:00.000Z'),
      ),
    ).toBe('市场状态延迟');
    expect(deriveMarketState({ status: 'loading' }, new Date())).toBe('市场状态加载中');
    expect(deriveMarketState({ status: 'error', message: 'safe' }, new Date())).toBe(
      '市场状态不可用',
    );
  });

  it.each([
    [[{ status: 'loading' }], 'loading'],
    [[{ status: 'error', message: 'safe' }], 'error'],
    [
      [
        { status: 'success', envelope: envelope({ value: 1 }) },
        { status: 'error', message: 'safe' },
      ],
      'partial',
    ],
    [[{ status: 'success', envelope: envelope({ value: 1 }) }], 'fresh'],
    [
      [
        { status: 'success', envelope: envelope({ value: 1 }, { freshness: 'stale' }) },
        { status: 'loading' },
      ],
      'loading',
    ],
  ] as const)('aggregates resource state with precedence: %s -> %s', (resources, expected) => {
    expect(aggregateWorkspaceDataStatus(resources)).toBe(expected);
  });

  it('formats audit timestamps in explicit Asia/Shanghai time', () => {
    expect(formatShanghaiTimestamp('2026-07-17T08:31:00.000Z')).toBe('2026-07-17 16:31:00');
  });

  it('derives request dates from Asia/Shanghai across the UTC date boundary', () => {
    expect(toShanghaiIsoDate(new Date('2026-07-17T15:59:59.000Z'))).toBe('2026-07-17');
    expect(toShanghaiIsoDate(new Date('2026-07-17T16:00:00.000Z'))).toBe('2026-07-18');
  });

  it('derives daily return from the final two history rows only', () => {
    const history = historyFixture();
    const analysis = createWorkspaceAnalysis({
      history: envelope(history),
      overview: envelope({
        code: CODE,
        name: '贵州茅台',
        date: AS_OF,
        close: 1,
        previousClose: 100,
        changePercent: -99,
        peTtm: 20,
        pb: 8,
        totalMarketValueCny: 1,
      }),
      fundamentals: null,
    });
    const volumeConfirmation = analysis.trend?.observations.find(
      (observation) => observation.key === 'volumeConfirmation',
    );
    const latest = history.at(-1);
    const previous = history.at(-2);
    if (latest === undefined || previous === undefined) {
      throw new Error('Expected two history rows');
    }

    expect(volumeConfirmation?.raw).toMatchObject({
      dailyReturn: latest.close / previous.close - 1,
    });
  });
});

describe('useStockWorkspace', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads four resources in parallel, isolates failure, and aborts on cleanup', async () => {
    const sourceState = readyState();
    const signals: AbortSignal[] = [];
    const fetchClient: WorkspaceFetchClient = vi.fn(async (input, init) => {
      const url = String(input);
      if (init?.signal instanceof AbortSignal) {
        signals.push(init.signal);
      }
      if (url.includes('/fundamentals')) {
        return new Response(JSON.stringify({ error: { code: 'PROVIDER_PERMISSION_DENIED' } }), {
          status: 503,
        });
      }
      if (url.includes('/overview')) {
        return Response.json(
          sourceState.overview.status === 'success' ? sourceState.overview.envelope : {},
        );
      }
      if (url.includes('/history')) {
        return Response.json(
          sourceState.history.status === 'success' ? sourceState.history.envelope : {},
        );
      }
      return Response.json(
        sourceState.marketStatus.status === 'success' ? sourceState.marketStatus.envelope : {},
      );
    });

    const { result, unmount } = renderHook(() =>
      useStockWorkspace({ code: CODE, asOf: AS_OF, fetchClient }),
    );

    expect(result.current.overview.status).toBe('loading');
    await waitFor(() => expect(result.current.history.status).toBe('success'));
    expect(result.current.overview.status).toBe('success');
    expect(result.current.fundamentals).toEqual({
      status: 'error',
      message: '该数据项暂时不可用，请稍后重试。',
    });
    expect(fetchClient).toHaveBeenCalledTimes(4);
    expect(fetchClient).toHaveBeenCalledWith(
      '/api/stocks/600519.SH/history?start=2025-07-17&end=2026-07-17&adjust=forward',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    unmount();
    expect(signals).toHaveLength(4);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('turns a malformed envelope into one safe resource error', async () => {
    const sourceState = readyState();
    const fetchClient: WorkspaceFetchClient = async (input) => {
      const url = String(input);
      if (url.includes('/overview')) {
        return Response.json({ data: { close: 'not-a-number' } });
      }
      if (url.includes('/history')) {
        return Response.json(
          sourceState.history.status === 'success' ? sourceState.history.envelope : {},
        );
      }
      if (url.includes('/fundamentals')) {
        return Response.json(
          sourceState.fundamentals.status === 'success' ? sourceState.fundamentals.envelope : {},
        );
      }
      return Response.json(
        sourceState.marketStatus.status === 'success' ? sourceState.marketStatus.envelope : {},
      );
    };

    const { result } = renderHook(() =>
      useStockWorkspace({ code: CODE, asOf: AS_OF, fetchClient }),
    );

    await waitFor(() => expect(result.current.overview.status).toBe('error'));
    expect(result.current.history.status).toBe('success');
    expect(result.current.fundamentals.status).toBe('success');
    expect(result.current.overview).toEqual({
      status: 'error',
      message: '该数据项暂时不可用，请稍后重试。',
    });
  });

  it.each([
    ['zero OHLC', (rows: readonly DailyPrice[]) => [{ ...rows[0], close: 0 }, ...rows.slice(1)]],
    [
      'negative volume',
      (rows: readonly DailyPrice[]) => [{ ...rows[0], volumeShares: -1 }, ...rows.slice(1)],
    ],
    [
      'negative turnover',
      (rows: readonly DailyPrice[]) => [{ ...rows[0], turnoverCny: -1 }, ...rows.slice(1)],
    ],
    [
      'invalid OHLC bounds',
      (rows: readonly DailyPrice[]) => [
        { ...rows[0], high: (rows[0]?.open ?? 1) - 1 },
        ...rows.slice(1),
      ],
    ],
    [
      'zero adjustment factor',
      (rows: readonly DailyPrice[]) => [{ ...rows[0], adjustmentFactor: 0 }, ...rows.slice(1)],
    ],
    ['duplicate date', (rows: readonly DailyPrice[]) => [...rows, { ...rows[0] }]],
    [
      'out-of-range date',
      (rows: readonly DailyPrice[]) => [
        { ...rows[0], date: isoDate('2025-07-16') },
        ...rows.slice(1),
      ],
    ],
    [
      'wrong stock code',
      (rows: readonly DailyPrice[]) => [
        { ...rows[0], code: stockCode('000001.SZ') },
        ...rows.slice(1),
      ],
    ],
  ] as const)('rejects %s history without crashing analysis', async (_label, mutate) => {
    const bodies = validWorkspaceBodies();
    const rows = bodies.history.data as readonly DailyPrice[];
    bodies.history = { ...bodies.history, data: mutate(rows) };
    const fetchClient = workspaceFetchClient(bodies);

    const { result } = renderHook(() =>
      useStockWorkspace({ code: CODE, asOf: AS_OF, fetchClient }),
    );

    await waitFor(() => expect(result.current.history.status).toBe('error'));
    expect(result.current.overview.status).toBe('success');
    expect(result.current.fundamentals.status).toBe('success');
    expect(result.current.analysis.trend).toBeNull();
  });

  it.each(['overview', 'fundamentals'] as const)(
    'rejects a wrong stock code from %s',
    async (endpoint) => {
      const bodies = validWorkspaceBodies();
      bodies[endpoint] = {
        ...bodies[endpoint],
        data: {
          ...(bodies[endpoint].data as Record<string, unknown>),
          code: '000001.SZ',
        },
      };
      const fetchClient = workspaceFetchClient(bodies);

      const { result } = renderHook(() =>
        useStockWorkspace({ code: CODE, asOf: AS_OF, fetchClient }),
      );

      await waitFor(() => expect(result.current[endpoint].status).toBe('error'));
    },
  );

  it.each([
    ['blank name', { name: '   ' }],
    ['non-positive close', { close: 0 }],
    ['non-positive previous close', { previousClose: 0 }],
    ['negative market value', { totalMarketValueCny: -1 }],
  ] as const)('rejects overview with %s', async (_label, mutation) => {
    const bodies = validWorkspaceBodies();
    bodies.overview = {
      ...bodies.overview,
      data: { ...(bodies.overview.data as Record<string, unknown>), ...mutation },
    };
    const fetchClient = workspaceFetchClient(bodies);

    const { result } = renderHook(() =>
      useStockWorkspace({ code: CODE, asOf: AS_OF, fetchClient }),
    );

    await waitFor(() => expect(result.current.overview.status).toBe('error'));
    expect(result.current.overview).toEqual({
      status: 'error',
      message: '该数据项暂时不可用，请稍后重试。',
    });
  });

  it.each([
    [
      'overview',
      (bodies: Record<WorkspaceEndpoint, MarketEnvelope<unknown>>) => {
        bodies.overview = { ...bodies.overview, asOf: isoDate('2026-07-18') };
      },
    ],
    [
      'overview',
      (bodies: Record<WorkspaceEndpoint, MarketEnvelope<unknown>>) => {
        bodies.overview = {
          ...bodies.overview,
          data: { ...(bodies.overview.data as Record<string, unknown>), date: '2026-07-16' },
        };
      },
    ],
    [
      'history',
      (bodies: Record<WorkspaceEndpoint, MarketEnvelope<unknown>>) => {
        bodies.history = { ...bodies.history, asOf: isoDate('2026-07-16') };
      },
    ],
    [
      'history',
      (bodies: Record<WorkspaceEndpoint, MarketEnvelope<unknown>>) => {
        bodies.history = {
          ...bodies.history,
          asOf: isoDate('2025-07-16'),
          data: [],
        };
      },
    ],
    [
      'history',
      (bodies: Record<WorkspaceEndpoint, MarketEnvelope<unknown>>) => {
        bodies.history = {
          ...bodies.history,
          data: (bodies.history.data as readonly DailyPrice[]).filter(
            (row) => row.date < '2026-07-17',
          ),
        };
      },
    ],
    [
      'history',
      (bodies: Record<WorkspaceEndpoint, MarketEnvelope<unknown>>) => {
        bodies.history = { ...bodies.history, asOf: isoDate('2026-07-18') };
      },
    ],
    [
      'fundamentals',
      (bodies: Record<WorkspaceEndpoint, MarketEnvelope<unknown>>) => {
        bodies.fundamentals = {
          ...bodies.fundamentals,
          asOf: isoDate('2026-07-16'),
          data: { ...(bodies.fundamentals.data as Record<string, unknown>), date: '2026-07-17' },
        };
      },
    ],
    [
      'fundamentals',
      (bodies: Record<WorkspaceEndpoint, MarketEnvelope<unknown>>) => {
        bodies.fundamentals = { ...bodies.fundamentals, asOf: isoDate('2026-07-18') };
      },
    ],
    [
      'marketStatus',
      (bodies: Record<WorkspaceEndpoint, MarketEnvelope<unknown>>) => {
        bodies.marketStatus = {
          ...bodies.marketStatus,
          data: {
            ...(bodies.marketStatus.data as Record<string, unknown>),
            freshness: 'fresh',
          },
          freshness: 'stale',
        };
      },
    ],
    [
      'marketStatus',
      (bodies: Record<WorkspaceEndpoint, MarketEnvelope<unknown>>) => {
        bodies.marketStatus = {
          ...bodies.marketStatus,
          data: { ...(bodies.marketStatus.data as Record<string, unknown>), asOf: '2026-07-16' },
        };
      },
    ],
  ] as const)('rejects future or inconsistent %s cutoff identity', async (endpoint, mutate) => {
    const bodies = validWorkspaceBodies();
    mutate(bodies);
    const fetchClient = workspaceFetchClient(bodies);
    const { result } = renderHook(() =>
      useStockWorkspace({ code: CODE, asOf: AS_OF, fetchClient }),
    );

    await waitFor(() => expect(result.current[endpoint].status).toBe('error'));
  });

  it.each([
    '2024-02-29T00:00:00Z',
    '2026-07-17T08:31:00.123456+08:00',
    '2026-07-17T08:31:00-00:00',
    '2026-07-17T08:31:00+23:59',
  ])('accepts valid RFC3339 market status timestamp %s', async (timestamp) => {
    const bodies = validWorkspaceBodies();
    bodies.marketStatus = {
      ...bodies.marketStatus,
      data: {
        ...(bodies.marketStatus.data as Record<string, unknown>),
        lastSuccessfulAt: timestamp,
      },
    };
    const fetchClient = workspaceFetchClient(bodies);

    const { result } = renderHook(() =>
      useStockWorkspace({ code: CODE, asOf: AS_OF, fetchClient }),
    );

    await waitFor(() => expect(result.current.marketStatus.status).toBe('success'));
  });

  it.each([
    '1',
    '2026-02-30T08:31:00Z',
    '2026-07-17T24:00:00Z',
    '2026-13-17T08:31:00Z',
    '2026-00-17T08:31:00Z',
    '2026-07-00T08:31:00Z',
    '2026-07-17T08:60:00Z',
    '2026-07-17T08:31:60Z',
    '2026-07-17T08:31:00+24:00',
    '2026-07-17T08:31:00+08:60',
    '2026-07-17T08:31:00',
  ])('rejects invalid RFC3339 market status timestamp %s', async (timestamp) => {
    const bodies = validWorkspaceBodies();
    bodies.marketStatus = {
      ...bodies.marketStatus,
      data: {
        ...(bodies.marketStatus.data as Record<string, unknown>),
        lastSuccessfulAt: timestamp,
      },
    };
    const fetchClient = workspaceFetchClient(bodies);

    const { result } = renderHook(() =>
      useStockWorkspace({ code: CODE, asOf: AS_OF, fetchClient }),
    );

    await waitFor(() => expect(result.current.marketStatus.status).toBe('error'));
  });

  it.each(['lastSuccessfulAt', 'nextExpectedCloseAt'] as const)(
    'validates both market status %s timestamp fields',
    async (field) => {
      const bodies = validWorkspaceBodies();
      bodies.marketStatus = {
        ...bodies.marketStatus,
        data: { ...(bodies.marketStatus.data as Record<string, unknown>), [field]: '1' },
      };
      const fetchClient = workspaceFetchClient(bodies);

      const { result } = renderHook(() =>
        useStockWorkspace({ code: CODE, asOf: AS_OF, fetchClient }),
      );

      await waitFor(() => expect(result.current.marketStatus.status).toBe('error'));
    },
  );

  it('binds visible resources to the current request key during a synchronous stock switch', async () => {
    const bodies = validWorkspaceBodies();
    let pending = false;
    const fetchClient = vi.fn<WorkspaceFetchClient>(async (input) => {
      if (pending) {
        return new Promise<Response>(() => undefined);
      }
      return workspaceFetchClient(bodies)(input);
    });
    let synchronousSwitch: StockWorkspaceState | undefined;
    const nextCode = stockCode('000001.SZ');
    const { result, rerender } = renderHook(
      ({ code }) => {
        const state = useStockWorkspace({ code, asOf: AS_OF, fetchClient });
        if (code === nextCode && synchronousSwitch === undefined) {
          synchronousSwitch = state;
        }
        return state;
      },
      { initialProps: { code: CODE } },
    );
    await waitFor(() => expect(result.current.overview.status).toBe('success'));

    pending = true;
    rerender({ code: nextCode });

    expect(synchronousSwitch?.overview.status).toBe('loading');
    expect(synchronousSwitch?.history.status).toBe('loading');
    expect(synchronousSwitch?.fundamentals.status).toBe('loading');
    expect(synchronousSwitch?.marketStatus.status).toBe('success');
    expect(fetchClient).toHaveBeenCalledTimes(7);
  });

  it('uses resource envelope dates for analysis and the earliest data cutoff on lagged weekends', async () => {
    const bodies = validWorkspaceBodies();
    bodies.overview = { ...bodies.overview, asOf: isoDate('2026-07-17') };
    bodies.history = {
      ...bodies.history,
      asOf: isoDate('2026-07-16'),
      data: (bodies.history.data as readonly DailyPrice[]).filter(
        (row) => row.date <= '2026-07-16',
      ),
    };
    bodies.fundamentals = {
      ...bodies.fundamentals,
      asOf: isoDate('2026-07-15'),
      data: { ...(bodies.fundamentals.data as Record<string, unknown>), date: '2026-07-15' },
    };
    bodies.marketStatus = {
      ...bodies.marketStatus,
      asOf: isoDate('2026-07-18'),
      data: { ...(bodies.marketStatus.data as Record<string, unknown>), asOf: '2026-07-18' },
    };
    const fetchClient = workspaceFetchClient(bodies);

    const { result } = renderHook(() =>
      useStockWorkspace({
        code: CODE,
        asOf: isoDate('2026-07-18'),
        fetchClient,
      }),
    );
    await waitFor(() => expect(result.current.dataStatus).toBe('stale'));

    expect(result.current.cutoff).toBe('2026-07-15');
    expect(result.current.analysis.trend?.cutoff).toBe('2026-07-16');
    expect(result.current.analysis.quality?.cutoff).toBe('2026-07-15');
    expect(result.current.analysis.valuation?.cutoff).toBe('2026-07-17');
  });

  it('does not invent a valuation cutoff when overview fails', async () => {
    const bodies = validWorkspaceBodies();
    bodies.history = {
      ...bodies.history,
      asOf: isoDate('2026-07-16'),
      data: (bodies.history.data as readonly DailyPrice[]).filter(
        (row) => row.date <= '2026-07-16',
      ),
    };
    bodies.fundamentals = {
      ...bodies.fundamentals,
      asOf: isoDate('2026-07-15'),
      data: { ...(bodies.fundamentals.data as Record<string, unknown>), date: '2026-07-15' },
    };
    const fetchClient: WorkspaceFetchClient = async (input) =>
      String(input).includes('/overview')
        ? new Response(null, { status: 503 })
        : workspaceFetchClient(bodies)(input);

    const { result } = renderHook(() =>
      useStockWorkspace({
        code: CODE,
        asOf: isoDate('2026-07-18'),
        fetchClient,
      }),
    );
    await waitFor(() => expect(result.current.overview.status).toBe('error'));

    expect(result.current.cutoff).toBe('2026-07-15');
    expect(result.current.analysis.valuation).toBeNull();
    expect(result.current.analysis.trend?.cutoff).toBe('2026-07-16');
    expect(result.current.analysis.quality?.cutoff).toBe('2026-07-15');
  });

  it('reports an unavailable cutoff and analysis when every market-data resource fails', async () => {
    const bodies = validWorkspaceBodies();
    const fetchClient: WorkspaceFetchClient = async (input) =>
      String(input).includes('/market/status')
        ? Response.json(bodies.marketStatus)
        : new Response(null, { status: 503 });

    const { result } = renderHook(() =>
      useStockWorkspace({ code: CODE, asOf: AS_OF, fetchClient }),
    );
    await waitFor(() => expect(result.current.overview.status).toBe('error'));
    await waitFor(() => expect(result.current.history.status).toBe('error'));
    await waitFor(() => expect(result.current.fundamentals.status).toBe('error'));

    expect(result.current.cutoff).toBeNull();
    expect(result.current.analysis.trend).toBeNull();
    expect(result.current.analysis.quality).toBeNull();
    expect(result.current.analysis.valuation).toBeNull();
  });

  it('keeps technical analysis stable while overview and fundamentals settle later', async () => {
    const bodies = validWorkspaceBodies();
    const resolvers = new Map<WorkspaceEndpoint, (response: Response) => void>();
    const fetchClient = vi.fn<WorkspaceFetchClient>((input) => {
      const url = String(input);
      const endpoint: WorkspaceEndpoint = url.includes('/overview')
        ? 'overview'
        : url.includes('/history')
          ? 'history'
          : url.includes('/fundamentals')
            ? 'fundamentals'
            : 'marketStatus';
      return new Promise((resolve) => resolvers.set(endpoint, resolve));
    });
    const technicalReferences: Array<StockWorkspaceState['analysis']['technical']> = [];
    function Harness() {
      const state = useStockWorkspace({ code: CODE, asOf: AS_OF, fetchClient });
      technicalReferences.push(state.analysis.technical);
      return <StockWorkspace state={state} />;
    }
    const createChartMock = vi.mocked(createChart);
    createChartMock.mockClear();
    render(<Harness />);
    await waitFor(() => expect(resolvers.size).toBe(4));

    await act(async () => resolvers.get('marketStatus')?.(Response.json(bodies.marketStatus)));
    await act(async () => resolvers.get('history')?.(Response.json(bodies.history)));
    const technicalAfterHistory = technicalReferences.at(-1);
    expect(technicalAfterHistory).not.toBeNull();
    expect(createChartMock).toHaveBeenCalledTimes(1);

    await act(async () => resolvers.get('overview')?.(Response.json(bodies.overview)));
    expect(technicalReferences.at(-1)).toBe(technicalAfterHistory);
    expect(createChartMock).toHaveBeenCalledTimes(1);

    await act(async () => resolvers.get('fundamentals')?.(Response.json(bodies.fundamentals)));
    expect(technicalReferences.at(-1)).toBe(technicalAfterHistory);
    expect(createChartMock).toHaveBeenCalledTimes(1);
  });
});
