import { invalidInput } from '../../../src/domain/errors';
import type { IsoDate, MarketEnvelope, StockOverview } from '../../../src/domain/stock';
import { isoDate, stockCode } from '../../../src/domain/stock';
import type { MarketDataAdapter } from '../../../src/server/tushare/client';
import { createTushareMarketDataAdapterFromEnvironment } from '../../../src/server/tushare/client';
import type { HttpRouteDependencies } from '../../../src/server/http';
import { createHttpHandler } from '../../../src/server/http';

interface OverviewHandlerDependencies extends HttpRouteDependencies {
  adapter?: Pick<MarketDataAdapter, 'getOverview'> | undefined;
}

const OVERVIEW_CACHE = 'public, max-age=60, s-maxage=900, stale-while-revalidate=3600';

export function createOverviewHandler(dependencies: OverviewHandlerDependencies = {}) {
  return createHttpHandler({
    cacheControl: OVERVIEW_CACHE,
    rateLimiter: dependencies.rateLimiter,
    logger: dependencies.logger,
    allowedOrigins: dependencies.allowedOrigins,
    requestIdFactory: dependencies.requestIdFactory,
    async execute(request): Promise<MarketEnvelope<StockOverview>> {
      const url = new URL(request.url);
      const code = routeStockCode(url, 'overview');
      const asOf = optionalDate(url.searchParams.get('asOf'));
      const adapter = dependencies.adapter ?? createTushareMarketDataAdapterFromEnvironment();

      return asOf === undefined
        ? adapter.getOverview({ code })
        : adapter.getOverview({ code, asOf });
    },
  });
}

const handler = createOverviewHandler();

export default { fetch: handler };

function routeStockCode(url: URL, routeName: string) {
  const segments = url.pathname.split('/').filter(Boolean);
  const routeIndex = segments.lastIndexOf(routeName);

  try {
    return stockCode(routeIndex > 0 ? (segments[routeIndex - 1] ?? '') : '');
  } catch {
    throw invalidInput();
  }
}

function optionalDate(value: string | null): IsoDate | undefined {
  if (value === null) {
    return undefined;
  }

  try {
    return isoDate(value);
  } catch {
    throw invalidInput();
  }
}
