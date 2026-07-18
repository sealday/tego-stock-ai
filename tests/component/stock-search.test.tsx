import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalShell } from '../../src/components/layout/TerminalShell';
import { StockSearch, type StockSearchFunction } from '../../src/components/search/StockSearch';
import { stockCode, type StockSearchResult } from '../../src/domain/stock';

const MOUTAI: StockSearchResult = {
  code: stockCode('600519.SH'),
  name: '贵州茅台',
  pinyinAbbreviation: 'GZMT',
};

const PING_AN: StockSearchResult = {
  code: stockCode('000001.SZ'),
  name: '平安银行',
  pinyinAbbreviation: 'PAYH',
};

async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

describe('StockSearch', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('debounces for 300 ms and displays code, name, and pinyin while loading', async () => {
    vi.useFakeTimers();
    let resolveSearch: ((value: readonly StockSearchResult[]) => void) | undefined;
    const search = vi.fn<StockSearchFunction>(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        }),
    );
    render(<StockSearch onSelect={vi.fn()} search={search} />);
    fireEvent.change(screen.getByRole('combobox', { name: '搜索 A 股' }), {
      target: { value: 'gzmt' },
    });

    await advance(299);
    expect(search).not.toHaveBeenCalled();

    await advance(1);
    expect(search).toHaveBeenCalledOnce();
    expect(screen.getByText('正在搜索…')).toBeVisible();

    await act(async () => resolveSearch?.([MOUTAI]));

    expect(screen.getByRole('option', { name: /贵州茅台600519\.SHGZMT/ })).toBeVisible();
  });

  it('selects a result with ArrowDown and Enter', async () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    const search = vi.fn<StockSearchFunction>(async () => [MOUTAI, PING_AN]);
    render(<StockSearch onSelect={onSelect} search={search} />);
    const input = screen.getByRole('combobox', { name: '搜索 A 股' });
    fireEvent.change(input, { target: { value: '平安' } });
    await advance(300);
    screen.getByRole('option', { name: /贵州茅台/ });

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith(PING_AN);
    expect((input as HTMLInputElement).value).toBe('平安银行');
    await advance(300);
    expect(search).toHaveBeenCalledOnce();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows empty and safe error states without requesting an empty or short query', async () => {
    vi.useFakeTimers();
    const search = vi
      .fn<StockSearchFunction>()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('upstream token: secret'));
    render(<StockSearch onSelect={vi.fn()} search={search} />);
    const input = screen.getByRole('combobox', { name: '搜索 A 股' });

    fireEvent.change(input, { target: { value: '6' } });
    await advance(400);
    expect(search).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '600' } });
    await advance(300);
    expect(screen.getByText('未找到匹配的 A 股')).toBeVisible();

    fireEvent.change(input, { target: { value: '茅台' } });
    await advance(300);
    expect(screen.getByRole('alert').textContent).toContain('暂时无法搜索，请稍后重试。');
    expect(screen.queryByText(/secret/)).toBeNull();

    fireEvent.change(input, { target: { value: '' } });
    await advance(400);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('aborts a superseded request before starting the next search', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const search = vi.fn<StockSearchFunction>((_query, signal) => {
      signals.push(signal);
      return new Promise(() => undefined);
    });
    render(<StockSearch onSelect={vi.fn()} search={search} />);
    const input = screen.getByRole('combobox', { name: '搜索 A 股' });
    fireEvent.change(input, { target: { value: '600' } });
    await advance(300);
    expect(signals[0]?.aborted).toBe(false);

    fireEvent.change(input, { target: { value: '贵州' } });
    expect(signals[0]?.aborted).toBe(true);
    await advance(300);

    expect(search).toHaveBeenCalledTimes(2);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('rejects a malformed default API envelope with a safe message', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: [{ code: 1 }] }))),
    );
    render(<StockSearch onSelect={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox', { name: '搜索 A 股' }), {
      target: { value: '600519' },
    });
    await advance(300);

    expect(screen.getByRole('alert').textContent).toContain('暂时无法搜索，请稍后重试。');
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('TerminalShell', () => {
  it('keeps research navigation, selected stock, and data status accessible', () => {
    render(
      <TerminalShell
        selectedStock={MOUTAI}
        marketState="已收盘"
        source="Tushare Pro"
        cutoff="2026-07-17"
        dataStatus="stale"
        lastSuccessfulAt="2026-07-17T08:31:00.000Z"
        onStockSelect={vi.fn()}
        search={vi.fn<StockSearchFunction>()}
      >
        <h1 id="workspace-heading">A 股研究终端</h1>
      </TerminalShell>,
    );

    expect(screen.getByRole('link', { name: '跳到主要内容' }).getAttribute('href')).toBe(
      '#main-content',
    );
    expect(screen.getAllByRole('navigation', { name: '主导航' })).toHaveLength(2);
    expect(screen.getAllByText('市场分析').length).toBeGreaterThan(0);
    expect(screen.getAllByText('已保存 AI 报告').length).toBeGreaterThan(0);
    expect(screen.getAllByText('AI 设置').length).toBeGreaterThan(0);
    expect(screen.getAllByText('本地隐私').length).toBeGreaterThan(0);
    expect(screen.getAllByText('本地自选股').length).toBeGreaterThan(0);
    expect(screen.getByText('贵州茅台')).toBeVisible();
    expect(screen.getByText('600519.SH')).toBeVisible();
    expect(screen.getByText('已收盘')).toBeVisible();
    expect(screen.getByText('数据延迟')).toBeVisible();
    expect(screen.getAllByText(/2026-07-17/).length).toBeGreaterThan(0);
    expect(screen.getByText('Tushare Pro')).toBeVisible();
    expect(screen.getByText('展开导航')).toBeVisible();
    expect(screen.getByRole('group')).toBeVisible();
  });

  it.each([
    ['loading', '加载中'],
    ['fresh', '数据就绪'],
    ['stale', '数据延迟'],
    ['partial', '部分异常'],
    ['error', '不可用'],
  ] as const)('shows %s workspace data as %s', (dataStatus, label) => {
    render(
      <TerminalShell
        selectedStock={MOUTAI}
        marketState="已收盘"
        source="Tushare Pro"
        cutoff="2026-07-17"
        dataStatus={dataStatus}
        onStockSelect={vi.fn()}
        search={vi.fn<StockSearchFunction>()}
      >
        <h1>测试终端</h1>
      </TerminalShell>,
    );

    expect(screen.getByText(label)).toBeVisible();
  });
});
