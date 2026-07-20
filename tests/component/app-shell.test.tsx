import 'fake-indexeddb/auto';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App, type AppRepository } from '../../src/app/App';
import type { CompleteAiReport, DraftAiReport } from '../../src/ai/report-model';
import { stockCode, type StockSearchResult } from '../../src/domain/stock';
import { deleteLocalDatabase } from '../../src/storage/database';
import { LocalRepository } from '../../src/storage/repository';

const databases = new Set<string>();
let sequence = 0;
const BANK: StockSearchResult = {
  code: stockCode('000001.SZ'),
  name: '平安银行',
  pinyinAbbreviation: 'PAYH',
};

function repository(label: string): LocalRepository {
  sequence += 1;
  const name = `tego-stock-ai-app-${label}-${sequence}`;
  databases.add(name);
  return new LocalRepository({ name });
}

function appRepository(overrides: Partial<AppRepository> = {}): AppRepository {
  return {
    clearAll: vi.fn(async () => undefined),
    clearCredentials: vi.fn(async () => undefined),
    deleteReport: vi.fn(async () => undefined),
    getExportSnapshot: vi.fn(async () => ({ watchlist: [], settings: null, reports: [] })),
    getSettings: vi.fn(async () => null),
    listReports: vi.fn(async () => []),
    listWatchlist: vi.fn(async () => []),
    putWatchlistEntry: vi.fn(async () => undefined),
    removeWatchlistEntry: vi.fn(async () => undefined),
    saveReport: vi.fn(async (report: CompleteAiReport | DraftAiReport) => ({
      id: 'saved-report',
      savedAt: '2026-07-20T00:00:00.000Z',
      report,
    })),
    saveSettings: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('App', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all([...databases].map((name) => deleteLocalDatabase(name)));
    databases.clear();
  });

  it('identifies the daily-close research product and its safety boundary', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    render(<App />);

    expect(screen.getByRole('heading', { name: 'A 股研究终端' })).toBeVisible();
    expect(screen.getByText('市场状态加载中')).toBeVisible();
    expect(screen.getByText(/日线收盘研究/)).toBeVisible();
    expect(screen.getByText(/不构成投资建议/)).toBeVisible();
    expect(screen.getByRole('combobox', { name: '搜索 A 股' })).toBeVisible();
    expect(screen.getByRole('tab', { name: '概览' })).toBeVisible();
    expect(screen.getAllByText('市场分析').length).toBeGreaterThan(0);
  });

  it('persists selecting and deleting the current stock through the real local repository', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    const localRepository = repository('watchlist-persistence');
    const first = render(<App watchlistRepository={localRepository} />);

    await screen.findAllByText('尚未添加本地自选股。');
    fireEvent.click(screen.getAllByRole('button', { name: '添加贵州茅台到本地自选股' })[0]!);
    expect(await screen.findAllByRole('button', { name: '选择贵州茅台 600519.SH' })).toHaveLength(
      2,
    );
    await expect(localRepository.listWatchlist()).resolves.toHaveLength(1);

    first.unmount();
    render(<App watchlistRepository={localRepository} />);
    expect(await screen.findAllByRole('button', { name: '选择贵州茅台 600519.SH' })).toHaveLength(
      2,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '删除贵州茅台 600519.SH' })[0]!);
    await waitFor(() => expect(screen.getAllByText('尚未添加本地自选股。')).toHaveLength(2));
    await expect(localRepository.listWatchlist()).resolves.toEqual([]);
    await localRepository.close();
  });

  it('does not let a slow initial watchlist read overwrite a user add', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    const localRepository = repository('watchlist-race');
    let releaseHydration: ((stocks: readonly StockSearchResult[]) => void) | undefined;
    const putWatchlistEntry = vi.fn(localRepository.putWatchlistEntry.bind(localRepository));
    const delayedRepository = appRepository({
      listWatchlist: vi.fn(
        () =>
          new Promise<readonly StockSearchResult[]>((resolve) => {
            releaseHydration = resolve;
          }),
      ),
      putWatchlistEntry,
      removeWatchlistEntry: localRepository.removeWatchlistEntry.bind(localRepository),
    });
    render(<App watchlistRepository={delayedRepository} />);

    const addButtons = screen.getAllByRole('button', { name: '添加贵州茅台到本地自选股' });
    expect(addButtons.every((button) => button.hasAttribute('disabled'))).toBe(true);
    fireEvent.click(addButtons[0]!);
    expect(putWatchlistEntry).not.toHaveBeenCalled();
    releaseHydration?.([BANK]);

    expect(await screen.findAllByRole('button', { name: '选择平安银行 000001.SZ' })).toHaveLength(
      2,
    );
    fireEvent.click(screen.getAllByRole('button', { name: '添加贵州茅台到本地自选股' })[0]!);
    expect(await screen.findAllByRole('button', { name: '选择贵州茅台 600519.SH' })).toHaveLength(
      2,
    );
    expect(screen.getAllByRole('button', { name: '选择平安银行 000001.SZ' })).toHaveLength(2);
    await localRepository.close();
  });

  it('keeps watchlist mutations blocked until a failed initial hydration is retried', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    const listWatchlist = vi
      .fn<AppRepository['listWatchlist']>()
      .mockRejectedValueOnce(new Error('initial read failed'))
      .mockResolvedValueOnce([BANK]);
    const putWatchlistEntry = vi.fn<AppRepository['putWatchlistEntry']>().mockResolvedValue();
    render(
      <App
        watchlistRepository={appRepository({
          listWatchlist,
          putWatchlistEntry,
        })}
      />,
    );

    await screen.findAllByRole('alert');
    const blockedAddButtons = screen.getAllByRole('button', {
      name: '添加贵州茅台到本地自选股',
    });
    expect(blockedAddButtons.every((button) => button.hasAttribute('disabled'))).toBe(true);
    fireEvent.click(blockedAddButtons[0]!);
    expect(putWatchlistEntry).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: '重试本地自选股操作' })[0]!);
    expect(await screen.findAllByRole('button', { name: '选择平安银行 000001.SZ' })).toHaveLength(
      2,
    );
    fireEvent.click(screen.getAllByRole('button', { name: '添加贵州茅台到本地自选股' })[0]!);

    expect(await screen.findAllByRole('button', { name: '选择贵州茅台 600519.SH' })).toHaveLength(
      2,
    );
    expect(screen.getAllByRole('button', { name: '选择平安银行 000001.SZ' })).toHaveLength(2);
    expect(putWatchlistEntry).toHaveBeenCalledOnce();
  });

  it('keeps watchlist failures safe and retries the failed action without storage details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    const putWatchlistEntry = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('IndexedDB internal diagnostic'))
      .mockResolvedValue(undefined);
    render(
      <App
        watchlistRepository={appRepository({
          listWatchlist: vi.fn(async () => []),
          putWatchlistEntry,
          removeWatchlistEntry: vi.fn(async () => undefined),
        })}
      />,
    );

    await screen.findAllByText('尚未添加本地自选股。');
    fireEvent.click(screen.getAllByRole('button', { name: '添加贵州茅台到本地自选股' })[0]!);
    const errors = await screen.findAllByRole('alert');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.textContent).not.toContain('IndexedDB');

    fireEvent.click(screen.getAllByRole('button', { name: '重试本地自选股操作' })[0]!);
    expect(await screen.findAllByRole('button', { name: '选择贵州茅台 600519.SH' })).toHaveLength(
      2,
    );
    expect(putWatchlistEntry).toHaveBeenCalledTimes(2);
  });

  it('shares one injected repository with the lazy AI workspace and clears the side rail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    let finishClear: () => void = () => undefined;
    const clearAll = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishClear = resolve;
        }),
    );
    const getSettings = vi.fn(async () => ({
      baseUrl: 'https://provider.example/v1',
      model: 'stored-model',
      apiKey: 'stored-key',
      rememberApiKey: true,
    }));
    const sharedRepository = appRepository({
      clearAll,
      clearCredentials: vi.fn(async () => undefined),
      deleteReport: vi.fn(async () => undefined),
      getExportSnapshot: vi.fn(async () => ({ watchlist: [BANK], settings: null, reports: [] })),
      getSettings,
      listReports: vi.fn(async () => []),
      listWatchlist: vi.fn(async () => [BANK]),
      putWatchlistEntry: vi.fn(async () => undefined),
      removeWatchlistEntry: vi.fn(async () => undefined),
      saveReport: vi.fn(async (report) => ({
        id: 'saved-report',
        savedAt: '2026-07-20T00:00:00.000Z',
        report,
      })),
      saveSettings: vi.fn(async () => undefined),
    });
    render(<App watchlistRepository={sharedRepository} />);

    expect(await screen.findAllByRole('button', { name: '选择平安银行 000001.SZ' })).toHaveLength(
      2,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'AI 报告' }));
    await screen.findByRole('heading', { name: 'AI 提供商设置' });
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByLabelText('模型标识符')).toHaveProperty('value', 'stored-model'),
    );
    fireEvent.click(screen.getByRole('button', { name: '清除全部本地数据' }));
    fireEvent.click(screen.getByRole('button', { name: '确认清除全部数据' }));

    expect(screen.getByLabelText('模型标识符')).toHaveProperty('disabled', true);
    expect(screen.getAllByRole('button', { name: '添加贵州茅台到本地自选股' })[0]).toHaveProperty(
      'disabled',
      true,
    );
    finishClear();

    await screen.findByText('全部本地数据已清除。');
    expect(clearAll).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getAllByText('尚未添加本地自选股。')).toHaveLength(2));
    expect(screen.getByLabelText('模型标识符')).toHaveProperty('value', '');
  });

  it('rehydrates the authoritative watchlist before reopening writes after clear-all fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    let resolveRecovery: (stocks: readonly StockSearchResult[]) => void = () => undefined;
    const recovery = new Promise<readonly StockSearchResult[]>((resolve) => {
      resolveRecovery = resolve;
    });
    const listWatchlist = vi
      .fn<AppRepository['listWatchlist']>()
      .mockResolvedValueOnce([BANK])
      .mockReturnValueOnce(recovery);
    const putWatchlistEntry = vi.fn<AppRepository['putWatchlistEntry']>().mockResolvedValue();
    render(
      <App
        watchlistRepository={appRepository({
          clearAll: vi.fn<AppRepository['clearAll']>().mockRejectedValue(new Error('clear failed')),
          listWatchlist,
          putWatchlistEntry,
        })}
      />,
    );

    expect(await screen.findAllByRole('button', { name: '选择平安银行 000001.SZ' })).toHaveLength(
      2,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'AI 报告' }));
    await screen.findByRole('heading', { name: 'AI 提供商设置' });
    fireEvent.click(screen.getByRole('button', { name: '清除全部本地数据' }));
    fireEvent.click(screen.getByRole('button', { name: '确认清除全部数据' }));

    await waitFor(() => expect(listWatchlist).toHaveBeenCalledTimes(2));
    const blockedAddButtons = screen.getAllByRole('button', {
      name: '添加贵州茅台到本地自选股',
    });
    expect(blockedAddButtons.every((button) => button.hasAttribute('disabled'))).toBe(true);
    fireEvent.click(blockedAddButtons[0]!);
    expect(putWatchlistEntry).not.toHaveBeenCalled();

    resolveRecovery([BANK]);
    await screen.findByRole('alert');
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('button', { name: '添加贵州茅台到本地自选股' })
          .every((button) => !button.hasAttribute('disabled')),
      ).toBe(true),
    );
    fireEvent.click(screen.getAllByRole('button', { name: '添加贵州茅台到本地自选股' })[0]!);
    expect(await screen.findAllByRole('button', { name: '选择贵州茅台 600519.SH' })).toHaveLength(
      2,
    );
    expect(screen.getAllByRole('button', { name: '选择平安银行 000001.SZ' })).toHaveLength(2);
  });

  it('keeps the watchlist gate closed until every clear-failure recovery succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    let resolveWatchlistRecovery: (stocks: readonly StockSearchResult[]) => void = () => undefined;
    const watchlistRecovery = new Promise<readonly StockSearchResult[]>((resolve) => {
      resolveWatchlistRecovery = resolve;
    });
    const settingsRecovery = new Promise<Awaited<ReturnType<AppRepository['getSettings']>>>(
      () => undefined,
    );
    const listWatchlist = vi
      .fn<AppRepository['listWatchlist']>()
      .mockResolvedValueOnce([BANK])
      .mockReturnValueOnce(watchlistRecovery);
    const getSettings = vi
      .fn<AppRepository['getSettings']>()
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce(settingsRecovery);
    const putWatchlistEntry = vi.fn<AppRepository['putWatchlistEntry']>().mockResolvedValue();
    render(
      <App
        watchlistRepository={appRepository({
          clearAll: vi.fn<AppRepository['clearAll']>().mockRejectedValue(new Error('clear failed')),
          getSettings,
          listWatchlist,
          putWatchlistEntry,
        })}
      />,
    );

    expect(await screen.findAllByRole('button', { name: '选择平安银行 000001.SZ' })).toHaveLength(
      2,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'AI 报告' }));
    await screen.findByRole('heading', { name: 'AI 提供商设置' });
    fireEvent.click(screen.getByRole('button', { name: '清除全部本地数据' }));
    fireEvent.click(screen.getByRole('button', { name: '确认清除全部数据' }));
    await waitFor(() => expect(listWatchlist).toHaveBeenCalledTimes(2));

    resolveWatchlistRecovery([BANK]);
    await waitFor(() => expect(screen.getAllByText('平安银行').length).toBeGreaterThan(0));
    const blockedAddButtons = screen.getAllByRole('button', {
      name: '添加贵州茅台到本地自选股',
    });
    expect(blockedAddButtons.every((button) => button.hasAttribute('disabled'))).toBe(true);
    fireEvent.click(blockedAddButtons[0]!);
    expect(putWatchlistEntry).not.toHaveBeenCalled();
  });

  it('keeps the full write gate closed when authoritative clear-failure recovery also fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    const listWatchlist = vi
      .fn<AppRepository['listWatchlist']>()
      .mockResolvedValueOnce([BANK])
      .mockRejectedValueOnce(new Error('recovery failed'));
    const putWatchlistEntry = vi.fn<AppRepository['putWatchlistEntry']>().mockResolvedValue();
    render(
      <App
        watchlistRepository={appRepository({
          clearAll: vi.fn<AppRepository['clearAll']>().mockRejectedValue(new Error('clear failed')),
          listWatchlist,
          putWatchlistEntry,
        })}
      />,
    );

    expect(await screen.findAllByRole('button', { name: '选择平安银行 000001.SZ' })).toHaveLength(
      2,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'AI 报告' }));
    await screen.findByRole('heading', { name: 'AI 提供商设置' });
    fireEvent.click(screen.getByRole('button', { name: '清除全部本地数据' }));
    fireEvent.click(screen.getByRole('button', { name: '确认清除全部数据' }));

    await screen.findByText(/本地数据操作失败/);
    expect(screen.getByLabelText('模型标识符')).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '清除 AI 凭据' })).toHaveProperty('disabled', true);
    const blockedAddButtons = screen.getAllByRole('button', {
      name: '添加贵州茅台到本地自选股',
    });
    expect(blockedAddButtons.every((button) => button.hasAttribute('disabled'))).toBe(true);
    fireEvent.click(blockedAddButtons[0]!);
    expect(putWatchlistEntry).not.toHaveBeenCalled();
  });
});
