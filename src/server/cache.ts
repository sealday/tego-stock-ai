import type { ErrorCode } from '../domain/errors';

export const MARKET_SNAPSHOT_KEY = 'market-snapshots';

export interface SafeSnapshotFailure {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  occurredAt: string;
}

export interface SnapshotStore {
  read<T>(key: string): Promise<T | null>;
  writeAtomically<T>(key: string, value: T): Promise<void>;
  recordFailure(key: string, safeError: SafeSnapshotFailure): Promise<void>;
}
