import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
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
    analysis: createWorkspaceAnalysis(history, overview, fundamentals, AS_OF),
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
    analysis: createWorkspaceAnalysis(history, overview, fundamentals, AS_OF),
  };
}

describe('StockWorkspace', () => {
  it('exposes all tabs and deterministic evidence before the Task 6 AI placeholder', () => {
    render(<StockWorkspace state={readyState()} />);

    expect(screen.getByRole('heading', { name: '贵州茅台量化研究' })).toBeVisible();
    expect(screen.getByText('趋势评分')).toBeVisible();
    expect(screen.getByText('财务质量')).toBeVisible();
    expect(screen.getByText('估值位置')).toBeVisible();
    expect(screen.getByRole('heading', { name: '主要价格图' })).toBeVisible();
    expect(screen.getByText('图表由 TradingView Lightweight Charts 提供')).toBeVisible();
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
    expect(screen.getByText(/Task 6 将提供/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /生成/ })).toBeNull();
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
    expect(screen.getByText('图表由 TradingView Lightweight Charts 提供')).toBeVisible();
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
          analysis: createWorkspaceAnalysis(
            [],
            sourceState.overview.status === 'success' ? sourceState.overview.envelope.data : null,
            sourceState.fundamentals.status === 'success'
              ? sourceState.fundamentals.envelope.data
              : null,
            AS_OF,
          ),
        })}
      />,
    );
    expect(screen.getByText('历史数据不足，无法显示主要价格图。')).toBeVisible();
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
      'stale',
    ],
  ] as const)('aggregates resource state with precedence: %s -> %s', (resources, expected) => {
    expect(aggregateWorkspaceDataStatus(resources)).toBe(expected);
  });

  it('formats audit timestamps in explicit Asia/Shanghai time', () => {
    expect(formatShanghaiTimestamp('2026-07-17T08:31:00.000Z')).toBe('2026-07-17 16:31:00');
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
});
