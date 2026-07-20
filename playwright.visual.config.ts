import { defineConfig } from '@playwright/test';

delete process.env.NO_COLOR;

const visualReferencePlatform = 'darwin-arm64';
const visualReferenceRunner = 'github-macos-26-arm64';
const localSnapshotLane = 'local-darwin-arm64';
const currentPlatform = `${process.platform}-${process.arch}`;
if (currentPlatform !== visualReferencePlatform) {
  throw new Error(
    `Visual baselines require ${visualReferencePlatform}; received ${currentPlatform}. ` +
      'Run browser smoke tests here and move visual comparison to the configured baseline runner.',
  );
}
const configuredReferenceRunner = process.env.VISUAL_REFERENCE_RUNNER;
if (process.env.CI && configuredReferenceRunner !== visualReferenceRunner) {
  throw new Error(
    `Visual CI requires VISUAL_REFERENCE_RUNNER=${visualReferenceRunner}; received ${configuredReferenceRunner ?? 'unset'}.`,
  );
}
const snapshotLane =
  configuredReferenceRunner === visualReferenceRunner ? visualReferenceRunner : localSnapshotLane;
const port = resolvePlaywrightPort();
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/browser',
  testMatch: 'visual.spec.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/visual' }]],
  outputDir: 'test-results/visual',
  snapshotPathTemplate: `{testDir}/{testFilePath}-snapshots/${snapshotLane}/{projectName}/{arg}{ext}`,
  metadata: {
    visualReferencePlatform: `${visualReferenceRunner} (${visualReferencePlatform}) / Playwright 1.61.1 bundled Chromium`,
    visualSnapshotLane: snapshotLane,
  },
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.001,
      scale: 'css',
    },
  },
  use: {
    baseURL,
    colorScheme: 'dark',
    contextOptions: { reducedMotion: 'reduce' },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      grep: /@desktop/,
      use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'compact-chromium',
      grep: /@compact/,
      use: { browserName: 'chromium', viewport: { width: 390, height: 844 } },
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
