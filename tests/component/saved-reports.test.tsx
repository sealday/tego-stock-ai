import 'fake-indexeddb/auto';

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_AI_PROVIDER_SETTINGS } from '../../src/ai/provider-settings';
import {
  SavedReports,
  type SavedReportsRepository,
} from '../../src/components/reports/SavedReports';
import AiReportWorkspace, {
  type AiReportWorkspaceRepository,
} from '../../src/components/workspace/AiReportWorkspace';
import { stockCode, type StockCode } from '../../src/domain/stock';
import type { StockWorkspaceState } from '../../src/hooks/use-stock-workspace';
import { deleteLocalDatabase } from '../../src/storage/database';
import { LocalRepository, type SavedReport } from '../../src/storage/repository';
import { completeReport, draftReport } from '../fixtures/ai-report';

const databases = new Set<string>();
let sequence = 0;

function databaseName(): string {
  sequence += 1;
  const name = `tego-stock-ai-reports-${sequence}`;
  databases.add(name);
  return name;
}

afterEach(async () => {
  await Promise.all([...databases].map((name) => deleteLocalDatabase(name)));
  databases.clear();
  vi.restoreAllMocks();
});

describe('SavedReports', () => {
  it('reloads complete reports and explicit drafts after remount and deletes only one report', async () => {
    const user = userEvent.setup();
    const ids = ['complete-one', 'draft-one'];
    const repository = new LocalRepository({
      name: databaseName(),
      createId: () => ids.shift() ?? 'unexpected',
      now: () => new Date('2026-07-20T03:00:00.000Z'),
    });
    await repository.saveReport(completeReport());
    await repository.saveReport(draftReport());

    const first = render(<SavedReports repository={repository} />);
    expect(await screen.findByText('完整报告')).toBeVisible();
    expect(screen.getByText('未完成草稿')).toBeVisible();
    expect(screen.getByText(/AI 报告只保存在当前浏览器/)).toBeVisible();
    first.unmount();

    render(<SavedReports repository={repository} />);
    expect(await screen.findByText('完整报告')).toBeVisible();
    expect(screen.getByText('未完成草稿')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '删除完整报告 贵州茅台 600519.SH' }));

    await waitFor(() => expect(screen.queryByText('完整报告')).toBeNull());
    expect(screen.getByText('未完成草稿')).toBeVisible();
    await expect(repository.listReports()).resolves.toMatchObject([
      { id: 'draft-one', report: { status: 'draft' } },
    ]);
    await repository.close();
  });

  it('uses a safe retry path when local report loading fails', async () => {
    const user = userEvent.setup();
    const listReports = vi
      .fn<SavedReportsRepository['listReports']>()
      .mockRejectedValueOnce(new Error('IndexedDB internal provider secret'))
      .mockResolvedValueOnce([]);
    const repository = {
      deleteReport: vi.fn<SavedReportsRepository['deleteReport']>(),
      listReports,
    } satisfies SavedReportsRepository;
    render(<SavedReports repository={repository} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('无法读取本地报告');
    expect(alert.textContent).not.toContain('IndexedDB');
    expect(alert.textContent).not.toContain('secret');
    await user.click(screen.getByRole('button', { name: '重试读取本地报告' }));
    expect(await screen.findByText('尚未保存本地 AI 报告。')).toBeVisible();
    expect(listReports).toHaveBeenCalledTimes(2);
  });

  it('does not let an older manual retry overwrite a newer refresh', async () => {
    const user = userEvent.setup();
    let resolveRetry: (reports: readonly ReturnType<typeof savedReportFixture>[]) => void = () =>
      undefined;
    let resolveRefresh: (reports: readonly ReturnType<typeof savedReportFixture>[]) => void = () =>
      undefined;
    const retry = new Promise<readonly ReturnType<typeof savedReportFixture>[]>((resolve) => {
      resolveRetry = resolve;
    });
    const refresh = new Promise<readonly ReturnType<typeof savedReportFixture>[]>((resolve) => {
      resolveRefresh = resolve;
    });
    const listReports = vi
      .fn<SavedReportsRepository['listReports']>()
      .mockRejectedValueOnce(new Error('initial read failed'))
      .mockReturnValueOnce(retry)
      .mockReturnValueOnce(refresh);
    const repository = {
      deleteReport: vi.fn<SavedReportsRepository['deleteReport']>(),
      listReports,
    } satisfies SavedReportsRepository;
    const view = render(<SavedReports repository={repository} />);

    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: '重试读取本地报告' }));
    view.rerender(<SavedReports repository={repository} refreshKey={1} />);
    await waitFor(() => expect(listReports).toHaveBeenCalledTimes(3));

    resolveRefresh([savedReportFixture()]);
    expect(await screen.findByText('完整报告')).toBeVisible();
    await act(async () => {
      resolveRetry([]);
      await retry;
    });
    expect(screen.getByText('完整报告')).toBeVisible();
  });

  it('blocks report deletion while the shared local write gate is closed', async () => {
    const user = userEvent.setup();
    const saved = {
      id: 'complete-one',
      savedAt: '2026-07-20T03:00:00.000Z',
      report: completeReport(),
    } as const;
    const deleteReport = vi.fn<SavedReportsRepository['deleteReport']>().mockResolvedValue();
    const repository = {
      deleteReport,
      listReports: vi.fn<SavedReportsRepository['listReports']>().mockResolvedValue([saved]),
    } satisfies SavedReportsRepository;
    render(<SavedReports repository={repository} disabled />);

    const deleteButton = await screen.findByRole('button', {
      name: '删除完整报告 贵州茅台 600519.SH',
    });
    expect(deleteButton).toHaveProperty('disabled', true);
    await user.click(deleteButton);
    expect(deleteReport).not.toHaveBeenCalled();
  });
});

