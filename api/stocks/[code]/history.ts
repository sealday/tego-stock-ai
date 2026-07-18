import { invalidInput } from '../../../src/domain/errors';
import type { IsoDate, MarketEnvelope, DailyPrice } from '../../../src/domain/stock';
import { isoDate, stockCode } from '../../../src/domain/stock';
import type { MarketDataAdapter } from '../../../src/server/tushare/client';
import { createTushareMarketDataAdapterFromEnvironment } from '../../../src/server/tushare/client';
import type { HttpRouteDependencies } from '../../../src/server/http';
import { createHttpHandler } from '../../../src/server/http';

interface HistoryHandlerDependencies extends HttpRouteDependencies {
  adapter?: Pick<MarketDataAdapter, 'getHistory'> | undefined;
}

const HISTORY_CACHE = 'public, max-age=300, s-maxage=21600, stale-while-revalidate=86400';

export function createHistoryHandler(dependencies: HistoryHandlerDependencies = {}) {
  return createHttpHandler({
    cacheControl: HISTORY_CACHE,
    rateLimiter: dependencies.rateLimiter,
    logger: dependencies.logger,
    allowedOrigins: dependencies.allowedOrigins,
    requestIdFactory: dependencies.requestIdFactory,
    async execute(request): Promise<MarketEnvelope<readonly DailyPrice[]>> {
      const url = new URL(request.url);
      const code = requestStockCode(url, 'history');
      const start = requestDate(url.searchParams.get('start'));
      const end = requestDate(url.searchParams.get('end'));
      const adjust = url.searchParams.get('adjust') ?? 'forward';

      if (adjust !== 'forward' || start > end || end > maximumEndDate(start)) {
        throw invalidInput();
      }

      return (dependencies.adapter ?? createTushareMarketDataAdapterFromEnvironment()).getHistory({
        code,
        start,
        end,
        adjust,
      });
    },
  });
}

const handler = createHistoryHandler();

export default { fetch: handler };

function requestStockCode(url: URL, routeName: string) {
  const segments = url.pathname.split('/').filter(Boolean);
  const routeIndex = segments.lastIndexOf(routeName);
  const value = routeIndex > 0 ? segments[routeIndex - 1] : undefined;

  try {
    return stockCode(value ?? '');
  } catch {
    throw invalidInput();
  }
}

function requestDate(value: string | null): IsoDate {
  try {
    return isoDate(value ?? '');
  } catch {
    throw invalidInput();
  }
}

function maximumEndDate(start: IsoDate): string {
  const year = Number(start.slice(0, 4)) + 10;
  const monthAndDay = start.slice(4);

  return monthAndDay === '-02-29' && !isLeapYear(year) ? `${year}-02-28` : `${year}${monthAndDay}`;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
