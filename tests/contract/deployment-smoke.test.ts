import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

type SmokeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type RouteFixture = Response | readonly Response[];
type RouteFixtures = Map<string, RouteFixture>;

interface DeploymentSmokeModule {
  runDeploymentSmoke(options: {
    baseUrl: string;
    fetch?: SmokeFetch;
  }): Promise<{ checks: readonly string[] }>;
}

interface RecordedRequest {
  headers: Headers;
  method: string;
  redirect: RequestRedirect;
  signal: AbortSignal;
  url: URL;
}

const moduleUrl = new URL('../../scripts/deployment-smoke.mjs', import.meta.url).href;
const scriptPath = fileURLToPath(new URL('../../scripts/deployment-smoke.mjs', import.meta.url));

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

function stockResponse(
  vercelCache: string,
  cacheControl = 'public, max-age=300, stale-while-revalidate=604800',
  data: unknown = [{ code: '600519.SH', name: '贵州茅台', pinyinAbbreviation: 'GZMT' }],
): Response {
  return jsonResponse(
    {
      data,
      asOf: '2026-07-18',
      source: 'Tushare Pro',
      freshness: 'fresh',
      availability: {},
      limitations: ['Daily-close data only'],
    },
    {
      status: 200,
      headers: {
        'cache-control': cacheControl,
        'x-vercel-cache': vercelCache,
      },
    },
  );
}

function successfulRoutes(): RouteFixtures {
  return new Map<string, RouteFixture>([
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
    ['GET /api/stocks/search?q=600519', [stockResponse('MISS'), stockResponse('HIT')]],
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

function createRouteFetch(routes: RouteFixtures, requests: RecordedRequest[]): SmokeFetch {
  const calls = new Map<string, number>();
  return async (input, init = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({
      headers: new Headers(request.headers),
      method: request.method,
      redirect: request.redirect,
      signal: request.signal,
      url,
    });
    const key = routeKey(request.method, url);
    const response = takeRouteResponse(routes, calls, key);

    if (response === undefined) {
      throw new Error(`Unexpected deployment-smoke request: ${request.method} ${url.pathname}`);
    }

    return response.clone();
  };
}

function takeRouteResponse(
  routes: RouteFixtures,
  calls: Map<string, number>,
  key: string,
): Response | undefined {
  const fixture = routes.get(key);
  if (fixture === undefined || fixture instanceof Response) {
    return fixture;
  }
  const index = calls.get(key) ?? 0;
  calls.set(key, index + 1);
  return fixture[index];
}

function routeKey(method: string, url: URL): string {
  return url.pathname === '/api/stocks/search' && url.searchParams.get('q') === '600519'
    ? `${method} ${url.pathname}?q=600519`
    : `${method} ${url.pathname}${url.search}`;
}

async function withDeploymentServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const routes = successfulRoutes();
  const calls = new Map<string, number>();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const fixture = takeRouteResponse(routes, calls, routeKey(request.method ?? 'GET', url));
      if (fixture === undefined) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('fixture missing');
        return;
      }

      response.statusCode = fixture.status;
      fixture.headers.forEach((value, name) => response.setHeader(name, value));
      response.end(Buffer.from(await fixture.arrayBuffer()));
    } catch {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('fixture failed');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new TypeError('Deployment smoke fixture did not bind a TCP port.');
  }

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
}

function runCli(arguments_: readonly string[], sentinel: string) {
  return new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...arguments_], {
      env: { ...process.env, DEPLOYMENT_SMOKE_SENTINEL: sentinel },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr, stdout }));
  });
}

