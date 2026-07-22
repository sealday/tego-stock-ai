import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  deleteLocalDatabase,
  openLocalDatabase,
  runLocalTransaction,
} from '../../src/storage/database';

const databases = new Set<string>();
let sequence = 0;

function databaseName(label: string): string {
  sequence += 1;
  const name = `tego-stock-ai-database-${label}-${sequence}`;
  databases.add(name);
  return name;
}

afterEach(async () => {
  await Promise.all([...databases].map((name) => deleteLocalDatabase(name)));
  databases.clear();
  vi.restoreAllMocks();
});

describe('local database lifecycle', () => {
  it('waits for transaction abort before rejecting an operation failure', async () => {
    const database = await openLocalDatabase({ name: databaseName('rollback-terminal') });
    let abortObserved = false;
    database.addEventListener('abort', () => {
      abortObserved = true;
    });

    const operation = runLocalTransaction(
      database,
      ['watchlists'],
      'readwrite',
      async (transaction) => {
        await transaction.put('watchlists', {
          schemaVersion: 1,
          code: '600519.SH',
          name: '贵州茅台',
          pinyinAbbreviation: 'GZMT',
          createdAt: '2026-07-20T01:00:00.000Z',
          updatedAt: '2026-07-20T01:00:00.000Z',
        });
        throw new Error('operation failed after a successful write request');
      },
    );

    await expect(operation).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });
    expect(abortObserved).toBe(true);
    await expect(
      runLocalTransaction(database, ['watchlists'], 'readonly', (transaction) =>
        transaction.get('watchlists', '600519.SH'),
      ),
    ).resolves.toBeUndefined();
    database.close();
  });

  it('closes a late successful connection after a blocked open already rejected', async () => {
    const close = vi.fn();
    const request = {
      transaction: null,
      result: { close },
      error: null,
      onupgradeneeded: null,
      onblocked: null,
      onerror: null,
      onsuccess: null,
    } as unknown as IDBOpenDBRequest;
    const factory = {
      open: vi.fn(() => request),
    } as unknown as IDBFactory;

    const opening = openLocalDatabase({ indexedDB: factory });
    request.onblocked?.call(request, new Event('blocked') as IDBVersionChangeEvent);
    await expect(opening).rejects.toMatchObject({ code: 'OPEN_FAILED' });

    request.onsuccess?.call(request, new Event('success'));
    expect(close).toHaveBeenCalledOnce();
  });
});
