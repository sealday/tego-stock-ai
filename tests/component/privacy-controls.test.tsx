import 'fake-indexeddb/auto';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PrivacyControls,
  type PrivacyControlsRepository,
} from '../../src/components/privacy/PrivacyControls';
import { deleteLocalDatabase } from '../../src/storage/database';
import { downloadLocalDataExport } from '../../src/storage/export';
import { LocalRepository } from '../../src/storage/repository';
import { completeReport } from '../fixtures/ai-report';

const databases = new Set<string>();
let sequence = 0;

function databaseName(): string {
  sequence += 1;
  const name = `tego-stock-ai-privacy-${sequence}`;
  databases.add(name);
  return name;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all([...databases].map((name) => deleteLocalDatabase(name)));
  databases.clear();
  vi.restoreAllMocks();
});

describe('PrivacyControls', () => {
  it('exports key-free JSON and clears credentials without deleting reports', async () => {
    const user = userEvent.setup();
    const repository = new LocalRepository({
      name: databaseName(),
      createId: () => 'report-one',
      now: () => new Date('2026-07-20T01:00:00.000Z'),
    });
    await repository.saveSettings({
      baseUrl: 'https://provider.example/v1',
      model: 'research-model',
      apiKey: 'never-export-this-sensitive-key',
      rememberApiKey: true,
    });
    await repository.saveReport(completeReport());
    let downloaded = '';
    const onCredentialsCleared = vi.fn();
    render(
      <PrivacyControls
        repository={repository}
        now={() => new Date('2026-07-20T03:00:00.000Z')}
        download={(serialized) => {
          downloaded = serialized;
        }}
        onCredentialsCleared={onCredentialsCleared}
      />,
    );

    expect(screen.getByText(/全部数据仅保存在当前浏览器/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: '导出本地数据 JSON' }));
    await screen.findByText('本地数据已导出。');
    expect(downloaded).not.toContain('never-export-this-sensitive-key');
    expect(downloaded).not.toContain('apiKey');
    expect(JSON.parse(downloaded)).toMatchObject({
      schema: 'tego-stock-ai-local-export',
      version: 1,
    });

    await user.click(screen.getByRole('button', { name: '清除 AI 凭据' }));
    expect(await screen.findByText(/AI 凭据已清除/)).toBeVisible();
    expect(onCredentialsCleared).toHaveBeenCalledOnce();
    expect(await repository.getSettings()).toEqual({
      baseUrl: 'https://provider.example/v1',
      model: 'research-model',
      apiKey: '',
      rememberApiKey: false,
    });
    await expect(repository.listReports()).resolves.toHaveLength(1);
    await repository.close();
  });

  it('requires an accessible confirmation dialog before clearing all local data', async () => {
    const user = userEvent.setup();
    const repository = new LocalRepository({
      name: databaseName(),
      createId: () => 'report-one',
    });
    await repository.saveReport(completeReport());
    const onAllCleared = vi.fn();
    render(<PrivacyControls repository={repository} onAllCleared={onAllCleared} />);

    const openButton = screen.getByRole('button', { name: '清除全部本地数据' });
    await user.click(openButton);
    const dialog = screen.getByRole('dialog', { name: '确认清除全部本地数据' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' })),
    );
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '确认清除全部数据' }));
    await user.keyboard('{Tab}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' }));

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(openButton);
    await expect(repository.listReports()).resolves.toHaveLength(1);

    await user.click(openButton);
    await user.click(screen.getByRole('button', { name: '确认清除全部数据' }));
    expect(await screen.findByText('全部本地数据已清除。')).toBeVisible();
    expect(onAllCleared).toHaveBeenCalledOnce();
    await expect(repository.listReports()).resolves.toEqual([]);
    await repository.close();
  });

  it('shows a safe retryable message without leaking IndexedDB details', async () => {
    const user = userEvent.setup();
    const clearCredentials = vi
      .fn<PrivacyControlsRepository['clearCredentials']>()
      .mockRejectedValueOnce(new Error('IndexedDB reports store key secret-internal'))
      .mockResolvedValueOnce();
    const repository = {
      clearAll: vi.fn<PrivacyControlsRepository['clearAll']>(),
      clearCredentials,
      getExportSnapshot: vi
        .fn<PrivacyControlsRepository['getExportSnapshot']>()
        .mockResolvedValue({ watchlist: [], settings: null, reports: [] }),
    } satisfies PrivacyControlsRepository;
    render(<PrivacyControls repository={repository} />);

    await user.click(screen.getByRole('button', { name: '清除 AI 凭据' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('本地数据操作失败');
    expect(alert.textContent).not.toContain('IndexedDB');
    expect(alert.textContent).not.toContain('secret-internal');

    await user.click(screen.getByRole('button', { name: '重试上一次操作' }));
    expect(await screen.findByText(/AI 凭据已清除/)).toBeVisible();
    expect(clearCredentials).toHaveBeenCalledTimes(2);
  });

  it('reports clear-all start, failure, and retry success at the matching lifecycle boundaries', async () => {
    const user = userEvent.setup();
    const clearAll = vi
      .fn<PrivacyControlsRepository['clearAll']>()
      .mockRejectedValueOnce(new Error('clear failed'))
      .mockResolvedValueOnce();
    const repository = {
      clearAll,
      clearCredentials: vi.fn<PrivacyControlsRepository['clearCredentials']>(),
      getExportSnapshot: vi
        .fn<PrivacyControlsRepository['getExportSnapshot']>()
        .mockResolvedValue({ watchlist: [], settings: null, reports: [] }),
    } satisfies PrivacyControlsRepository;
    const onAllClearStart = vi.fn();
    const onAllCleared = vi.fn();
    const onAllClearFailure = vi.fn();
    render(
      <PrivacyControls
        repository={repository}
        onAllClearStart={onAllClearStart}
        onAllCleared={onAllCleared}
        onAllClearFailure={onAllClearFailure}
      />,
    );

    await user.click(screen.getByRole('button', { name: '清除全部本地数据' }));
    await user.click(screen.getByRole('button', { name: '确认清除全部数据' }));
    await screen.findByRole('alert');
    expect(onAllClearStart).toHaveBeenCalledOnce();
    expect(onAllClearFailure).toHaveBeenCalledOnce();
    expect(onAllCleared).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '重试上一次操作' }));
    expect(await screen.findByText('全部本地数据已清除。')).toBeVisible();
    expect(onAllClearStart).toHaveBeenCalledTimes(2);
    expect(onAllClearFailure).toHaveBeenCalledOnce();
    expect(onAllCleared).toHaveBeenCalledOnce();
  });

  it('removes the anchor immediately and revokes the Blob URL on the next task after download', () => {
    vi.useFakeTimers();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const createObjectURL = vi.fn(() => 'blob:tego-export');
    const revokeObjectURL = vi.fn();

    downloadLocalDataExport('{}\n', '2026-07-20T03:00:00.000Z', document, {
      createObjectURL,
      revokeObjectURL,
    });

    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:tego-export');
    vi.useRealTimers();
  });

  it('cleans up and revokes immediately when starting a download fails synchronously', () => {
    const createObjectURL = vi.fn(() => 'blob:tego-export');
    const revokeObjectURL = vi.fn();
    vi.spyOn(document.body, 'append').mockImplementation(() => {
      throw new Error('append failed');
    });

    expect(() =>
      downloadLocalDataExport('{}\n', '2026-07-20T03:00:00.000Z', document, {
        createObjectURL,
        revokeObjectURL,
      }),
    ).toThrow('append failed');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:tego-export');
    expect(document.querySelector('a[download]')).toBeNull();
  });
});
