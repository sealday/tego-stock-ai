import { expect, test } from '@playwright/test';

import {
  FIXTURE_AI_ENDPOINT,
  FIXTURE_AI_KEY,
  FIXTURE_CUTOFF,
  configureFixtureAi,
  installFixtureRoutes,
  waitForFixtureWorkspace,
} from './fixtures';

test('completes browser-only A-share research and reloads the saved report locally', async ({
  page,
}) => {
  const probe = await installFixtureRoutes(page);
  await page.goto('/');

  const search = page.getByRole('combobox', { name: '搜索 A 股' });
  await search.fill('600519');
  const result = page.getByRole('option', { name: /贵州茅台.*600519\.SH.*GZMT/ });
  await expect(result).toBeVisible();
  await result.click();
  await waitForFixtureWorkspace(page);

  await expect(page.getByText('Tushare Pro', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(FIXTURE_CUTOFF, { exact: true }).first()).toBeVisible();
  await expect(page.getByText('趋势评分')).toBeVisible();
  await expect(page.getByText('1,430.2').first()).toBeVisible();

  const viewHeadings = [
    ['概览', '市场结构概览'],
    ['技术分析', '价格与成交量'],
    ['基本面', '基本面与财务质量'],
    ['财务趋势', '财务趋势'],
  ] as const;
  for (const [tab, heading] of viewHeadings) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }

  await configureFixtureAi(page);
  await page.getByRole('button', { name: '生成 AI 报告' }).click();
  await expect(page.getByText('报告已完成', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '数据来源与限制', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保存完整报告' }).click();
  await expect(page.getByText(/完整报告已交给本地保存回调/)).toBeVisible();
  await expect(page.locator('.saved-reports__count')).toHaveText('1 份');

  await page.reload();
  await waitForFixtureWorkspace(page);
  await page.getByRole('link', { name: '已保存 AI 报告' }).click();
  await expect(page.getByRole('heading', { name: '已保存 AI 报告' })).toBeVisible();
  await expect(page.getByText('完整报告', { exact: true })).toBeVisible();
  await expect(page.getByText('贵州茅台 600519.SH')).toBeVisible();
  await page.getByText('查看报告内容').click();
  await expect(page.getByText(/来源为 Tushare Pro 日线收盘数据/)).toBeVisible();

  expect(probe.apiRequestsWithAuthorization()).toEqual([]);
  const secretRequests = probe.requestsContaining(FIXTURE_AI_KEY);
  expect(secretRequests).toHaveLength(1);
  expect(secretRequests[0]?.url).toBe(FIXTURE_AI_ENDPOINT);
  expect(probe.consoleMessages.join('\n')).not.toContain(FIXTURE_AI_KEY);
  expect(probe.consoleErrors).toEqual([]);
  expect(probe.pageErrors).toEqual([]);
});