describe('deployment smoke', () => {
  it('validates health, API contracts and caches, SPA fallback, and unauthenticated Cron', async () => {
    const { runDeploymentSmoke } = await loadDeploymentSmoke();
    const requests: RecordedRequest[] = [];

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
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      '/api/health',
      '/api/stocks/search',
      '/api/stocks/search',
      '/api/stocks/search',
      '/deployment-smoke/spa-fallback',
      '/api/cron/daily-close',
    ]);
    expect(requests.every(({ redirect }) => redirect === 'error')).toBe(true);
    const firstStockProbe = requests[2];
    const secondStockProbe = requests[3];
    expect(firstStockProbe?.url.searchParams.get('q')).toBe('600519');
    expect(firstStockProbe?.url.searchParams.get('deployment-smoke')).toMatch(/^[0-9a-f-]{36}$/);
    expect(firstStockProbe?.url.href).toBe(secondStockProbe?.url.href);
    expect(firstStockProbe?.headers.get('pragma')).toBe('no-cache');
    expect(secondStockProbe?.headers.get('pragma')).toBeNull();
    const cronRequest = requests.at(-1);
    expect(cronRequest?.headers.get('authorization')).toBeNull();
  });

  it('requires a configured provider and complete current-deployment stock envelope', async () => {
    const { runDeploymentSmoke } = await loadDeploymentSmoke();
    const routes = successfulRoutes();
    routes.set(
      'GET /api/health',
      jsonResponse(
        {
          data: { status: 'ok', providerConfigured: false },
          asOf: '2026-07-20',
          source: 'Tushare Pro',
          freshness: 'fresh',
          availability: {},
          limitations: [],
        },
        { status: 200, headers: { 'cache-control': 'no-store' } },
      ),
    );

    await expect(
      runDeploymentSmoke({
        baseUrl: 'https://stocks.example.com',
        fetch: createRouteFetch(routes, []),
      }),
    ).rejects.toThrow(
      'Deployment smoke failed: health endpoint reports provider is not configured.',
    );
  });

  it.each([
    [
      'private',
      'private, max-age=300',
      'MISS',
      'cache probe did not return a safe positive public cache policy',
    ],
    [
      'no-store',
      'public, no-store, max-age=300',
      'MISS',
      'cache probe did not return a safe positive public cache policy',
    ],
    [
      'no-cache',
      'public, no-cache, max-age=300',
      'MISS',
      'cache probe did not return a safe positive public cache policy',
    ],
    [
      'zero max-age',
      'public, max-age=0',
      'MISS',
      'cache probe did not return a safe positive public cache policy',
    ],
    [
      'invalid max-age',
      'public, max-age=invalid',
      'MISS',
      'cache probe did not return a safe positive public cache policy',
    ],
    [
      'valued public directive',
      'public=shared, max-age=300',
      'MISS',
      'cache probe did not return a safe positive public cache policy',
    ],
    [
      'zero visible s-maxage',
      'public, max-age=300, s-maxage=0',
      'MISS',
      'cache probe did not return a safe positive public cache policy',
    ],
    [
      'noninteger visible s-maxage',
      'public, max-age=300, s-maxage=invalid',
      'MISS',
      'cache probe did not return a safe positive public cache policy',
    ],
    [
      'missing Vercel status',
      'public, max-age=300',
      null,
      'cache probe did not confirm the current Vercel deployment',
    ],
    [
      'stale Vercel hit',
      'public, max-age=300',
      'HIT',
      'cache probe did not confirm the current Vercel deployment',
    ],
  ])(
    'rejects a non-current or unsafe wire cache policy: %s',
    async (_case, cacheControl, status, expectedFailure) => {
      const { runDeploymentSmoke } = await loadDeploymentSmoke();
      const routes = successfulRoutes();
      const headers = new Headers({ 'cache-control': cacheControl });
      if (status !== null) {
        headers.set('x-vercel-cache', status);
      }
      routes.set(
        'GET /api/stocks/search?q=600519',
        jsonResponse(
          {
            data: [{ code: '600519.SH' }],
            asOf: '2026-07-18',
            source: 'Tushare Pro',
            freshness: 'fresh',
            availability: {},
            limitations: [],
          },
          { status: 200, headers },
        ),
      );

      await expect(
        runDeploymentSmoke({
          baseUrl: 'https://stocks.example.com',
          fetch: createRouteFetch(routes, []),
        }),
      ).rejects.toThrow(`Deployment smoke failed: ${expectedFailure}.`);
    },
  );

  it('requires the second identical stock probe to be a shared-cache HIT', async () => {
    const { runDeploymentSmoke } = await loadDeploymentSmoke();
    const routes = successfulRoutes();
    routes.set('GET /api/stocks/search?q=600519', [stockResponse('MISS'), stockResponse('MISS')]);

    await expect(
      runDeploymentSmoke({
        baseUrl: 'https://stocks.example.com',
        fetch: createRouteFetch(routes, []),
      }),
    ).rejects.toThrow(
      'Deployment smoke failed: repeat cache probe did not return a shared Vercel HIT.',
    );
  });

  it('validates the target stock in the shared-cache HIT body', async () => {
    const { runDeploymentSmoke } = await loadDeploymentSmoke();
    const routes = successfulRoutes();
    routes.set('GET /api/stocks/search?q=600519', [
      stockResponse('REVALIDATED'),
      stockResponse('HIT', 'public, max-age=300', [{ code: '000001.SZ' }]),
    ]);

    await expect(
      runDeploymentSmoke({
        baseUrl: 'https://stocks.example.com',
        fetch: createRouteFetch(routes, []),
      }),
    ).rejects.toThrow('Deployment smoke failed: repeat cache probe did not include 600519.SH.');
  });

  it.each([
    [
      'metadata',
      {
        data: [{ code: '600519.SH' }],
        asOf: 'not-a-date',
        source: 'unexpected',
        freshness: 'fresh',
        availability: {},
        limitations: [],
      },
      'cache probe returned invalid market envelope metadata',
    ],
    [
      'target stock',
      {
        data: [{ code: '000001.SZ' }],
        asOf: '2026-07-18',
        source: 'Tushare Pro',
        freshness: 'fresh',
        availability: {},
        limitations: [],
      },
      'cache probe did not include 600519.SH',
    ],
  ])('rejects incomplete current-deployment %s evidence', async (_case, body, expectedFailure) => {
    const { runDeploymentSmoke } = await loadDeploymentSmoke();
    const routes = successfulRoutes();
    routes.set(
      'GET /api/stocks/search?q=600519',
      jsonResponse(body, {
        status: 200,
        headers: {
          'cache-control': 'public, max-age=300',
          'x-vercel-cache': 'REVALIDATED',
        },
      }),
    );

    await expect(
      runDeploymentSmoke({
        baseUrl: 'https://stocks.example.com',
        fetch: createRouteFetch(routes, []),
      }),
    ).rejects.toThrow(`Deployment smoke failed: ${expectedFailure}.`);
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
      'API cache policy',
      'GET /api/stocks/search?q=600519',
      jsonResponse({ data: [] }, { status: 200, headers: { 'cache-control': 'no-store' } }),
    ],
    [
      'SPA fallback',
      'GET /deployment-smoke/spa-fallback',
      new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } }),
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

  it('isolates typed API error-shape drift after status and cache validation', async () => {
    const { runDeploymentSmoke } = await loadDeploymentSmoke();
    const routes = successfulRoutes();
    routes.set(
      'GET /api/stocks/search?q=',
      jsonResponse(
        { error: { code: 'INVALID_INPUT', message: 'safe but incomplete' } },
        { status: 400, headers: { 'cache-control': 'no-store' } },
      ),
    );

    await expect(
      runDeploymentSmoke({
        baseUrl: 'https://stocks.example.com',
        fetch: createRouteFetch(routes, []),
      }),
    ).rejects.toThrow(
      'Deployment smoke failed: invalid API request returned an unexpected error shape.',
    );
  });

  it('isolates typed Cron error-shape drift after status and cache validation', async () => {
    const { runDeploymentSmoke } = await loadDeploymentSmoke();
    const routes = successfulRoutes();
    routes.set(
      'GET /api/cron/daily-close',
      jsonResponse(
        { error: { code: 'INVALID_INPUT', message: 'safe but incomplete' } },
        { status: 401, headers: { 'cache-control': 'no-store' } },
      ),
    );

    await expect(
      runDeploymentSmoke({
        baseUrl: 'https://stocks.example.com',
        fetch: createRouteFetch(routes, []),
      }),
    ).rejects.toThrow(
      'Deployment smoke failed: unauthenticated Cron request returned an unexpected error shape.',
    );
  });

  it('turns redirect failures into generic errors without leaking the URL or response', async () => {
    const { runDeploymentSmoke } = await loadDeploymentSmoke();
    const sensitiveUrl = 'https://current-deployment.example.com/private-value';
    const sensitivePayload = 'redirected-sensitive-response';
    let redirect: RequestRedirect | undefined;

    let failure = '';
    try {
      await runDeploymentSmoke({
        baseUrl: sensitiveUrl,
        fetch: async (_input, init) => {
          redirect = init?.redirect;
          throw new TypeError(`redirected to ${sensitiveUrl}: ${sensitivePayload}`);
        },
      });
    } catch (caught) {
      failure = String(caught);
    }

    expect(redirect).toBe('error');
    expect(failure).toBe(
      'Error: Deployment smoke failed: a deployment request could not be completed.',
    );
    expect(failure).not.toContain(sensitiveUrl);
    expect(failure).not.toContain(sensitivePayload);
  });

  it('aborts a stalled request after the fixed timeout with a generic error', async () => {
    vi.useFakeTimers();
    const { runDeploymentSmoke } = await loadDeploymentSmoke();
    let signal: AbortSignal | undefined;
    const execution = runDeploymentSmoke({
      baseUrl: 'https://timeout-value.example.com',
      fetch: async (_input, init) => {
        signal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
        });
      },
    });
    const outcome = execution.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );

    try {
      await Promise.resolve();
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(String((await outcome).error)).toBe(
        'Error: Deployment smoke failed: a deployment request could not be completed.',
      );
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the fixed timeout active while reading a stalled response body', async () => {
    vi.useFakeTimers();
    const { runDeploymentSmoke } = await loadDeploymentSmoke();
    let signal: AbortSignal | undefined;
    const execution = runDeploymentSmoke({
      baseUrl: 'https://slow-body.example.com',
      fetch: async (_input, init) => {
        signal = init?.signal ?? undefined;
        return new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener('abort', () => controller.error(signal?.reason), {
                once: true,
              });
            },
          }),
          {
            status: 200,
            headers: {
              'cache-control': 'no-store',
              'content-type': 'application/json',
            },
          },
        );
      },
    });
    const outcome = execution.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );

    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(signal?.aborted).toBe(true);
      expect(String((await outcome).error)).toBe(
        'Error: Deployment smoke failed: a deployment request could not be completed.',
      );
    } finally {
      vi.useRealTimers();
    }
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

