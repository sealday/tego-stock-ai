import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const CHECKS = ['health', 'api-error', 'api-cache', 'spa-fallback', 'cron-protection'];
const EXPLICIT_BASE_URL_ERROR = 'An explicit HTTP(S) deployment base URL is required.';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * @typedef {(input: string | URL | Request, init?: RequestInit) => Promise<Response>} SmokeFetch
 */

/**
 * @param {{ baseUrl: string, fetch?: SmokeFetch }} options
 * @returns {Promise<{ checks: readonly string[] }>}
 */
export async function runDeploymentSmoke(options) {
  const baseUrl = parseBaseUrl(options?.baseUrl);
  const fetchResponse = options.fetch ?? globalThis.fetch;

  const health = await request(fetchResponse, baseUrl, '/api/health');
  requireStatus(health, 200, 'health endpoint did not return HTTP 200');
  requireJsonContentType(health, 'health endpoint did not return JSON');
  requireNoStore(health, 'health endpoint is cacheable');
  const healthBody = await parseJson(health, 'health endpoint returned invalid JSON');
  if (!isObject(healthBody) || !isObject(healthBody.data) || healthBody.data.status !== 'ok') {
    fail('health endpoint returned an invalid payload');
  }
  if (healthBody.data.providerConfigured !== true) {
    fail('health endpoint reports provider is not configured');
  }

  const apiError = await request(fetchResponse, baseUrl, '/api/stocks/search?q=');
  requireStatus(apiError, 400, 'invalid API request did not return HTTP 400');
  requireJsonContentType(apiError, 'invalid API request did not return JSON');
  requireNoStore(apiError, 'API error response is cacheable');
  const apiErrorBody = await parseJson(apiError, 'invalid API request returned invalid JSON');
  if (!hasErrorShape(apiErrorBody, 'INVALID_INPUT')) {
    fail('invalid API request returned an unexpected error shape');
  }

  const stockProbePath = `/api/stocks/search?q=600519&deployment-smoke=${randomUUID()}`;
  const cachedApi = await request(fetchResponse, baseUrl, stockProbePath, {
    headers: { pragma: 'no-cache' },
  });
  requireStatus(cachedApi, 200, 'cache probe did not return HTTP 200');
  requireJsonContentType(cachedApi, 'cache probe did not return JSON');
  const cacheControl = cachedApi.headers.get('cache-control') ?? '';
  if (!hasSafePositivePublicCachePolicy(cacheControl)) {
    fail('cache probe did not return a safe positive public cache policy');
  }
  const vercelCache = cachedApi.headers.get('x-vercel-cache')?.trim().toUpperCase();
  if (vercelCache !== 'MISS' && vercelCache !== 'REVALIDATED') {
    fail('cache probe did not confirm the current Vercel deployment');
  }
  const cachedApiBody = await parseJson(cachedApi, 'cache probe returned invalid JSON');
  if (!hasMarketEnvelopeMetadata(cachedApiBody)) {
    fail('cache probe returned invalid market envelope metadata');
  }
  if (!cachedApiBody.data.some((stock) => isObject(stock) && stock.code === '600519.SH')) {
    fail('cache probe did not include 600519.SH');
  }

  const repeatCachedApi = await request(fetchResponse, baseUrl, stockProbePath);
  requireStatus(repeatCachedApi, 200, 'repeat cache probe did not return HTTP 200');
  requireJsonContentType(repeatCachedApi, 'repeat cache probe did not return JSON');
  const repeatCacheControl = repeatCachedApi.headers.get('cache-control') ?? '';
  if (!hasSafePositivePublicCachePolicy(repeatCacheControl)) {
    fail('repeat cache probe did not return a safe positive public cache policy');
  }
  if (repeatCachedApi.headers.get('x-vercel-cache')?.trim().toUpperCase() !== 'HIT') {
    fail('repeat cache probe did not return a shared Vercel HIT');
  }
  const repeatCachedApiBody = await parseJson(
    repeatCachedApi,
    'repeat cache probe returned invalid JSON',
  );
  if (!hasMarketEnvelopeMetadata(repeatCachedApiBody)) {
    fail('repeat cache probe returned invalid market envelope metadata');
  }
  if (!repeatCachedApiBody.data.some((stock) => isObject(stock) && stock.code === '600519.SH')) {
    fail('repeat cache probe did not include 600519.SH');
  }

  const spa = await request(fetchResponse, baseUrl, '/deployment-smoke/spa-fallback');
  requireStatus(spa, 200, 'SPA fallback did not return HTTP 200');
  const spaContentType = spa.headers.get('content-type') ?? '';
  if (!/^text\/html(?:\s*;|$)/i.test(spaContentType)) {
    fail('SPA fallback did not return HTML');
  }
  const spaHtml = await readText(spa, 'SPA fallback body could not be read');
  if (!/<div\s+[^>]*id=["']root["'][^>]*>/i.test(spaHtml)) {
    fail('SPA fallback did not return the application shell');
  }

  const cron = await request(fetchResponse, baseUrl, '/api/cron/daily-close');
  requireStatus(cron, 401, 'unauthenticated Cron request did not return HTTP 401');
  requireJsonContentType(cron, 'unauthenticated Cron request did not return JSON');
  requireNoStore(cron, 'Cron error response is cacheable');
  const cronBody = await parseJson(cron, 'unauthenticated Cron request returned invalid JSON');
  if (!hasErrorShape(cronBody, 'INVALID_INPUT')) {
    fail('unauthenticated Cron request returned an unexpected error shape');
  }

  return { checks: CHECKS };
}

/** @param {unknown} value */
function parseBaseUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(EXPLICIT_BASE_URL_ERROR);
  }

  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      throw new Error(EXPLICIT_BASE_URL_ERROR);
    }
    return parsed;
  } catch {
    throw new Error(EXPLICIT_BASE_URL_ERROR);
  }
}