describe('AiReportWorkspace local hydration', () => {
  it('does not let delayed storage hydration overwrite newer user input', async () => {
    const user = userEvent.setup();
    let resolveSettings: (
      value: Awaited<ReturnType<AiReportWorkspaceRepository['getSettings']>>,
    ) => void = () => undefined;
    const settingsPromise = new Promise<
      Awaited<ReturnType<AiReportWorkspaceRepository['getSettings']>>
    >((resolve) => {
      resolveSettings = resolve;
    });
    const saveSettings = vi.fn<AiReportWorkspaceRepository['saveSettings']>().mockResolvedValue();
    const repository = workspaceRepository({
      getSettings: vi.fn(() => settingsPromise),
      saveSettings,
    });
    render(<AiReportWorkspace state={loadingWorkspaceState()} active repository={repository} />);

    await user.type(screen.getByLabelText('模型标识符'), 'user-model');
    resolveSettings({
      baseUrl: 'https://provider.example/v1',
      model: 'stored-model',
      apiKey: 'stored-key',
      rememberApiKey: true,
    });

    await waitFor(() =>
      expect(screen.getByLabelText('模型标识符')).toHaveProperty('value', 'user-model'),
    );
    expect(saveSettings).toHaveBeenLastCalledWith({
      ...DEFAULT_AI_PROVIDER_SETTINGS,
      model: 'user-model',
    });
  });

  it('reloads explicitly remembered settings after the AI workspace remounts', async () => {
    const user = userEvent.setup();
    const repository = new LocalRepository({ name: databaseName() });
    const first = render(
      <AiReportWorkspace state={loadingWorkspaceState()} active repository={repository} />,
    );
    await user.type(screen.getByLabelText('模型标识符'), 'research-model');
    await user.type(screen.getByLabelText('API key'), 'remembered-key');
    await user.click(screen.getByRole('checkbox', { name: '在此设备上记住 API key' }));
    await waitFor(() =>
      expect(repository.getSettings()).resolves.toEqual({
        ...DEFAULT_AI_PROVIDER_SETTINGS,
        model: 'research-model',
        apiKey: 'remembered-key',
        rememberApiKey: true,
      }),
    );
    first.unmount();

    render(<AiReportWorkspace state={loadingWorkspaceState()} active repository={repository} />);
    await waitFor(() =>
      expect(screen.getByLabelText('模型标识符')).toHaveProperty('value', 'research-model'),
    );
    expect(screen.getByLabelText('API key')).toHaveProperty('value', 'remembered-key');
    expect(screen.getByRole('checkbox', { name: '在此设备上记住 API key' })).toHaveProperty(
      'checked',
      true,
    );
    await repository.close();
  });

  it('keeps settings blocked until a failed credential clear is authoritatively hydrated', async () => {
    const user = userEvent.setup();
    let resolveRecovery: (
      value: Awaited<ReturnType<AiReportWorkspaceRepository['getSettings']>>,
    ) => void = () => undefined;
    const recovery = new Promise<Awaited<ReturnType<AiReportWorkspaceRepository['getSettings']>>>(
      (resolve) => {
        resolveRecovery = resolve;
      },
    );
    const authoritativeSettings = {
      baseUrl: 'https://provider.example/v1',
      model: 'authoritative-model',
      apiKey: 'authoritative-key',
      rememberApiKey: true,
    } as const;
    const getSettings = vi
      .fn<AiReportWorkspaceRepository['getSettings']>()
      .mockResolvedValueOnce(authoritativeSettings)
      .mockReturnValueOnce(recovery);
    const saveSettings = vi.fn<AiReportWorkspaceRepository['saveSettings']>().mockResolvedValue();
    const repository = workspaceRepository({
      clearCredentials: vi
        .fn<AiReportWorkspaceRepository['clearCredentials']>()
        .mockRejectedValue(new Error('clear failed')),
      getSettings,
      saveSettings,
    });
    render(<AiReportWorkspace state={loadingWorkspaceState()} active repository={repository} />);

    await waitFor(() =>
      expect(screen.getByLabelText('API key')).toHaveProperty('value', 'authoritative-key'),
    );
    await user.click(screen.getByRole('button', { name: '清除 AI 凭据' }));
    await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('模型标识符')).toHaveProperty('disabled', true);
    expect(screen.queryByText(/本地数据操作失败/)).toBeNull();

    resolveRecovery(authoritativeSettings);
    await screen.findByText(/本地数据操作失败/);
    await waitFor(() =>
      expect(screen.getByLabelText('模型标识符')).toHaveProperty('disabled', false),
    );
    await user.type(screen.getByLabelText('模型标识符'), '-new');
    expect(saveSettings).toHaveBeenLastCalledWith({
      ...authoritativeSettings,
      model: 'authoritative-model-new',
    });
  });

  it('closes the settings write gate synchronously while credential clearing is pending', async () => {
    const user = userEvent.setup();
    let finishClear: () => void = () => undefined;
    const clearCredentials = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishClear = resolve;
        }),
    );
    const storedSettings = {
      baseUrl: 'https://provider.example/v1',
      model: 'stored-model',
      apiKey: 'stored-key',
      rememberApiKey: true,
    } as const;
    const saveSettings = vi.fn<AiReportWorkspaceRepository['saveSettings']>().mockResolvedValue();
    const repository = workspaceRepository({
      clearCredentials,
      getSettings: vi
        .fn<AiReportWorkspaceRepository['getSettings']>()
        .mockResolvedValue(storedSettings),
      saveSettings,
    });
    render(<AiReportWorkspace state={loadingWorkspaceState()} active repository={repository} />);

    await waitFor(() =>
      expect(screen.getByLabelText('API key')).toHaveProperty('value', 'stored-key'),
    );
    await user.click(screen.getByRole('button', { name: '清除 AI 凭据' }));
    expect(clearCredentials).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('模型标识符')).toHaveProperty('disabled', true);
    await user.type(screen.getByLabelText('模型标识符'), '-stale');
    expect(saveSettings).not.toHaveBeenCalled();

    finishClear();
    await waitFor(() => expect(screen.getByLabelText('API key')).toHaveProperty('value', ''));
    expect(screen.getByLabelText('模型标识符')).toHaveProperty('disabled', false);
    await user.type(screen.getByLabelText('模型标识符'), '-new');
    expect(saveSettings).toHaveBeenLastCalledWith({
      ...storedSettings,
      model: 'stored-model-new',
      apiKey: '',
      rememberApiKey: false,
    });
  });

  it('keeps every local write blocked until failed full clearing rehydrates authoritative state', async () => {
    const user = userEvent.setup();
    let resolveSettingsRecovery: (
      value: Awaited<ReturnType<AiReportWorkspaceRepository['getSettings']>>,
    ) => void = () => undefined;
    let resolveReportsRecovery: (
      value: Awaited<ReturnType<AiReportWorkspaceRepository['listReports']>>,
    ) => void = () => undefined;
    const settingsRecovery = new Promise<
      Awaited<ReturnType<AiReportWorkspaceRepository['getSettings']>>
    >((resolve) => {
      resolveSettingsRecovery = resolve;
    });
    const reportsRecovery = new Promise<
      Awaited<ReturnType<AiReportWorkspaceRepository['listReports']>>
    >((resolve) => {
      resolveReportsRecovery = resolve;
    });
    const authoritativeSettings = {
      baseUrl: 'https://provider.example/v1',
      model: 'recovered-model',
      apiKey: 'recovered-key',
      rememberApiKey: true,
    } as const;
    const getSettings = vi
      .fn<AiReportWorkspaceRepository['getSettings']>()
      .mockResolvedValueOnce(authoritativeSettings)
      .mockReturnValueOnce(settingsRecovery);
    const listReports = vi
      .fn<AiReportWorkspaceRepository['listReports']>()
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(reportsRecovery)
      .mockResolvedValue([]);
    const saveSettings = vi.fn<AiReportWorkspaceRepository['saveSettings']>().mockResolvedValue();
    const repository = workspaceRepository({
      clearAll: vi
        .fn<AiReportWorkspaceRepository['clearAll']>()
        .mockRejectedValue(new Error('clear failed')),
      getSettings,
      listReports,
      saveSettings,
    });
    render(<AiReportWorkspace state={loadingWorkspaceState()} active repository={repository} />);

    await waitFor(() =>
      expect(screen.getByLabelText('模型标识符')).toHaveProperty('value', 'recovered-model'),
    );
    await user.click(screen.getByRole('button', { name: '清除全部本地数据' }));
    await user.click(screen.getByRole('button', { name: '确认清除全部数据' }));
    await waitFor(() => {
      expect(getSettings).toHaveBeenCalledTimes(2);
      expect(listReports).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByLabelText('模型标识符')).toHaveProperty('disabled', true);
    expect(screen.queryByText(/本地数据操作失败/)).toBeNull();

    resolveSettingsRecovery(authoritativeSettings);
    resolveReportsRecovery([]);
    await screen.findByText(/本地数据操作失败/);
    await waitFor(() =>
      expect(screen.getByLabelText('模型标识符')).toHaveProperty('disabled', false),
    );
    await user.type(screen.getByLabelText('模型标识符'), '-new');
    expect(saveSettings).toHaveBeenLastCalledWith({
      ...authoritativeSettings,
      model: 'recovered-model-new',
    });
  });
});

