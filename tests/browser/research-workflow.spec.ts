import { expect } from '@playwright/test';

import {
  FIXTURE_AI_KEY,
  FIXTURE_AI_MODEL,
  FIXTURE_CUTOFF,
  configureFixtureAi,
  test,
  waitForFixtureWorkspace,
} from './fixtures';

test('completes browser-only A-share research and reloads the saved report locally', async ({
  page,
  installFixtureRoutes,
}) => {
  const probe = await installFixtureRoutes();
  await page.goto('/');

  const search = page.getByRole('combobox', { name: '搜索 A 股' });
  await search.fill('600519');
  const result = page.getByRole('option', { name: /贵州茅台.*600519\.SH.*GZMT/ });
  await expect(result).toBeVisible();
  await result.click();
  await waitForFixtureWorkspace(page);
  expect(new URL(page.url()).origin).toBe(probe.previewOrigin);

  await expect(page.getByText('Tushare Pro', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(FIXTURE_CUTOFF, { exact: true }).first()).toBeVisible();
  const trendScoreCard = page.getByRole('heading', { name: '趋势评分', exact: true }).locator('..');
  await expect(trendScoreCard.getByText('100.0 / 100', { exact: true })).toBeVisible();
  await expect(trendScoreCard.getByText(`数据截止 ${FIXTURE_CUTOFF}`)).toBeVisible();
  const qualityScoreCard = page
    .getByRole('heading', { name: '财务质量', exact: true })
    .locator('..');
  await expect(qualityScoreCard.getByText('84.8 / 100', { exact: true })).toBeVisible();
  await expect(qualityScoreCard.getByText(`数据截止 ${FIXTURE_CUTOFF}`)).toBeVisible();
  const valuationScoreCard = page
    .getByRole('heading', { name: '估值位置', exact: true })
    .locator('..');
  await expect(valuationScoreCard.getByText('参考样本不足（0/4）', { exact: true })).toHaveCount(2);
  await expect(valuationScoreCard.getByText(`数据截止 ${FIXTURE_CUTOFF}`)).toBeVisible();
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

  await configureFixtureAi(page, probe);
  const corsStatus = await page.evaluate(async (endpoint) => {
    const response = await fetch(endpoint, { method: 'OPTIONS' });
    return response.status;
  }, probe.aiEndpoint);
  expect(corsStatus).toBe(204);
  await page.getByRole('button', { name: '生成 AI 报告' }).click();
  await expect(page.getByRole('status')).toHaveText('正在流式生成');
  await expect(page.getByText(/贵州茅台数据截止 2026-07-17/)).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('正在流式生成');
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

  expect(await probe.apiRequestsWithAuthorization()).toEqual([]);
  const aiRequests = probe.aiRequests();
  expect(aiRequests.some((request) => request.method === 'OPTIONS')).toBe(true);
  const postRequests = aiRequests.filter((request) => request.method === 'POST');
  expect(postRequests).toHaveLength(1);
  expect(postRequests[0]).toMatchObject({
    url: probe.aiEndpoint,
    authorization: `Bearer ${FIXTURE_AI_KEY}`,
  });
  expect(postRequests[0]?.postData).toContain(FIXTURE_AI_MODEL);
  expect(postRequests[0]?.postData).not.toContain(FIXTURE_AI_KEY);
  expect(probe.consoleMessages.join('\n')).not.toContain(FIXTURE_AI_KEY);
  expect(probe.consoleErrors).toEqual([]);
  expect(probe.pageErrors).toEqual([]);
});
