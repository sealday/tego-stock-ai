import type { MarketEnvelope, MarketSnapshotStatus } from '../../src/domain/stock';
import { createBlobSnapshotStore } from '../../src/server/blob-snapshot-store';
import type { SnapshotStore } from '../../src/server/cache';
import type { HttpRouteDependencies } from '../../src/server/http';
import { createHttpHandler } from '../../src/server/http';
import { readMarketSnapshot } from '../../src/server/market-snapshot';

interface MarketStatusHandlerDependencies extends HttpRouteDependencies {
  store?: SnapshotStore | undefined;
  now?: (() => Date) | undefined;
}

export function createMarketStatusHandler(dependencies: MarketStatusHandlerDependencies = {}) {
  const store = dependencies.store ?? createBlobSnapshotStore();

  return createHttpHandler({
    cacheControl: 'no-store',
    rateLimiter: dependencies.rateLimiter,
    logger: dependencies.logger,
    allowedOrigins: dependencies.allowedOrigins,
    requestIdFactory: dependencies.requestIdFactory,
    async execute(): Promise<MarketEnvelope<MarketSnapshotStatus>> {
      const status = await readMarketSnapshot({ store, now: dependencies.now });

      return {
        data: status,
        asOf: status.asOf,
        source: 'Tushare Pro',
        freshness: status.freshness,
        availability: { snapshot: { status: 'available', value: true } },
        limitations: ['Daily-close data only; freshness is measured against the next market close'],
      };
    },
  });
}

const handler = createMarketStatusHandler();

export default { fetch: handler };
