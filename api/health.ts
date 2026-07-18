import type { MarketEnvelope } from '../src/domain/stock';
import { isoDate } from '../src/domain/stock';
import type { HttpRouteDependencies } from '../src/server/http';
import { createHttpHandler } from '../src/server/http';

interface HealthHandlerDependencies extends HttpRouteDependencies {
  environment?: Pick<NodeJS.ProcessEnv, 'TUSHARE_TOKEN'> | undefined;
  now?: (() => Date) | undefined;
}

interface HealthData {
  status: 'ok';
  providerConfigured: boolean;
}

export function createHealthHandler(dependencies: HealthHandlerDependencies = {}) {
  return createHttpHandler({
    cacheControl: 'no-store',
    rateLimiter: dependencies.rateLimiter,
    logger: dependencies.logger,
    allowedOrigins: dependencies.allowedOrigins,
    requestIdFactory: dependencies.requestIdFactory,
    async execute(): Promise<MarketEnvelope<HealthData>> {
      const environment = dependencies.environment ?? process.env;
      const asOf = isoDate((dependencies.now ?? (() => new Date()))().toISOString().slice(0, 10));
      const configured = (environment.TUSHARE_TOKEN?.length ?? 0) > 0;

      return {
        data: { status: 'ok', providerConfigured: configured },
        asOf,
        source: 'Tushare Pro',
        freshness: 'fresh',
        availability: {
          provider: configured
            ? { status: 'available', value: true }
            : { status: 'missing', reason: 'Server-side provider token is not configured' },
        },
        limitations: ['Health status does not validate provider permissions'],
      };
    },
  });
}

const handler = createHealthHandler();

export default { fetch: handler };
