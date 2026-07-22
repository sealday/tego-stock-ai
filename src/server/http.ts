import { AppError, normalizeError, safeErrorMessage } from '../domain/errors';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  consume(key: string): RateLimitResult;
}

interface TokenBucketOptions {
  capacity: number;
  refillTokens: number;
  refillIntervalMs: number;
  idleTtlMs?: number;
  maxBuckets?: number;
  now?: () => number;
}

interface TokenBucketState {
  tokens: number;
  lastRefill: number;
  lastSeen: number;
}

export interface SafeLogger {
  info(record: Readonly<Record<string, string | number | boolean>>): void;
  error(record: Readonly<Record<string, string | number | boolean>>): void;
}

export interface RequestContext {
  requestId: string;
}

export interface HttpRouteDependencies {
  rateLimiter?: RateLimiter | undefined;
  logger?: SafeLogger | undefined;
  allowedOrigins?: readonly string[] | undefined;
  requestIdFactory?: (() => string) | undefined;
}

interface HttpHandlerOptions<T> extends HttpRouteDependencies {
  execute(request: Request, context: RequestContext): Promise<T>;
  cacheControl: string;
}

const DEFAULT_LOGGER: SafeLogger = {
  info: (record) => console.info(record),
  error: (record) => console.error(record),
};

export function createTokenBucket(options: TokenBucketOptions): RateLimiter {
  const idleTtlMs = options.idleTtlMs ?? 10 * 60_000;
  const maxBuckets = options.maxBuckets ?? 10_000;
  if (
    !Number.isInteger(options.capacity) ||
    options.capacity <= 0 ||
    !Number.isInteger(options.refillTokens) ||
    options.refillTokens <= 0 ||
    options.refillIntervalMs <= 0 ||
    idleTtlMs <= 0 ||
    !Number.isInteger(maxBuckets) ||
    maxBuckets <= 0
  ) {
    throw new TypeError('Invalid token bucket configuration');
  }

  const now = options.now ?? Date.now;
  const buckets = new Map<string, TokenBucketState>();

  return {
    consume(key) {
      const timestamp = now();
      evictIdleBuckets(
        buckets,
        timestamp,
        idleTtlMs,
        options.capacity,
        options.refillTokens,
        options.refillIntervalMs,
      );
      let state = buckets.get(key);
      if (state === undefined) {
        evictLeastRecentlyUsedBucket(buckets, maxBuckets);
        state = { tokens: options.capacity, lastRefill: timestamp, lastSeen: timestamp };
      } else {
        buckets.delete(key);
        state.lastSeen = timestamp;
      }
      const elapsed = Math.max(0, timestamp - state.lastRefill);
      const intervals = Math.floor(elapsed / options.refillIntervalMs);

      if (intervals > 0) {
        state.tokens = Math.min(options.capacity, state.tokens + intervals * options.refillTokens);
        state.lastRefill += intervals * options.refillIntervalMs;
      }

      if (state.tokens >= 1) {
        state.tokens -= 1;
        buckets.set(key, state);
        return { allowed: true, retryAfterSeconds: 0 };
      }

      buckets.set(key, state);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((options.refillIntervalMs - (timestamp - state.lastRefill)) / 1_000),
        ),
      };
    },
  };
}

function evictIdleBuckets(
  buckets: Map<string, TokenBucketState>,
  timestamp: number,
  idleTtlMs: number,
  capacity: number,
  refillTokens: number,
  refillIntervalMs: number,
): void {
  for (const [key, state] of buckets) {
    if (timestamp - state.lastSeen < idleTtlMs) {
      break;
    }
    const elapsed = Math.max(0, timestamp - state.lastRefill);
    const intervals = Math.floor(elapsed / refillIntervalMs);
    if (state.tokens + intervals * refillTokens >= capacity) {
      buckets.delete(key);
    }
  }
}

