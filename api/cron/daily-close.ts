import { timingSafeEqual } from 'node:crypto';

import { AppError, normalizeError, safeErrorMessage } from '../../src/domain/errors';
import type { MarketEnvelope, MarketSnapshotStatus } from '../../src/domain/stock';
import { createBlobSnapshotStore } from '../../src/server/blob-snapshot-store';
import type { SnapshotStore } from '../../src/server/cache';
import type { HttpRouteDependencies } from '../../src/server/http';
import { createHttpHandler } from '../../src/server/http';
import {
  createTushareMarketSnapshotSourceFromEnvironment,
  readMarketSnapshot,
  refreshMarketSnapshot,
  type MarketSnapshotSource,
} from '../../src/server/market-snapshot';

interface DailyCloseCronHandlerDependencies extends HttpRouteDependencies {
  environment?: Readonly<{ CRON_SECRET?: string | undefined }> | undefined;
  source?: MarketSnapshotSource | undefined;
  store?: SnapshotStore | undefined;
  now?: (() => Date) | undefined;
}

export function createDailyCloseCronHandler(dependencies: DailyCloseCronHandlerDependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const now = dependencies.now ?? (() => new Date());

  return createHttpHandler({
    cacheControl: 'no-store',
    rateLimiter: dependencies.rateLimiter,
    logger: dependencies.logger,
    allowedOrigins: dependencies.allowedOrigins,
    requestIdFactory: dependencies.requestIdFactory,
    async execute(request): Promise<MarketEnvelope<MarketSnapshotStatus>> {
      const secret = environment.CRON_SECRET;
      if (secret === undefined || secret.length === 0) {
        throw new AppError('INTERNAL_ERROR', safeErrorMessage('INTERNAL_ERROR'), {
          status: 503,
          retryable: true,
        });
      }
      if (!authorized(request.headers.get('authorization'), secret)) {
        throw new AppError('INVALID_INPUT', safeErrorMessage('INVALID_INPUT'), {
          status: 401,
          retryable: false,
        });
      }

      const store = dependencies.store ?? createBlobSnapshotStore();
      const source = dependencies.source ?? createTushareMarketSnapshotSourceFromEnvironment();
      const refreshTime = now();
      try {
        await refreshMarketSnapshot({ store, source, now: () => refreshTime });
      } catch (caught) {
        const error = normalizeError(caught);
        if (error.code.startsWith('PROVIDER_')) {
          throw new AppError(error.code, safeErrorMessage(error.code), {
            status: 502,
            retryable: error.retryable,
            ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
            cause: error,
          });
        }
        throw error;
      }

      const status = await readMarketSnapshot({ store, now: () => refreshTime });
      return {
        data: status,
        asOf: status.asOf,
        source: 'Tushare Pro',
        freshness: status.freshness,
        availability: { snapshot: { status: 'available', value: true } },
        limitations: ['Daily-close data only; scheduled refresh is not a real-time quote'],
      };
    },
  });
}

function authorized(header: string | null, secret: string): boolean {
  if (header === null) {
    return false;
  }
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const handler = createDailyCloseCronHandler();

export default { fetch: handler };
