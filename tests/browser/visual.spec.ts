import { expect, test } from '@playwright/test';

import { installFixtureRoutes, waitForFixtureWorkspace } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-07-20T08:00:00+08:00'));
  await installFixtureRoutes(page);
  await page.goto('/');
  await waitForFixtureWorkspace(page);
  await page.addStyleTag({
    content: `
      :root {
        --font-sans: Arial, sans-serif;
        --font-mono: "Courier New", monospace;
      }
      *, *::before, *::after {
        animation: none !important;
        caret-color: transparent !important;
        scroll-behavior: auto !important;
        transition: none !important;
      }
    `,
  });
  await page.locator('.price-chart__canvas canvas').first().waitFor();
  await page.evaluate(async () => document.fonts.ready);
});

test('@desktop locks the 1440x1000 terminal overview', async ({ page }) => {
  expect(page.viewportSize()).toEqual({ width: 1440, height: 1000 });
  await expect(page).toHaveScreenshot('overview.png');
});

test('@compact locks the 390x844 navigation and workspace', async ({ page }) => {
  expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
  await page.locator('details.compact-navigation').evaluate((details) => {
    (details as HTMLDetailsElement).open = true;
  });
  await expect(page.getByRole('link', { name: '市场分析' })).toBeVisible();
  await expect(page).toHaveScreenshot('navigation-workspace.png');
});