function evictLeastRecentlyUsedBucket(
  buckets: Map<string, TokenBucketState>,
  maxBuckets: number,
): void {
  if (buckets.size < maxBuckets) {
    return;
  }

  const leastRecentlyUsedKey = buckets.keys().next().value;
  if (leastRecentlyUsedKey !== undefined) {
    buckets.delete(leastRecentlyUsedKey);
  }
}

export function createHttpHandler<T>(options: HttpHandlerOptions<T>) {
  const limiter =
    options.rateLimiter ??
    createTokenBucket({ capacity: 60, refillTokens: 60, refillIntervalMs: 60_000 });
  const logger = options.logger ?? DEFAULT_LOGGER;
  const allowedOrigins = options.allowedOrigins ?? productionOrigins();
  const requestIdFactory = options.requestIdFactory ?? (() => crypto.randomUUID());

  return async (request: Request): Promise<Response> => {
    const requestId = requestIdFactory();
    const cors = corsHeaders(request, allowedOrigins);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (request.method !== 'GET') {
        throw new AppError('INVALID_INPUT', safeErrorMessage('INVALID_INPUT'), {
          status: 405,
          retryable: false,
        });
      }

      const rateLimit = limiter.consume(clientIp(request));
      if (!rateLimit.allowed) {
        const response = errorResponse(
          new AppError('RATE_LIMITED', safeErrorMessage('RATE_LIMITED'), {
            status: 429,
            retryable: true,
          }),
          requestId,
          cors,
        );
        response.headers.set('retry-after', String(rateLimit.retryAfterSeconds));
        return response;
      }

      const result = await options.execute(request, { requestId });
      const headers = new Headers(cors);
      headers.set('cache-control', options.cacheControl);
      headers.set('content-type', 'application/json; charset=utf-8');
      headers.set('x-request-id', requestId);
      logger.info({
        requestId,
        method: request.method,
        path: new URL(request.url).pathname,
        status: 200,
      });

      return new Response(JSON.stringify(result), { status: 200, headers });
    } catch (caught) {
      const error = normalizeError(caught);
      const providerCode = safeProviderCode(error.providerCode);
      logger.error({
        requestId,
        errorCode: error.code,
        status: error.status,
        ...(providerCode === undefined ? {} : { providerCode }),
      });
      return errorResponse(error, requestId, cors);
    }
  };
}

function errorResponse(error: AppError, requestId: string, cors: Headers): Response {
  const headers = new Headers(cors);
  headers.set('cache-control', 'no-store');
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('x-request-id', requestId);

  return new Response(
    JSON.stringify({
      error: {
        code: error.code,
        message: safeErrorMessage(error.code),
        requestId,
        retryable: error.retryable,
      },
    }),
    { status: error.status, headers },
  );
}

function corsHeaders(request: Request, allowedOrigins: readonly string[]): Headers {
  const headers = new Headers({
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'Content-Type, X-Request-ID',
    vary: 'Origin',
  });
  const origin = request.headers.get('origin');

  if (origin !== null && allowedOrigins.includes(origin)) {
    headers.set('access-control-allow-origin', origin);
  }

  return headers;
}

function productionOrigins(): string[] {
  const configuredOrigin = process.env.PUBLIC_APP_ORIGIN;
  if (configuredOrigin !== undefined && configuredOrigin.length > 0) {
    return [configuredOrigin];
  }

  const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return productionHost === undefined || productionHost.length === 0
    ? []
    : [`https://${productionHost}`];
}

function clientIp(request: Request): string {
  const forwarded =
    request.headers.get('x-vercel-forwarded-for') ?? request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first === undefined || first.length === 0 ? 'unknown' : first.slice(0, 64);
}

function safeProviderCode(providerCode: string | undefined): string | undefined {
  return providerCode !== undefined && /^[A-Z0-9_-]{1,32}$/i.test(providerCode)
    ? providerCode
    : undefined;
}
