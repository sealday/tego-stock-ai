export const LOCAL_DATABASE_NAME = 'tego-stock-ai';
export const LOCAL_DATABASE_VERSION = 1;
export const LOCAL_STORE_NAMES = [
  'providerSettings',
  'reports',
  'uiPreferences',
  'watchlists',
] as const;

export type LocalStoreName = (typeof LOCAL_STORE_NAMES)[number];

export type LocalStorageErrorCode =
  | 'UNAVAILABLE'
  | 'OPEN_FAILED'
  | 'MIGRATION_FAILED'
  | 'TRANSACTION_FAILED'
  | 'INVALID_DATA';

const SAFE_STORAGE_MESSAGES: Readonly<Record<LocalStorageErrorCode, string>> = {
  UNAVAILABLE: 'Local browser storage is unavailable',
  OPEN_FAILED: 'Local browser storage could not be opened',
  MIGRATION_FAILED: 'Local browser storage could not be upgraded',
  TRANSACTION_FAILED: 'Local browser storage operation failed',
  INVALID_DATA: 'Local browser storage contains invalid data',
};

export class LocalStorageError extends Error {
  readonly code: LocalStorageErrorCode;

  constructor(code: LocalStorageErrorCode, options?: { readonly cause?: unknown }) {
    super(SAFE_STORAGE_MESSAGES[code], options);
    this.name = 'LocalStorageError';
    this.code = code;
  }
}

export interface LocalDatabaseMigration {
  (
    database: IDBDatabase,
    transaction: IDBTransaction,
    oldVersion: number,
    newVersion: number,
  ): void;
}

export interface OpenLocalDatabaseOptions {
  readonly name?: string;
  readonly version?: number;
  readonly indexedDB?: IDBFactory | null;
  readonly migrate?: LocalDatabaseMigration;
}

export interface LocalTransaction {
  get<T>(storeName: LocalStoreName, key: IDBValidKey): Promise<T | undefined>;
  getAll<T>(storeName: LocalStoreName): Promise<readonly T[]>;
  put(
    storeName: LocalStoreName,
    value: unknown,
    key?: IDBValidKey | undefined,
  ): Promise<IDBValidKey>;
  delete(storeName: LocalStoreName, key: IDBValidKey): Promise<void>;
  clear(storeName: LocalStoreName): Promise<void>;
}

