import { expect, test } from '@playwright/test';

const responsiveCases = [
  { name: 'compact', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 1000 },
] as const;

for (const responsiveCase of responsiveCases) {
  test(`renders the research boundary without horizontal overflow at ${responsiveCase.name} width`, async ({
    page,
  }) => {
    await page.setViewportSize(responsiveCase);
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'A 股研究终端' })).toBeVisible();
    await expect(page.getByText(/不构成投资建议/)).toBeVisible();

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );

    expect(hasHorizontalOverflow).toBe(false);
  });
}
