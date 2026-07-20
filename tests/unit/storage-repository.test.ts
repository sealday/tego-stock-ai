import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiProviderSettings } from '../../src/ai/provider-settings';
import type { GeneratedAiReport } from '../../src/ai/report-model';
import {
  LOCAL_DATABASE_VERSION,
  LOCAL_STORE_NAMES,
  LocalStorageError,
  deleteLocalDatabase,
  openLocalDatabase,
  runLocalTransaction,
} from '../../src/storage/database';
import { createLocalDataExport, serializeLocalDataExport } from '../../src/storage/export';
import { LocalRepository } from '../../src/storage/repository';
import { completeReport, draftReport } from '../fixtures/ai-report';

const databases = new Set<string>();
let sequence = 0;

function databaseName(label: string): string {
  sequence += 1;
  const name = `tego-stock-ai-test-${label}-${sequence}`;
  databases.add(name);
  return name;
}

function rememberedSettings(apiKey = 'remembered-sensitive-key'): AiProviderSettings {
  return {
    baseUrl: 'https://provider.example/v1',
    model: 'research-model',
    apiKey,
    rememberApiKey: true,
  };
}

async function storedProviderSettings(name: string): Promise<unknown> {
  const database = await openLocalDatabase({ name });
  const value = await runLocalTransaction(
    database,
    ['providerSettings'],
    'readonly',
    (transaction) => transaction.get('providerSettings', 'current'),
  );
  database.close();
  return value;
}

afterEach(async () => {
  await Promise.all([...databases].map((name) => deleteLocalDatabase(name)));
  databases.clear();
  vi.restoreAllMocks();
});

beforeEach(() => {
  sequence = 0;
});

describe('local database migrations', () => {
  it('creates the four version-one stores and reopens the same version idempotently', async () => {
    const name = databaseName('stores');
    const first = await openLocalDatabase({ name });

    expect(first.version).toBe(LOCAL_DATABASE_VERSION);
    expect([...first.objectStoreNames]).toEqual([...LOCAL_STORE_NAMES].sort());
    first.close();

    const reopened = await openLocalDatabase({ name });
    expect([...reopened.objectStoreNames]).toEqual([...LOCAL_STORE_NAMES].sort());
    reopened.close();
  });

  it('aborts a failed version upgrade without clearing records from the last good version', async () => {
    const name = databaseName('rollback');
    const repository = new LocalRepository({ name, createId: () => 'report-before-upgrade' });
    await repository.putWatchlistEntry({
      code: '600519.SH',
      name: '贵州茅台',
      pinyinAbbreviation: 'GZMT',
    });
    await repository.close();

    await expect(
      openLocalDatabase({
        name,
        version: LOCAL_DATABASE_VERSION + 1,
        migrate: () => {
          throw new Error('synthetic migration failure');
        },
      }),
    ).rejects.toMatchObject({ code: 'MIGRATION_FAILED' });

    const reopened = new LocalRepository({ name });
    await expect(reopened.listWatchlist()).resolves.toEqual([
      { code: '600519.SH', name: '贵州茅台', pinyinAbbreviation: 'GZMT' },
    ]);
    await reopened.close();
  });
});

