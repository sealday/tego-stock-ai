import { readFile } from 'node:fs/promises';

import { expect, type Page } from '@playwright/test';

import {
  FIXTURE_AI_KEY,
  FIXTURE_AI_MODEL,
  configureFixtureAi,
  test,
  waitForFixtureWorkspace,
} from './fixtures';

test('keeps credentials, reports, watchlist, export and deletion local to this browser', async ({
  page,
  installFixtureRoutes,
}) => {
  const probe = await installFixtureRoutes();
  await page.goto('/');
  await waitForFixtureWorkspace(page);

  const addWatchlist = page.getByRole('button', { name: '添加贵州茅台到本地自选股' });
  await expect(addWatchlist).toBeEnabled();
  await addWatchlist.click();
  await expect(page.getByText(/贵州茅台已保存到当前浏览器的本地自选股/).first()).toBeVisible();

  await configureFixtureAi(page, probe, true);
  await page.getByRole('button', { name: '生成 AI 报告' }).click();
  await expect(page.getByText('报告已完成', { exact: true })).toBeVisible();
  await assertKeyAbsentFromRenderedDocument(page);
  await page.getByRole('button', { name: '保存完整报告' }).click();
  await expect(page.locator('.saved-reports__count')).toHaveText('1 份');

  await page.getByRole('link', { name: '本地隐私' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出本地数据 JSON' }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const exported = await readFile(downloadPath ?? '', 'utf8');
  const exportedData: unknown = JSON.parse(exported);
  expect(exportedData).toMatchObject({
    schema: 'tego-stock-ai-local-export',
    version: 1,
    watchlist: [{ code: '600519.SH', name: '贵州茅台', pinyinAbbreviation: 'GZMT' }],
    settings: { model: FIXTURE_AI_MODEL, rememberApiKey: true },
    reports: [{ report: { status: 'complete' } }],
  });
  assertExportContainsNoCredential(exportedData);
  expect(exported).not.toContain(FIXTURE_AI_KEY);
  expect(exported).toContain(FIXTURE_AI_MODEL);
  expect(exported).toContain('600519.SH');
  expect(exported).toContain('"status": "complete"');
  await assertKeyAbsentFromRenderedDocument(page);

  await page.reload();
  await waitForFixtureWorkspace(page);
  await expect(page.getByRole('button', { name: '选择贵州茅台 600519.SH' })).toBeVisible();
  await page.getByRole('link', { name: 'AI 设置' }).click();
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue(FIXTURE_AI_KEY);
  await expect(page.getByLabel('在此设备上记住 API key')).toBeChecked();
  await expect(page.getByLabel('模型标识符')).toHaveValue(FIXTURE_AI_MODEL);
  await expect(page.locator('.saved-reports__count')).toHaveText('1 份');
  await assertKeyAbsentFromRenderedDocument(page);

  await page.getByRole('link', { name: '本地隐私' }).click();
  await page.getByRole('button', { name: '清除 AI 凭据' }).click();
  await expect(page.getByText(/AI 凭据已清除/)).toBeVisible();
  await page.reload();
  await waitForFixtureWorkspace(page);
  await page.getByRole('link', { name: 'AI 设置' }).click();
  await expect(page.getByLabel('模型标识符')).toHaveValue(FIXTURE_AI_MODEL);
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('在此设备上记住 API key')).not.toBeChecked();
  await expect(page.locator('.saved-reports__count')).toHaveText('1 份');

  await page.getByRole('link', { name: '本地隐私' }).click();
  await page.getByRole('button', { name: '清除全部本地数据' }).click();
  const dialog = page.getByRole('dialog', { name: '确认清除全部本地数据' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '确认清除全部数据' }).click();
  await expect(page.getByText('全部本地数据已清除。')).toBeVisible();
  await expect(page.locator('.saved-reports__count')).toHaveText('0 份');
  await expect(page.getByText('尚未添加本地自选股。').first()).toBeVisible();
  await expect(page.getByLabel('模型标识符')).toHaveValue('');

  await page.reload();
  await waitForFixtureWorkspace(page);
  await expect(page.getByText('尚未添加本地自选股。').first()).toBeVisible();
  await page.getByRole('link', { name: '已保存 AI 报告' }).click();
  await expect(page.locator('.saved-reports__count')).toHaveText('0 份');
  await expect(page.getByText('尚未保存本地 AI 报告。')).toBeVisible();

  await assertKeyAbsentFromRenderedDocument(page);
  expect(await probe.apiRequestsWithAuthorization()).toEqual([]);
  expect(probe.consoleMessages.join('\n')).not.toContain(FIXTURE_AI_KEY);
  expect(probe.consoleErrors).toEqual([]);
  expect(probe.pageErrors).toEqual([]);
});

async function assertKeyAbsentFromRenderedDocument(page: Page) {
  expect(await page.locator('body').innerText()).not.toContain(FIXTURE_AI_KEY);
  const html = await page.content();
  const passwordMarkup = await page
    .getByLabel('API key', { exact: true })
    .evaluate((input) => input.outerHTML);
  expect(html.replace(passwordMarkup, '<input id="ai-api-key" type="password">')).not.toContain(
    FIXTURE_AI_KEY,
  );
}

function assertExportContainsNoCredential(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertExportContainsNoCredential(item);
    }
    return;
  }
  if (typeof value !== 'object' || value === null) {
    if (typeof value === 'string') {
      expect(value).not.toContain(FIXTURE_AI_KEY);
    }
    return;
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    expect(key.toLowerCase()).not.toBe('apikey');
    expect(key.toLowerCase()).not.toContain('secret');
    assertExportContainsNoCredential(nestedValue);
  }
}
