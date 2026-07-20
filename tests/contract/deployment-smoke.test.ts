import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

type SmokeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface DeploymentSmokeModule {
  runDeploymentSmoke(options: {
    baseUrl: string;
    fetch?: SmokeFetch;
  }): Promise<{ checks: readonly string[] }>;
}

const moduleUrl = new URL('../../scripts/deployment-smoke.mjs', import.meta.url).href;

async function loadDeploymentSmoke(): Promise<DeploymentSmokeModule> {
  const loaded: unknown = await import(moduleUrl);

  if (
    typeof loaded !== 'object' ||
    loaded === null ||
    !('runDeploymentSmoke' in loaded) ||
    typeof loaded.runDeploymentSmoke !== 'function'
  ) {
    throw new TypeError('The deployment smoke module does not export runDeploymentSmoke.');
  }

  return loaded as DeploymentSmokeModule;
}

function jsonResponse(body: unknown, init: ResponseInit): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { ...init, headers });
}

function successfulRoutes(): Map<string, Response> {
  return new Map([
    [
      'GET /api/health',
      jsonResponse(
        {
          data: { status: 'ok', providerConfigured: true },
          asOf: '2026-07-20',
          source: 'Tushare Pro',
          freshness: 'fresh',
          availability: {},
          limitations: [],
        },
        { status: 200, headers: { 'cache-control': 'no-store' } },
      ),
    ],
    [
      'GET /api/stocks/search?q=',
      jsonResponse(
        {
          error: {
            code: 'INVALID_INPUT',
            message: 'The request input is invalid',
            requestId: 'request-invalid',
            retryable: false,
          },
        },
        { status: 400, headers: { 'cache-control': 'no-store' } },
      ),
    ],
    [
      'GET /api/stocks/search?q=600519',
      jsonResponse(
        {
          data: [{ code: '600519.SH', name: '贵州茅台', pinyinAbbreviation: 'GZMT' }],
          asOf: '2026-07-18',
          source: 'Tushare Pro',
          freshness: 'fresh',
          availability: {},
          limitations: ['Daily-close data only'],
        },
        {
          status: 200,
          headers: {
            'cache-control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800',
          },
        },
      ),
    ],
    [
      'GET /deployment-smoke/spa-fallback',
      new Response('<!doctype html><html><body><div id="root"></div></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    ],
    [
      'GET /api/cron/daily-close',
      jsonResponse(
        {
          error: {
            code: 'INVALID_INPUT',
            message: 'The request input is invalid',
            requestId: 'request-cron',
            retryable: false,
          },
        },
        { status: 401, headers: { 'cache-control': 'no-store' } },
      ),
    ],
  ]);
}

function createRouteFetch(
  routes: Map<string, Response>,
  requests: Array<{ url: URL; init: RequestInit }>,
): SmokeFetch {
  return async (input, init = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({ url, init });
    const response = routes.get(`${request.method} ${url.pathname}${url.search}`);

    if (response === undefined) {
      throw new Error(`Unexpected deployment-smoke request: ${request.method} ${url.pathname}`);
    }

    return response.clone();
  };
}

describe('deployment smoke', () => {
  it('validates health, API contracts and caches, SPA fallback, and unauthenticated Cron', async () => {
    const { runDeploymentSmoke } = await loadDeploymentSmoke();
    const requests: Array<{ url: URL; init: RequestInit }> = [];

    const result = await runDeploymentSmoke({
      baseUrl: 'https://stocks.example.com/',
      fetch: createRouteFetch(successfulRoutes(), requests),
    });

    expect(result.checks).toEqual([
      'health',
      'api-error',
      'api-cache',
      'spa-fallback',
      'cron-protection',
    ]);
    expect(requests.map(({ url }) => `${url.pathname}${url.search}`)).toEqual([
      '/api/health',
      '/api/stocks/search?q=',
      '/api/stocks/search?q=600519',
      '/deployment-smoke/spa-fallback',
      '/api/cron/daily-close',
    ]);
    const cronRequest = requests.at(-1);
    expect(cronRequest?.init.headers).toBeUndefined();
  });

  it.each(['', 'stocks.example.com', 'file:///tmp/tego'])(
    'requires an explicit HTTP base URL: %s',
    async (baseUrl) => {
      const { runDeploymentSmoke } = await loadDeploymentSmoke();
      let fetched = false;

      await expect(
        runDeploymentSmoke({
          baseUrl,
          fetch: async () => {
            fetched = true;
            throw new Error('Fetch must not run for an invalid base URL.');
          },
        }),
      ).rejects.toThrow('An explicit HTTP(S) deployment base URL is required.');
      expect(fetched).toBe(false);
    },
  );

  it.each([
    ['health status', 'GET /api/health', new Response('{}', { status: 503 })],
    [
      'health JSON content type',
      'GET /api/health',
      new Response('{}', { status: 200, headers: { 'content-type': 'text/plain' } }),
    ],
    [
      'API error shape',
      'GET /api/stocks/search?q=',
      jsonResponse({ error: { message: 'unsafe response' } }, { status: 400 }),
    ],
    [
      'API cache policy',
      'GET /api/stocks/search?q=600519',
      jsonResponse({ data: [] }, { status: 200, headers: { 'cache-control': 'no-store' } }),
    ],
    [
      'SPA fallback',
      'GET /deployment-smoke/spa-fallback',
      new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } }),
    ],
    [
      'Cron protection',
      'GET /api/cron/daily-close',
      jsonResponse({ error: { code: 'INVALID_INPUT' } }, { status: 200 }),
    ],
  ])('fails closed when the %s contract drifts', async (_case, route, invalidResponse) => {
    const { runDeploymentSmoke } = await loadDeploymentSmoke();
    const routes = successfulRoutes();
    routes.set(route, invalidResponse);

    await expect(
      runDeploymentSmoke({
        baseUrl: 'https://stocks.example.com',
        fetch: createRouteFetch(routes, []),
      }),
    ).rejects.toThrow(/^Deployment smoke failed: /);
  });

  it('does not include the base URL or response payloads in errors', async () => {
    const { runDeploymentSmoke } = await loadDeploymentSmoke();
    const sensitiveBaseUrl = 'https://environment-value.example.com';
    const sensitivePayload = 'environment-secret-value';
    const routes = successfulRoutes();
    routes.set(
      'GET /api/health',
      new Response(sensitivePayload, {
        status: 503,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    let failure = '';
    try {
      await runDeploymentSmoke({
        baseUrl: sensitiveBaseUrl,
        fetch: createRouteFetch(routes, []),
      });
    } catch (caught) {
      failure = String(caught);
    }

    expect(failure).toMatch(/^Error: Deployment smoke failed: /);
    expect(failure).not.toContain(sensitiveBaseUrl);
    expect(failure).not.toContain(sensitivePayload);
  });
});

describe('deployment evidence gates', () => {
  it('provides an explicit deployment-smoke command and complete local CI aggregate', async () => {
    const packageJson: unknown = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    if (!isRecord(packageJson) || !isRecord(packageJson.scripts)) {
      throw new TypeError('package.json scripts must be an object.');
    }

    expect(packageJson.scripts['smoke:deployment']).toBe('node scripts/deployment-smoke.mjs');
    expect(packageJson.scripts.ci).toBe(
      'npm run format:check && npm run lint && npm run typecheck && npm test && npm run build && npm run test:browser && npm run test:visual',
    );
  });

  it('keeps CI least-privilege and runs visual evidence on macOS 26 arm64', async () => {
    const workflow = await readFile(
      new URL('../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    );

    expect(workflow).toMatch(/permissions:\s*\n\s+contents: read/);
    expect(workflow).toMatch(/concurrency:[\s\S]*?cancel-in-progress: true/);
    expect(workflow).toContain('node-version: 24');
    expect(workflow).toContain('npm ci');
    expect(workflow).toContain('npx playwright install --with-deps chromium');
    expect(workflow).toMatch(/visual:[\s\S]*?runs-on: macos-26/);
    expect(workflow).toMatch(/visual:[\s\S]*?npx playwright install chromium/);
    expect(workflow).toMatch(/visual:[\s\S]*?npm run test:visual/);
    expect(workflow).toMatch(/Upload visual report on failure\s*\n\s+if: failure\(\)/);
    expect(workflow).not.toMatch(/\bsecrets\./);

    const actions = [...workflow.matchAll(/^\s*uses:\s*(\S+)\s*$/gm)].map((match) => match[1]);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
