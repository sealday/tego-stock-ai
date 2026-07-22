import { invalidInput } from '../../../src/domain/errors';
import type { IsoDate, MarketEnvelope, StockFundamentals } from '../../../src/domain/stock';
import { isoDate, stockCode } from '../../../src/domain/stock';
import type { MarketDataAdapter } from '../../../src/server/tushare/client';
import { createTushareMarketDataAdapterFromEnvironment } from '../../../src/server/tushare/client';
import type { HttpRouteDependencies } from '../../../src/server/http';
import { createHttpHandler } from '../../../src/server/http';

interface FundamentalsHandlerDependencies extends HttpRouteDependencies {
  adapter?: Pick<MarketDataAdapter, 'getFundamentals'> | undefined;
}

const FUNDAMENTALS_CACHE = 'public, max-age=300, s-maxage=21600, stale-while-revalidate=86400';

export function createFundamentalsHandler(dependencies: FundamentalsHandlerDependencies = {}) {
  return createHttpHandler({
    cacheControl: FUNDAMENTALS_CACHE,
    rateLimiter: dependencies.rateLimiter,
    logger: dependencies.logger,
    allowedOrigins: dependencies.allowedOrigins,
    requestIdFactory: dependencies.requestIdFactory,
    async execute(request): Promise<MarketEnvelope<StockFundamentals>> {
      const url = new URL(request.url);
      const code = routeStockCode(url, 'fundamentals');
      const asOf = optionalDate(url.searchParams.get('asOf'));
      const adapter = dependencies.adapter ?? createTushareMarketDataAdapterFromEnvironment();

      return asOf === undefined
        ? adapter.getFundamentals({ code })
        : adapter.getFundamentals({ code, asOf });
    },
  });
}

const handler = createFundamentalsHandler();

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
