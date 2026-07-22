import { defineConfig, devices } from '@playwright/test';

delete process.env.NO_COLOR;

const port = resolvePlaywrightPort();
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/browser',
  testIgnore: '**/visual.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  ...(process.env.CI ? { workers: 1 } : {}),
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
  },
});

function resolvePlaywrightPort(): number {
  const configured = process.env.PLAYWRIGHT_PORT;
  const candidate = configured === undefined ? 30_000 + (process.pid % 20_000) : Number(configured);
  if (!Number.isInteger(candidate) || candidate < 1024 || candidate > 65_535) {
    throw new Error(
      `PLAYWRIGHT_PORT must be an integer from 1024 through 65535; received ${configured}`,
    );
  }
  process.env.PLAYWRIGHT_PORT = String(candidate);
  return candidate;
}
