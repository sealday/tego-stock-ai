import { invalidInput } from '../../src/domain/errors';
import type { MarketEnvelope, StockSearchResult } from '../../src/domain/stock';
import type { MarketDataAdapter } from '../../src/server/tushare/client';
import { createTushareMarketDataAdapterFromEnvironment } from '../../src/server/tushare/client';
import type { HttpRouteDependencies } from '../../src/server/http';
import { createHttpHandler } from '../../src/server/http';

interface SearchHandlerDependencies extends HttpRouteDependencies {
  adapter?: Pick<MarketDataAdapter, 'listStocks'> | undefined;
}

const SEARCH_CACHE = 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800';

export function createSearchHandler(dependencies: SearchHandlerDependencies = {}) {
  return createHttpHandler({
    cacheControl: SEARCH_CACHE,
    rateLimiter: dependencies.rateLimiter,
    logger: dependencies.logger,
    allowedOrigins: dependencies.allowedOrigins,
    requestIdFactory: dependencies.requestIdFactory,
    async execute(request): Promise<MarketEnvelope<readonly StockSearchResult[]>> {
      const query = new URL(request.url).searchParams.get('q')?.trim() ?? '';
      if (query.length === 0 || query.length > 64 || hasControlCharacter(query)) {
        throw invalidInput();
      }

      const directory = await (
        dependencies.adapter ?? createTushareMarketDataAdapterFromEnvironment()
      ).listStocks();
      const normalized = query.toLocaleUpperCase('zh-CN');
      const matches = directory.data
        .filter(
          (stock) =>
            stock.code.includes(normalized) ||
            stock.name.includes(query) ||
            stock.pinyinAbbreviation.toLocaleUpperCase('zh-CN').includes(normalized),
        )
        .slice(0, 50);

      return { ...directory, data: matches };
    },
  });
}

const handler = createSearchHandler();

export default { fetch: handler };

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}
