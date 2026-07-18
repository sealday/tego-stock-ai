import { describe, expect, it } from 'vitest';

import constantSeries from '../fixtures/analysis/constant-series.json';
import risingSeries from '../fixtures/analysis/rising-series.json';
import {
  bollingerBands,
  calculateTechnicalIndicators,
  classifyVolumeRatio,
  drawdown,
  exponentialMovingAverage,
  macd,
  realizedVolatility,
  relativeStrengthIndex,
  simpleMovingAverage,
  volumeRatio,
} from '../../src/analysis/indicators';

function last<T>(values: readonly T[]): T {
  const value = values.at(-1);
  if (value === undefined) {
    throw new Error('Expected a non-empty series');
  }
  return value;
}

function expectNullPrefix(values: readonly (number | null)[], length: number): void {
  expect(values.slice(0, length)).toEqual(Array.from({ length }, () => null));
}

describe('indicator engine', () => {
  it('matches every locked expectation for a constant 80-day fixture', () => {
    const indicators = calculateTechnicalIndicators(constantSeries);

    expect(last(indicators.sma5)).toBe(100);
    expect(last(indicators.sma20)).toBe(100);
    expect(last(indicators.sma60)).toBe(100);
    expect(last(indicators.ema12)).toBe(100);
    expect(last(indicators.ema26)).toBe(100);
    expect(last(indicators.macd.line)).toBe(0);
    expect(last(indicators.macd.signal)).toBe(0);
    expect(last(indicators.macd.histogram)).toBe(0);
    expect(last(indicators.rsi14)).toBe(50);
    expect(last(indicators.bollinger20.mean)).toBe(100);
    expect(last(indicators.bollinger20.upper)).toBe(100);
    expect(last(indicators.bollinger20.lower)).toBe(100);
    expect(last(indicators.volumeRatio20.values)).toBe(1);
    expect(last(indicators.volumeRatio20.bands)).toBe('normal');
    expect(last(indicators.realizedVolatility20)).toBe(0);
    expect(last(indicators.drawdown.values)).toBe(0);
    expect(indicators.drawdown.maximum).toBe(0);
  });

  it('matches locked moving-average and drawdown expectations for a rising fixture', () => {
    const indicators = calculateTechnicalIndicators(risingSeries);

    expect(last(indicators.sma5)).toBe(78);
    expect(last(indicators.sma20)).toBe(70.5);
    expect(last(indicators.sma60)).toBe(50.5);
    expect(last(indicators.drawdown.values)).toBe(0);
    expect(indicators.drawdown.maximum).toBe(0);
  });

  it('seeds EMA with the first SMA and emits null during warm-up', () => {
    const result = exponentialMovingAverage([1, 2, 3, 4, 5], 3);

    expect(result).toEqual([null, null, 2, 3, 4]);
  });

  it('emits null through the locked warm-up boundaries', () => {
    const closes = risingSeries.closes;

    expectNullPrefix(simpleMovingAverage(closes, 20), 19);
    expect(simpleMovingAverage(closes, 20)[19]).toBe(10.5);
    expectNullPrefix(relativeStrengthIndex(closes, 14), 14);
    expect(relativeStrengthIndex(closes, 14)[14]).toBe(100);
    expectNullPrefix(bollingerBands(closes, 20).mean, 19);
    expectNullPrefix(realizedVolatility(closes, 20), 20);
    expect(realizedVolatility(closes, 20)[20]).not.toBeNull();
    expectNullPrefix(macd(closes).line, 25);
    expectNullPrefix(macd(closes).signal, 33);
    expectNullPrefix(macd(closes).histogram, 33);
  });

  it('uses population deviation for Bollinger bands and sample deviation for volatility', () => {
    const bands = bollingerBands([1, 2, 3, 4], 4, 2);
    const volatility = realizedVolatility([100, 110, 99], 2);
    const firstReturn = Math.log(110 / 100);
    const secondReturn = Math.log(99 / 110);
    const sampleStandardDeviation = Math.abs(firstReturn - secondReturn) / Math.sqrt(2);

    expect(last(bands.mean)).toBe(2.5);
    expect(last(bands.upper)).toBeCloseTo(2.5 + 2 * Math.sqrt(1.25), 10);
    expect(last(bands.lower)).toBeCloseTo(2.5 - 2 * Math.sqrt(1.25), 10);
    expect(last(volatility)).toBeCloseTo(sampleStandardDeviation * Math.sqrt(252), 10);
  });

  it('applies Wilder RSI flat and loss-free branches', () => {
    expect(
      last(
        relativeStrengthIndex(
          Array.from({ length: 20 }, () => 100),
          14,
        ),
      ),
    ).toBe(50);
    expect(
      last(
        relativeStrengthIndex(
          Array.from({ length: 20 }, (_, index) => index + 1),
          14,
        ),
      ),
    ).toBe(100);
  });

  it('locks seeded MACD and Wilder RSI against a non-linear close sequence', () => {
    const closes = [
      100, 102, 101, 105, 103, 107, 106, 108, 104, 109, 111, 110, 115, 113, 117, 116, 118, 121, 119,
      123, 122, 126, 124, 128, 127, 130, 129, 133, 131, 135, 134, 138, 136, 140, 139,
    ];

    const macdResult = macd(closes);
    const rsiResult = relativeStrengthIndex(closes, 14);

    expect(macdResult.signal[33]).toBeCloseTo(8.475193159231099, 10);
    expect(macdResult.histogram[33]).toBeCloseTo(0.04064353401598275, 10);
    expect(macdResult.signal[34]).toBeCloseTo(8.46553484047331, 10);
    expect(macdResult.histogram[34]).toBeCloseTo(-0.03863327503115954, 10);
    expect(rsiResult[14]).toBeCloseTo(71.7948717948718, 10);
    expect(rsiResult[15]).toBeCloseTo(69.86564299424185, 10);
  });

  it('classifies volume ratios at their inclusive band boundaries', () => {
    const result = volumeRatio(
      [...Array.from({ length: 19 }, () => 100), 120, ...Array.from({ length: 19 }, () => 100), 80],
      20,
    );

    expect(result.values[19]).toBeCloseTo(120 / 101, 10);
    expect(result.bands[19]).toBe('normal');
    expect(classifyVolumeRatio(1.2)).toBe('expanding');
    expect(classifyVolumeRatio(0.8)).toBe('contracting');
  });

  it('rejects negative volume while keeping an all-zero window unavailable', () => {
    expect(() => volumeRatio([-100, -100], 2)).toThrow(RangeError);

    const result = volumeRatio(
      Array.from({ length: 20 }, () => 0),
      20,
    );
    expect(last(result.values)).toBeNull();
    expect(last(result.bands)).toBeNull();
  });

  it('tracks running peaks and the minimum drawdown without changing input order', () => {
    const closes = [100, 120, 90];
    const original = [...closes];

    const result = drawdown(closes);

    expect(result.values).toEqual([0, 0, -0.25]);
    expect(result.runningPeaks).toEqual([100, 120, 120]);
    expect(result.maximum).toBe(-0.25);
    expect(closes).toEqual(original);
  });

  it.each([
    ['SMA', () => simpleMovingAverage([1, Number.NaN], 2)],
    ['EMA', () => exponentialMovingAverage([1, Number.POSITIVE_INFINITY], 2)],
    ['RSI', () => relativeStrengthIndex([1, Number.NEGATIVE_INFINITY], 1)],
    ['Bollinger', () => bollingerBands([1, Number.NaN], 2)],
    ['volume ratio', () => volumeRatio([1, Number.NaN], 2)],
    ['volatility', () => realizedVolatility([1, 0], 1)],
    ['drawdown', () => drawdown([1, Number.NaN])],
  ])('rejects invalid %s inputs', (_name, calculate) => {
    expect(calculate).toThrow(RangeError);
  });

  it.each([0, -1, 1.5])('rejects invalid periods (%s)', (period) => {
    expect(() => simpleMovingAverage([1, 2], period)).toThrow(RangeError);
  });
});
