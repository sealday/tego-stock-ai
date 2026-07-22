import { describe, expect, it } from 'vitest';

import { isoDate, stockCode } from '../../src/domain/stock';

describe('stock domain constructors', () => {
  it.each(['000001.SZ', '600519.SH', '430047.BJ'])('accepts canonical A-share code %s', (code) => {
    expect(stockCode(code)).toBe(code);
  });

  it.each(['600519.SZ', '000001.SH', '600519.sh', ' 600519.SH ', '600519.SH?token=x'])(
    'rejects non-canonical or unsafe stock code %s',
    (code) => {
      expect(() => stockCode(code)).toThrow('Invalid A-share stock code');
    },
  );

  it('accepts a real ISO calendar date', () => {
    expect(isoDate('2026-07-17')).toBe('2026-07-17');
  });

  it.each(['20260717', '2026-02-30', '2026-07-17?token=x', '1899-12-31', '2101-01-01'])(
    'rejects malformed, impossible, or unsafe date %s',
    (date) => {
      expect(() => isoDate(date)).toThrow('Invalid ISO date');
    },
  );
});
