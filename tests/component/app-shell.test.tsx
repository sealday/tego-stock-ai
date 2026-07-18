import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { App } from '../../src/app/App';

describe('App', () => {
  it('identifies the daily-close research product and its safety boundary', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'A 股研究终端' })).toBeVisible();
    expect(screen.getByText('日线收盘数据')).toBeVisible();
    expect(screen.getByText(/不构成投资建议/)).toBeVisible();
  });
});