export async function openLocalDatabase(
  options: OpenLocalDatabaseOptions = {},
): Promise<IDBDatabase> {
  const factory = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB;
  if (factory === null || factory === undefined) {
    throw new LocalStorageError('UNAVAILABLE');
  }

  const name = options.name ?? LOCAL_DATABASE_NAME;
  const version = options.version ?? LOCAL_DATABASE_VERSION;
  const migrate = options.migrate ?? migrateLocalDatabase;

  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    let migrationFailure: unknown;
    try {
      request = factory.open(name, version);
    } catch (cause) {
      reject(new LocalStorageError('OPEN_FAILED', { cause }));
      return;
    }

    request.onupgradeneeded = (event) => {
      const transaction = request.transaction;
      if (transaction === null) {
        migrationFailure = new Error('Missing IndexedDB upgrade transaction');
        return;
      }
      try {
        migrate(request.result, transaction, event.oldVersion, event.newVersion ?? version);
      } catch (cause) {
        migrationFailure = cause;
        try {
          transaction.abort();
        } catch {
          // The failed upgrade will still surface through the open request.
        }
      }
    };
    request.onblocked = () => {
      reject(new LocalStorageError('OPEN_FAILED'));
    };
    request.onerror = () => {
      reject(
        migrationFailure === undefined
          ? new LocalStorageError('OPEN_FAILED', { cause: request.error })
          : new LocalStorageError('MIGRATION_FAILED', { cause: migrationFailure }),
      );
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

export function migrateLocalDatabase(
  database: IDBDatabase,
  _transaction: IDBTransaction,
  oldVersion: number,
): void {
  if (oldVersion >= 1) {
    return;
  }
  createStoreIfMissing(database, 'watchlists', { keyPath: 'code' });
  createStoreIfMissing(database, 'uiPreferences', { keyPath: 'id' });
  createStoreIfMissing(database, 'providerSettings', { keyPath: 'id' });
  const reports = createStoreIfMissing(database, 'reports', { keyPath: 'id' });
  if (reports !== null && !reports.indexNames.contains('savedAt')) {
    reports.createIndex('savedAt', 'savedAt');
  }
}

export async function runLocalTransaction<T>(
  database: IDBDatabase,
  storeNames: readonly LocalStoreName[],
  mode: IDBTransactionMode,
  operation: (transaction: LocalTransaction) => Promise<T> | T,
): Promise<T> {
  let rawTransaction: IDBTransaction;
  try {
    rawTransaction = database.transaction(storeNames, mode);
  } catch (cause) {
    throw storageError(cause, 'TRANSACTION_FAILED');
  }

  return new Promise<T>((resolve, reject) => {
    let operationCompleted = false;
    let transactionCompleted = false;
    let result: T | undefined;
    let settled = false;

    const rejectOnce = (cause: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(storageError(cause, 'TRANSACTION_FAILED'));
    };
    const resolveWhenComplete = () => {
      if (settled || !operationCompleted || !transactionCompleted) {
        return;
      }
      settled = true;
      resolve(result as T);
    };

    rawTransaction.oncomplete = () => {
      transactionCompleted = true;
      resolveWhenComplete();
    };
    rawTransaction.onabort = () => {
      rejectOnce(rawTransaction.error);
    };
    rawTransaction.onerror = () => {
      rejectOnce(rawTransaction.error);
    };

    const boundary = createTransactionBoundary(rawTransaction, storeNames);
    Promise.resolve()
      .then(() => operation(boundary))
      .then((value) => {
        result = value;
        operationCompleted = true;
        resolveWhenComplete();
      })
      .catch((cause: unknown) => {
        try {
          rawTransaction.abort();
        } catch {
          // The transaction may already have failed; reject with the original safe error.
        }
        rejectOnce(cause);
      });
  });
}

export async function deleteLocalDatabase(
  name = LOCAL_DATABASE_NAME,
  factory: IDBFactory | null | undefined = globalThis.indexedDB,
): Promise<void> {
  if (factory === null || factory === undefined) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.deleteDatabase(name);
    } catch (cause) {
      reject(new LocalStorageError('OPEN_FAILED', { cause }));
      return;
    }
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new LocalStorageError('OPEN_FAILED', { cause: request.error }));
    request.onblocked = () => reject(new LocalStorageError('OPEN_FAILED'));
  });
}

export function invalidStoredData(cause?: unknown): LocalStorageError {
  return new LocalStorageError('INVALID_DATA', { cause });
}

function createStoreIfMissing(
  database: IDBDatabase,
  name: LocalStoreName,
  options: IDBObjectStoreParameters,
): IDBObjectStore | null {
  return database.objectStoreNames.contains(name)
    ? null
    : database.createObjectStore(name, options);
}

function createTransactionBoundary(
  transaction: IDBTransaction,
  allowedStores: readonly LocalStoreName[],
): LocalTransaction {
  const stores = new Set<LocalStoreName>(allowedStores);
  const objectStore = (name: LocalStoreName): IDBObjectStore => {
    if (!stores.has(name)) {
      throw new LocalStorageError('TRANSACTION_FAILED');
    }
    return transaction.objectStore(name);
  };

  return {
    get: <T>(storeName: LocalStoreName, key: IDBValidKey) =>
      requestResult<T | undefined>(objectStore(storeName).get(key)),
    getAll: <T>(storeName: LocalStoreName) => requestResult<T[]>(objectStore(storeName).getAll()),
    put: (storeName: LocalStoreName, value: unknown, key?: IDBValidKey) => {
      const store = objectStore(storeName);
      return requestResult<IDBValidKey>(
        key === undefined ? store.put(value) : store.put(value, key),
      );
    },
    delete: async (storeName: LocalStoreName, key: IDBValidKey) => {
      await requestResult(objectStore(storeName).delete(key));
    },
    clear: async (storeName: LocalStoreName) => {
      await requestResult(objectStore(storeName).clear());
    },
  };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new LocalStorageError('TRANSACTION_FAILED'));
  });
}

function storageError(
  cause: unknown,
  fallbackCode: Exclude<LocalStorageErrorCode, 'INVALID_DATA'>,
): LocalStorageError {
  return cause instanceof LocalStorageError
    ? cause
    : new LocalStorageError(fallbackCode, { cause });
}
