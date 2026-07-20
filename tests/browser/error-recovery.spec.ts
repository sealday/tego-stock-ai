import { expect, test } from '@playwright/test';

import {
  FIXTURE_AI_KEY,
  MISSING_PE_REASON,
  MISSING_REVENUE_REASON,
  configureFixtureAi,
  installFixtureRoutes,
  waitForFixtureWorkspace,
  type FixtureProbe,
} from './fixtures';

test('keeps deterministic research usable without AI configuration', async ({ page }) => {
  const probe = await installFixtureRoutes(page);
  await page.goto('/');
  await waitForFixtureWorkspace(page);

  await expect(page.getByText('趋势评分')).toBeVisible();
  await page.getByRole('tab', { name: 'AI 报告' }).click();
  await expect(page.getByRole('button', { name: '生成 AI 报告' })).toBeDisabled();
  await expect(page.getByText(/请先填写有效的 Base URL、模型和 API key/)).toBeVisible();
  expect(probe.aiAttempts()).toBe(0);
  assertCleanBrowser(probe);
});

test('discloses stale cached data while keeping every deterministic view available', async ({
  page,
}) => {
  const probe = await installFixtureRoutes(page, { market: 'stale' });
  await page.goto('/');
  await waitForFixtureWorkspace(page);

  await expect(page.getByText('数据延迟', { exact: true })).toBeVisible();
  await expect(page.getByText(/市场快照最后成功更新.*2026-07-17 16:31:00/).first()).toBeVisible();
  for (const tab of ['概览', '技术分析', '基本面', '财务趋势'] as const) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
  }
  assertCleanBrowser(probe);
});

test('shows field-level reasons instead of fabricating missing financial metrics', async ({
  page,
}) => {
  const probe = await installFixtureRoutes(page, { market: 'missing-financials' });
  await page.goto('/');
  await waitForFixtureWorkspace(page);

  await expect(page.getByText(`缺失：${MISSING_PE_REASON}`)).toBeVisible();
  await page.getByRole('tab', { name: '基本面' }).click();
  await expect(page.getByText(`缺失：${MISSING_REVENUE_REASON}`)).toBeVisible();
  await expect(page.getByText('31.00')).toBeVisible();
  assertCleanBrowser(probe);
});

test('retries only the AI request after an invalid provider response', async ({ page }) => {
  const probe = await installFixtureRoutes(page, { ai: 'retry-once' });
  await page.goto('/');
  await waitForFixtureWorkspace(page);
  await configureFixtureAi(page);

  await page.getByRole('button', { name: '生成 AI 报告' }).click();
  await expect(page.getByText('AI 生成失败', { exact: true })).toBeVisible();
  await expect(page.getByText('AI 服务返回了无效的流式响应。')).toBeVisible();
  await page.getByRole('button', { name: '仅重试 AI 生成' }).click();
  await expect(page.getByText('报告已完成', { exact: true })).toBeVisible();

  expect(probe.aiAttempts()).toBe(2);
  expect(probe.apiRequestsWithAuthorization()).toEqual([]);
  assertCleanBrowser(probe);
});

test('persists an explicitly incomplete draft after an interrupted provider stream', async ({
  page,
}) => {
  const probe = await installFixtureRoutes(page, { ai: 'interrupted' });
  await page.goto('/');
  await waitForFixtureWorkspace(page);
  await configureFixtureAi(page);

  await page.getByRole('button', { name: '生成 AI 报告' }).click();
  await expect(page.getByText('未完成草稿 · 流式响应中断')).toBeVisible();
  await expect(page.getByText(/AI 响应流意外中断/)).toBeVisible();
  await expect(page.locator('.saved-reports__count')).toHaveText('1 份');
  await expect(page.getByRole('button', { name: '保存完整报告' })).toHaveCount(0);

  await page.reload();
  await waitForFixtureWorkspace(page);
  await page.getByRole('link', { name: '已保存 AI 报告' }).click();
  await expect(page.getByText('未完成草稿', { exact: true })).toBeVisible();
  await expect(page.getByText('贵州茅台 600519.SH')).toBeVisible();

  expect(probe.apiRequestsWithAuthorization()).toEqual([]);
  expect(probe.consoleMessages.join('\n')).not.toContain(FIXTURE_AI_KEY);
  assertCleanBrowser(probe);
});

function assertCleanBrowser(probe: FixtureProbe): void {
  expect(probe.consoleErrors).toEqual([]);
  expect(probe.pageErrors).toEqual([]);
}
