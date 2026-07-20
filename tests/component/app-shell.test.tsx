import 'fake-indexeddb/auto';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/app/App';
import { deleteLocalDatabase } from '../../src/storage/database';
import { LocalRepository } from '../../src/storage/repository';

const databases = new Set<string>();
let sequence = 0;

function repository(label: string): LocalRepository {
  sequence += 1;
  const name = `tego-stock-ai-app-${label}-${sequence}`;
  databases.add(name);
  return new LocalRepository({ name });
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
    let releaseHydration: ((stocks: readonly []) => void) | undefined;
    const delayedRepository = {
      listWatchlist: vi.fn(
        () =>
          new Promise<readonly []>((resolve) => {
            releaseHydration = resolve;
          }),
      ),
      putWatchlistEntry: localRepository.putWatchlistEntry.bind(localRepository),
      removeWatchlistEntry: localRepository.removeWatchlistEntry.bind(localRepository),
    };
    render(<App watchlistRepository={delayedRepository} />);

    fireEvent.click(screen.getAllByRole('button', { name: '添加贵州茅台到本地自选股' })[0]!);
    expect(await screen.findAllByRole('button', { name: '选择贵州茅台 600519.SH' })).toHaveLength(
      2,
    );
    releaseHydration?.([]);

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: '选择贵州茅台 600519.SH' })).toHaveLength(2),
    );
    await localRepository.close();
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
        watchlistRepository={{
          listWatchlist: vi.fn(async () => []),
          putWatchlistEntry,
          removeWatchlistEntry: vi.fn(async () => undefined),
        }}
      />,
    );

    await screen.findAllByText('尚未添加本地自选股。');
    fireEvent.click(screen.getAllByRole('button', { name: '添加贵州茅台到本地自选股' })[0]!);
    const errors = await screen.findAllByRole('alert');
    expect(errors).toHaveLength(2);
    expect(errors[0]?.textContent).not.toContain('IndexedDB');

    fireEvent.click(screen.getAllByRole('button', { name: '重试本地自选股操作' })[0]!);
    expect(await screen.findAllByRole('button', { name: '选择贵州茅台 600519.SH' })).toHaveLength(
      2,
    );
    expect(putWatchlistEntry).toHaveBeenCalledTimes(2);
  });
});
