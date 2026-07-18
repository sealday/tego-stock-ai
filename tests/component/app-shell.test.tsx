import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/app/App';

describe('App', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('identifies the daily-close research product and its safety boundary', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    render(<App />);

    expect(screen.getByRole('heading', { name: 'A 股研究终端' })).toBeVisible();
    expect(screen.getByText('市场状态加载中')).toBeVisible();
    expect(screen.getByText(/日线收盘研究/)).toBeVisible();
    expect(screen.getByText(/不构成投资建议/)).toBeVisible();
    expect(screen.getByRole('combobox', { name: '搜索 A 股' })).toBeVisible();
    expect(screen.getByRole('tab', { name: '概览' })).toBeVisible();
    expect(screen.getAllByText('市场分析').length).toBeGreaterThan(0);
  });
});