describe('LocalRepository', () => {
  it('omits the API key without explicit consent and persists it only when consent is true', async () => {
    const name = databaseName('consent');
    const repository = new LocalRepository({ name });
    await repository.saveSettings({ ...rememberedSettings(), rememberApiKey: false });

    expect(await repository.getSettings()).toEqual({
      baseUrl: 'https://provider.example/v1',
      model: 'research-model',
      apiKey: '',
      rememberApiKey: false,
    });
    expect(await storedProviderSettings(name)).not.toHaveProperty('apiKey');

    await repository.saveSettings(rememberedSettings());
    expect(await repository.getSettings()).toEqual(rememberedSettings());
    expect(await storedProviderSettings(name)).toMatchObject({
      apiKey: 'remembered-sensitive-key',
      rememberApiKey: true,
    });
    await repository.close();
  });

  it('rejects malformed settings and invalid generated timestamps with typed data errors', async () => {
    const malformedSettings: unknown = {
      ...rememberedSettings(),
      apiKey: 42,
    };
    const malformedRepository = new LocalRepository({ name: databaseName('bad-settings') });
    await expect(
      malformedRepository.saveSettings(malformedSettings as AiProviderSettings),
    ).rejects.toMatchObject({ code: 'INVALID_DATA' });

    const invalidTimeRepository = new LocalRepository({
      name: databaseName('bad-time'),
      now: () => new Date(Number.NaN),
    });
    await expect(
      invalidTimeRepository.putWatchlistEntry({
        code: '600519.SH',
        name: '贵州茅台',
        pinyinAbbreviation: 'GZMT',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_DATA' });
    await malformedRepository.close();
    await invalidTimeRepository.close();
  });

  it('supports deterministic watchlist CRUD with validated A-share codes', async () => {
    const repository = new LocalRepository({
      name: databaseName('watchlist'),
      now: () => new Date('2026-07-20T01:00:00.000Z'),
    });
    await repository.putWatchlistEntry({
      code: '600519.SH',
      name: '贵州茅台',
      pinyinAbbreviation: 'GZMT',
    });
    await repository.putWatchlistEntry({
      code: '000001.SZ',
      name: '平安银行',
      pinyinAbbreviation: 'PAYH',
    });

    expect(await repository.listWatchlist()).toEqual([
      { code: '000001.SZ', name: '平安银行', pinyinAbbreviation: 'PAYH' },
      { code: '600519.SH', name: '贵州茅台', pinyinAbbreviation: 'GZMT' },
    ]);
    await repository.removeWatchlistEntry('000001.SZ');
    await expect(repository.listWatchlist()).resolves.toEqual([
      { code: '600519.SH', name: '贵州茅台', pinyinAbbreviation: 'GZMT' },
    ]);
    await expect(
      repository.putWatchlistEntry({
        code: '600519.SZ',
        name: '错误交易所',
        pinyinAbbreviation: 'CW',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_DATA' });
    await repository.close();
  });

  it('persists interrupted output only as a draft and requires all approved sections for complete reports', async () => {
    const repository = new LocalRepository({
      name: databaseName('reports'),
      createId: () => 'draft-one',
      now: () => new Date('2026-07-20T02:00:00.000Z'),
    });

    await expect(repository.saveReport(draftReport())).resolves.toMatchObject({
      id: 'draft-one',
      report: { status: 'draft', reason: 'stream-interrupted' },
    });
    await expect(repository.listReports()).resolves.toHaveLength(1);

    const invalidComplete = completeReport({
      sections: completeReport().sections.slice(0, 6),
    });
    await expect(repository.saveReport(invalidComplete)).rejects.toMatchObject({
      code: 'INVALID_DATA',
    });
    await repository.close();
  });

  it('persists a validated report snapshot that caller mutation cannot corrupt', async () => {
    const repository = new LocalRepository({
      name: databaseName('report-snapshot'),
      createId: () => 'snapshot-one',
    });
    await repository.listReports();
    const report = completeReport();

    const saving = repository.saveReport(report);
    Reflect.set(report.context.stock, 'code', '600519.SZ');
    await saving;

    await expect(repository.listReports()).resolves.toMatchObject([
      { report: { context: { stock: { code: '600519.SH' } } } },
    ]);
    await repository.close();
  });

  it('rejects malformed report dates, contexts, section order, and unsanitized providers', async () => {
    const repository = new LocalRepository({ name: databaseName('report-contract') });
    const unsafeProvider: unknown = {
      ...completeReport(),
      provider: {
        ...completeReport().provider,
        apiKey: 'must-not-cross-storage-boundary',
      },
    };
    const invalidContext = completeReport({
      context: { ...completeReport().context, cutoff: '2026-02-30' },
    });
    const reorderedDraft = draftReport({
      sections: [...draftReport().sections].reverse(),
    });

    for (const report of [
      completeReport({ completedAt: 'not-a-timestamp' }),
      invalidContext,
      reorderedDraft,
      unsafeProvider as GeneratedAiReport,
    ]) {
      await expect(repository.saveReport(report)).rejects.toMatchObject({ code: 'INVALID_DATA' });
    }
    await repository.close();
  });

  it('validates records read back from IndexedDB instead of trusting stored values', async () => {
    const name = databaseName('read-validation');
    const database = await openLocalDatabase({ name });
    await runLocalTransaction(database, ['reports'], 'readwrite', async (transaction) => {
      await transaction.put('reports', {
        id: 'corrupt',
        schemaVersion: 1,
        savedAt: 'not-a-date',
        report: completeReport(),
      });
    });
    database.close();

    const repository = new LocalRepository({ name });
    await expect(repository.listReports()).rejects.toMatchObject({ code: 'INVALID_DATA' });
    await repository.close();
  });

  it('clears credentials without deleting endpoint, model, reports, or watchlists', async () => {
    const repository = new LocalRepository({
      name: databaseName('credentials'),
      createId: () => 'report-one',
    });
    await repository.saveSettings(rememberedSettings());
    await repository.saveReport(completeReport());
    await repository.putWatchlistEntry({
      code: '600519.SH',
      name: '贵州茅台',
      pinyinAbbreviation: 'GZMT',
    });

    await repository.clearCredentials();

    expect(await repository.getSettings()).toEqual({
      baseUrl: 'https://provider.example/v1',
      model: 'research-model',
      apiKey: '',
      rememberApiKey: false,
    });
    await expect(repository.listReports()).resolves.toHaveLength(1);
    await expect(repository.listWatchlist()).resolves.toHaveLength(1);
    await repository.close();
  });

  it('deletes one report without removing the remaining local history', async () => {
    const ids = ['complete-one', 'draft-one'];
    const repository = new LocalRepository({
      name: databaseName('delete-report'),
      createId: () => ids.shift() ?? 'unexpected',
    });
    await repository.saveReport(completeReport());
    await repository.saveReport(draftReport());

    await repository.deleteReport('complete-one');

    expect(await repository.listReports()).toMatchObject([
      { id: 'draft-one', report: { status: 'draft' } },
    ]);
    await repository.close();
  });

  it('uses one atomic cross-store transaction for clearAll and preserves data when it aborts', async () => {
    const repository = new LocalRepository({
      name: databaseName('clear-all'),
      createId: () => 'report-one',
    });
    await repository.saveSettings(rememberedSettings());
    await repository.saveReport(completeReport());
    await repository.putWatchlistEntry({
      code: '600519.SH',
      name: '贵州茅台',
      pinyinAbbreviation: 'GZMT',
    });

    const originalClear = IDBObjectStore.prototype.clear;
    vi.spyOn(IDBObjectStore.prototype, 'clear').mockImplementation(function (this: IDBObjectStore) {
      if (this.name === 'reports') {
        throw new DOMException('synthetic transaction failure', 'InvalidStateError');
      }
      return originalClear.call(this);
    });

    await expect(repository.clearAll()).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });
    vi.restoreAllMocks();
    await expect(repository.listWatchlist()).resolves.toHaveLength(1);
    await expect(repository.listReports()).resolves.toHaveLength(1);
    await expect(repository.getSettings()).resolves.toEqual(rememberedSettings());

    await repository.clearAll();
    await expect(repository.listWatchlist()).resolves.toEqual([]);
    await expect(repository.listReports()).resolves.toEqual([]);
    await expect(repository.getSettings()).resolves.toBeNull();
    await repository.close();
  });

  it('maps unavailable storage and transaction failures to typed safe errors', async () => {
    const unavailable = new LocalRepository({
      name: databaseName('unavailable'),
      indexedDB: null,
    });
    await expect(unavailable.listReports()).rejects.toEqual(
      expect.objectContaining<Partial<LocalStorageError>>({
        name: 'LocalStorageError',
        code: 'UNAVAILABLE',
      }),
    );
  });
});

describe('local data export', () => {
  it('is deterministic, versioned, and omits remembered API keys from JSON', async () => {
    const repository = new LocalRepository({
      name: databaseName('export'),
      createId: () => 'report-export',
      now: () => new Date('2026-07-20T02:00:00.000Z'),
    });
    await repository.saveSettings(rememberedSettings('never-export-this-key'));
    await repository.putWatchlistEntry({
      code: '600519.SH',
      name: '贵州茅台',
      pinyinAbbreviation: 'GZMT',
    });
    await repository.saveReport(completeReport());

    const exported = await createLocalDataExport(repository, {
      now: () => new Date('2026-07-20T03:00:00.000Z'),
    });
    const first = serializeLocalDataExport(exported);
    const second = serializeLocalDataExport(exported);

    expect(exported).toMatchObject({
      schema: 'tego-stock-ai-local-export',
      version: 1,
      exportedAt: '2026-07-20T03:00:00.000Z',
      settings: {
        baseUrl: 'https://provider.example/v1',
        model: 'research-model',
        rememberApiKey: true,
      },
    });
    expect(first).toBe(second);
    expect(first.endsWith('\n')).toBe(true);
    expect(first).not.toContain('never-export-this-key');
    expect(first).not.toContain('apiKey');
    await repository.close();
  });
});
