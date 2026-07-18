import { BlobPreconditionFailedError, get, put } from '@vercel/blob';
import { createHash } from 'node:crypto';

import { AppError, safeErrorMessage } from '../domain/errors';
import type { SafeSnapshotFailure, SnapshotStore } from './cache';

interface BlobGetOptions {
  access: 'private';
  useCache: boolean;
}

interface BlobPutOptions {
  access: 'private';
  addRandomSuffix: false;
  allowOverwrite: boolean;
  cacheControlMaxAge: number;
  contentType: 'application/json';
  ifMatch?: string;
}

interface SnapshotBlobObject {
  body: string;
  etag: string;
}

export interface SnapshotBlobClient {
  get(pathname: string, options: BlobGetOptions): Promise<SnapshotBlobObject | null>;
  put(pathname: string, body: string, options: BlobPutOptions): Promise<void>;
}

interface BlobSnapshotStoreOptions {
  client?: SnapshotBlobClient | undefined;
}

interface SnapshotPointer {
  snapshotPath: string;
}

const IMMUTABLE_CACHE_SECONDS = 365 * 24 * 60 * 60;
const POINTER_CACHE_SECONDS = 60;
const DEFAULT_CLIENT: SnapshotBlobClient = {
  async get(pathname, options) {
    const result = await get(pathname, options);
    if (result === null || result.statusCode !== 200) {
      return null;
    }

    return {
      body: await new Response(result.stream).text(),
      etag: result.blob.etag,
    };
  },
  async put(pathname, body, options) {
    await put(pathname, body, options);
  },
};

export class SnapshotConflictError extends AppError {
  constructor(cause: unknown) {
    super('INTERNAL_ERROR', safeErrorMessage('INTERNAL_ERROR'), {
      status: 409,
      retryable: true,
      cause,
    });
    this.name = 'SnapshotConflictError';
  }
}

export function createBlobSnapshotStore(options: BlobSnapshotStoreOptions = {}): SnapshotStore {
  const client = options.client ?? DEFAULT_CLIENT;

  return {
    async read<T>(key: string): Promise<T | null> {
      assertSafeKey(key);
      const pointer = await client.get(pointerPath(key), {
        access: 'private',
        useCache: false,
      });
      if (pointer === null) {
        return null;
      }

      const parsedPointer = parsePointer(pointer.body, key);
      const snapshot = await client.get(parsedPointer.snapshotPath, {
        access: 'private',
        useCache: true,
      });
      if (snapshot === null) {
        throw storageUnavailable('SNAPSHOT_OBJECT_MISSING');
      }

      try {
        return JSON.parse(snapshot.body) as T;
      } catch (error) {
        throw storageUnavailable('SNAPSHOT_OBJECT_INVALID', error);
      }
    },

    async writeAtomically<T>(key: string, value: T): Promise<void> {
      assertSafeKey(key);
      const body = JSON.stringify(value);
      const date = snapshotDate(value);
      const snapshotPath = `${key}/snapshots/${date}/${contentHash(body)}.json`;
      const pointer = await client.get(pointerPath(key), {
        access: 'private',
        useCache: false,
      });

      await client.put(snapshotPath, body, immutablePutOptions());

      try {
        await client.put(
          pointerPath(key),
          JSON.stringify({ snapshotPath } satisfies SnapshotPointer),
          pointer === null ? pointerPutOptions() : pointerPutOptions({ ifMatch: pointer.etag }),
        );
      } catch (error) {
        let winner: SnapshotBlobObject | null;
        try {
          winner = await client.get(pointerPath(key), {
            access: 'private',
            useCache: false,
          });
        } catch {
          throw error;
        }
        if (winner === null) {
          throw error;
        }
        const winnerPath = parsePointer(winner.body, key).snapshotPath;
        if (winnerPath === snapshotPath) {
          return;
        }
        if (pointer === null || error instanceof BlobPreconditionFailedError) {
          throw new SnapshotConflictError(error);
        }
        throw error;
      }
    },

    async recordFailure(key: string, safeError: SafeSnapshotFailure): Promise<void> {
      assertSafeKey(key);
      const body = JSON.stringify(safeError);
      const date = safeError.occurredAt.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new TypeError('Invalid snapshot failure timestamp');
      }
      await client.put(
        `${key}/failures/${date}/${contentHash(body)}.json`,
        body,
        immutablePutOptions(),
      );
    },
  };
}

function pointerPath(key: string): string {
  return `${key}/current.json`;
}

function parsePointer(body: string, key: string): SnapshotPointer {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw storageUnavailable('SNAPSHOT_POINTER_INVALID', error);
  }

  if (
    typeof value !== 'object' ||
    value === null ||
    !('snapshotPath' in value) ||
    typeof value.snapshotPath !== 'string' ||
    !value.snapshotPath.startsWith(`${key}/snapshots/`) ||
    !/^[-a-zA-Z0-9/_.]+$/.test(value.snapshotPath)
  ) {
    throw storageUnavailable('SNAPSHOT_POINTER_INVALID');
  }

  return { snapshotPath: value.snapshotPath };
}

function snapshotDate(value: unknown): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('asOf' in value) ||
    typeof value.asOf !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.asOf)
  ) {
    throw new TypeError('Snapshot value must include an ISO cutoff date');
  }

  return value.asOf;
}

function contentHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function immutablePutOptions(): BlobPutOptions {
  return {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: IMMUTABLE_CACHE_SECONDS,
    contentType: 'application/json',
  };
}

function pointerPutOptions(input: { ifMatch?: string } = {}): BlobPutOptions {
  return {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: input.ifMatch !== undefined,
    cacheControlMaxAge: POINTER_CACHE_SECONDS,
    contentType: 'application/json',
    ...(input.ifMatch === undefined ? {} : { ifMatch: input.ifMatch }),
  };
}

function assertSafeKey(key: string): void {
  if (!/^[a-z0-9-]+$/.test(key)) {
    throw new TypeError('Invalid snapshot key');
  }
}

function storageUnavailable(providerCode: string, cause?: unknown): AppError {
  return new AppError('PROVIDER_UNAVAILABLE', safeErrorMessage('PROVIDER_UNAVAILABLE'), {
    status: 503,
    retryable: true,
    providerCode,
    ...(cause === undefined ? {} : { cause }),
  });
}
