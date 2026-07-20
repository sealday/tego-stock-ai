import { defineConfig } from '@playwright/test';

delete process.env.NO_COLOR;

export default defineConfig({
  testDir: './tests/browser',
  testMatch: 'visual.spec.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/visual' }]],
  outputDir: 'test-results/visual',
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{projectName}/{arg}{ext}',
  metadata: {
    visualReferencePlatform: 'darwin-arm64 / Playwright 1.61.1 bundled Chromium',
  },
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.02,
      scale: 'css',
    },
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
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
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
});