function workspaceRepository(
  overrides: Partial<AiReportWorkspaceRepository> = {},
): AiReportWorkspaceRepository {
  return {
    clearAll: vi.fn<AiReportWorkspaceRepository['clearAll']>().mockResolvedValue(),
    clearCredentials: vi.fn<AiReportWorkspaceRepository['clearCredentials']>().mockResolvedValue(),
    deleteReport: vi.fn<AiReportWorkspaceRepository['deleteReport']>().mockResolvedValue(),
    getExportSnapshot: vi
      .fn<AiReportWorkspaceRepository['getExportSnapshot']>()
      .mockResolvedValue({ watchlist: [], settings: null, reports: [] }),
    getSettings: vi
      .fn<AiReportWorkspaceRepository['getSettings']>()
      .mockResolvedValue(DEFAULT_AI_PROVIDER_SETTINGS),
    listReports: vi.fn<AiReportWorkspaceRepository['listReports']>().mockResolvedValue([]),
    listWatchlist: vi.fn<AiReportWorkspaceRepository['listWatchlist']>().mockResolvedValue([]),
    saveReport: vi.fn<AiReportWorkspaceRepository['saveReport']>(),
    saveSettings: vi.fn<AiReportWorkspaceRepository['saveSettings']>().mockResolvedValue(),
    ...overrides,
  };
}

function savedReportFixture(): SavedReport {
  return {
    id: 'complete-one',
    savedAt: '2026-07-20T03:00:00.000Z',
    report: completeReport(),
  };
}

function loadingWorkspaceState(): StockWorkspaceState {
  const code: StockCode = stockCode('600519.SH');
  return {
    code,
    cutoff: null,
    source: 'Tushare Pro',
    freshness: 'fresh',
    dataStatus: 'loading',
    marketState: '加载中',
    overview: { status: 'loading' },
    history: { status: 'loading' },
    fundamentals: { status: 'loading' },
    marketStatus: { status: 'loading' },
    analysis: { technical: null, trend: null, valuation: null, quality: null },
  };
}