/**
 * @param {SmokeFetch} fetchResponse
 * @param {URL} baseUrl
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function request(fetchResponse, baseUrl, path, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref();
  try {
    const response = await fetchResponse(new URL(path, baseUrl), {
      ...init,
      redirect: 'error',
      signal: controller.signal,
    });
    const body = await response.arrayBuffer();
    return new Response(body, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  } catch {
    fail('a deployment request could not be completed');
  } finally {
    clearTimeout(timeout);
  }
}

/** @param {string} value */
function hasSafePositivePublicCachePolicy(value) {
  const directives = new Map();
  for (const segment of value.split(',')) {
    const [rawName, ...rawValue] = segment.trim().split('=');
    const name = rawName?.trim().toLowerCase();
    if (!name || directives.has(name)) {
      return false;
    }
    directives.set(name, rawValue.length === 0 ? undefined : rawValue.join('=').trim());
  }

  if (
    !directives.has('public') ||
    directives.get('public') !== undefined ||
    directives.has('private') ||
    directives.has('no-store') ||
    directives.has('no-cache')
  ) {
    return false;
  }

  const maxAge = directives.get('max-age');
  const sMaxAge = directives.get('s-maxage');
  return (
    isPositiveDeltaSeconds(maxAge) &&
    (!directives.has('s-maxage') || isPositiveDeltaSeconds(sMaxAge))
  );
}

/** @param {unknown} value */
function isPositiveDeltaSeconds(value) {
  return (
    typeof value === 'string' &&
    /^\d+$/.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0
  );
}

/** @param {unknown} value */
function hasMarketEnvelopeMetadata(value) {
  return (
    isObject(value) &&
    Array.isArray(value.data) &&
    isIsoDate(value.asOf) &&
    value.source === 'Tushare Pro' &&
    (value.freshness === 'fresh' || value.freshness === 'stale') &&
    isObject(value.availability) &&
    Array.isArray(value.limitations) &&
    value.limitations.every((limitation) => typeof limitation === 'string')
  );
}

/** @param {unknown} value */
function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

/** @param {Response} response @param {number} expected @param {string} message */
function requireStatus(response, expected, message) {
  if (response.status !== expected) {
    fail(message);
  }
}

/** @param {Response} response @param {string} message */
function requireJsonContentType(response, message) {
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    fail(message);
  }
}

/** @param {Response} response @param {string} message */
function requireNoStore(response, message) {
  if (!/(?:^|,)\s*no-store(?:\s*,|$)/i.test(response.headers.get('cache-control') ?? '')) {
    fail(message);
  }
}

/** @param {Response} response @param {string} message */
async function parseJson(response, message) {
  try {
    return await response.json();
  } catch {
    fail(message);
  }
}

/** @param {Response} response @param {string} message */
async function readText(response, message) {
  try {
    return await response.text();
  } catch {
    fail(message);
  }
}

/** @param {unknown} value @param {string} expectedCode */
function hasErrorShape(value, expectedCode) {
  if (!isObject(value) || !isObject(value.error)) {
    return false;
  }

  return (
    value.error.code === expectedCode &&
    typeof value.error.message === 'string' &&
    value.error.message.length > 0 &&
    typeof value.error.requestId === 'string' &&
    value.error.requestId.length > 0 &&
    typeof value.error.retryable === 'boolean'
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} message */
function fail(message) {
  throw new Error(`Deployment smoke failed: ${message}.`);
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 1) {
    throw new Error(EXPLICIT_BASE_URL_ERROR);
  }

  const result = await runDeploymentSmoke({ baseUrl: arguments_[0] });
  console.log(`Deployment smoke passed ${result.checks.length} checks.`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  main().catch((caught) => {
    const message = caught instanceof Error ? caught.message : 'Deployment smoke failed.';
    console.error(message);
    process.exitCode = 1;
  });
}