describe('deployment smoke CLI', () => {
  it('reports only a generic success summary from a real child process', async () => {
    const sentinel = 'environment-secret-child-value';

    await withDeploymentServer(async (baseUrl) => {
      const result = await runCli([baseUrl], sentinel);

      expect(result).toEqual({
        code: 0,
        stderr: '',
        stdout: 'Deployment smoke passed 5 checks.\n',
      });
      expect(`${result.stdout}${result.stderr}`).not.toContain(baseUrl);
      expect(`${result.stdout}${result.stderr}`).not.toContain(sentinel);
    });
  });

  it.each([
    ['missing URL', [], 'environment-secret-missing'],
    [
      'sensitive URL argument',
      ['https://environment-user:argv-secret-value@stocks.example.com/private'],
      'environment-secret-invalid',
    ],
  ])(
    'fails safely for %s without echoing arguments or environment',
    async (_case, args, sentinel) => {
      const result = await runCli(args, sentinel);

      expect(result).toEqual({
        code: 1,
        stderr: 'An explicit HTTP(S) deployment base URL is required.\n',
        stdout: '',
      });
      expect(`${result.stdout}${result.stderr}`).not.toContain(sentinel);
      for (const argument of args) {
        expect(`${result.stdout}${result.stderr}`).not.toContain(argument);
        expect(`${result.stdout}${result.stderr}`).not.toContain('argv-secret-value');
      }
    },
  );
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
    expect(packageJson.scripts['ci:portable']).toBe(
      'npm run format:check && npm run lint && npm run typecheck && npm test && npm run build && npm run test:browser',
    );
    expect(packageJson.scripts.ci).toBe('npm run ci:portable && npm run test:visual');
  });

  it('locks each least-privilege CI job to its own evidence gates', async () => {
    const workflow = await readFile(
      new URL('../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    );
    const jobs = workflowJobs(workflow);
    expect([...jobs.keys()]).toEqual([
      'introduced-commit-policy',
      'quality',
      'vitest',
      'playwright',
      'visual',
    ]);
    const introduced = requiredJob(jobs, 'introduced-commit-policy');
    const quality = requiredJob(jobs, 'quality');
    const vitest = requiredJob(jobs, 'vitest');
    const browser = requiredJob(jobs, 'playwright');
    const visual = requiredJob(jobs, 'visual');

    expect(workflow).toMatch(/permissions:\s*\n\s+contents: read/);
    expect(workflow).toMatch(/concurrency:[\s\S]*?cancel-in-progress: true/);
    expect(workflow).toContain('pull_request:');
    expect(workflow).not.toContain('pull_request_target:');
    expect(hasSecretReference(workflow)).toBe(false);
    expect(workflow).not.toMatch(/^\s+environment:/m);
    expect(workflow.match(/^[ \t]*permissions:/gm)).toEqual(['permissions:']);

    for (const job of [introduced, quality, vitest, browser, visual]) {
      expect(job).toContain('actions/checkout@');
      expect(job).toContain('actions/setup-node@');
      expect(job).toContain('node-version: 24');
      expect(job).toContain('run: npm ci');
      expect(job).not.toContain('permissions:');
      expect(job).not.toContain('environment:');
      expect(hasSecretReference(job)).toBe(false);
    }

    expect(introduced).toContain('fetch-depth: 0');
    expect(introduced).toContain('node scripts/resolve-commit-range.mjs');
    expect(introduced).toContain('commitlint --from');
    expect(quality).toContain('npm run format:check');
    expect(quality).toContain('npm run lint');
    expect(quality).toContain('npm run typecheck');
    expect(quality).toContain('npm run build');
    expect(vitest).toContain('npm run test:unit');
    expect(browser).toContain('npx playwright install --with-deps chromium');
    expect(browser).toContain('npm run test:browser');
    expect(browser).toMatch(/Upload Playwright report on failure\s*\n\s+if: failure\(\)/);
    expect(visual).toContain('runs-on: macos-26');
    expect(visual).toContain('npx playwright install chromium');
    expect(visual).toContain('npm run test:visual');
    expect(visual).toMatch(/Upload visual report on failure\s*\n\s+if: failure\(\)/);
    expect(visual).toContain('playwright-report/visual/');
    expect(visual).toContain('test-results/visual/');

    const actions = [...workflow.matchAll(/^\s*uses:\s*(\S+)\s*$/gm)].map((match) => match[1]);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('keeps legal underscore job IDs outside the preceding job block', () => {
    const jobs = workflowJobs(`
jobs:
  quality:
    steps:
      - run: npm run lint
  build_extra:
    steps:
      - run: npm run build
`);

    expect([...jobs.keys()]).toEqual(['quality', 'build_extra']);
    expect(requiredJob(jobs, 'quality')).not.toContain('npm run build');
    expect(requiredJob(jobs, 'build_extra')).toContain('npm run build');
  });

  it.each(['${{ secrets.NAME }}', "${{ secrets['NAME'] }}", '${{ SeCrEtS [ "NAME" ] }}'])(
    'detects forbidden CI secret reference syntax: %s',
    (source) => {
      expect(hasSecretReference(source)).toBe(true);
    },
  );
});

function workflowJobs(workflow: string): Map<string, string> {
  const jobsMarker = '\njobs:\n';
  const jobsStart = workflow.indexOf(jobsMarker);
  if (jobsStart < 0) {
    throw new Error('CI workflow is missing jobs.');
  }
  const jobsSource = workflow.slice(jobsStart + jobsMarker.length);
  const matches = [...jobsSource.matchAll(/^  ([A-Za-z_][A-Za-z0-9_-]*):\n/gm)];
  const jobs = new Map<string, string>();
  for (const [index, match] of matches.entries()) {
    const name = match[1];
    const start = match.index;
    const end = matches[index + 1]?.index ?? jobsSource.length;
    if (name !== undefined && start !== undefined) {
      jobs.set(name, jobsSource.slice(start, end));
    }
  }
  return jobs;
}

function requiredJob(jobs: Map<string, string>, name: string): string {
  const job = jobs.get(name);
  if (job === undefined) {
    throw new Error(`CI workflow is missing job ${name}.`);
  }
  return job;
}

function hasSecretReference(source: string): boolean {
  return /\bsecrets\s*(?:\.|\[\s*['"])/i.test(source);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
