export type NullableSeries = readonly (number | null)[];

export type VolumeBand = 'contracting' | 'normal' | 'expanding';

export interface MacdSeries {
  readonly line: NullableSeries;
  readonly signal: NullableSeries;
  readonly histogram: NullableSeries;
}

export interface BollingerSeries {
  readonly mean: NullableSeries;
  readonly upper: NullableSeries;
  readonly lower: NullableSeries;
}

export interface VolumeRatioSeries {
  readonly values: NullableSeries;
  readonly bands: readonly (VolumeBand | null)[];
}

export interface DrawdownSeries {
  readonly values: readonly number[];
  readonly runningPeaks: readonly number[];
  readonly maximum: number | null;
}

export interface TechnicalIndicatorInput {
  readonly closes: readonly number[];
  readonly volumes: readonly number[];
}

export interface TechnicalIndicators {
  readonly sma5: NullableSeries;
  readonly sma20: NullableSeries;
  readonly sma60: NullableSeries;
  readonly ema12: NullableSeries;
  readonly ema26: NullableSeries;
  readonly macd: MacdSeries;
  readonly rsi14: NullableSeries;
  readonly bollinger20: BollingerSeries;
  readonly volumeRatio20: VolumeRatioSeries;
  readonly realizedVolatility20: NullableSeries;
  readonly drawdown: DrawdownSeries;
}

function assertPeriod(period: number, minimum = 1): void {
  if (!Number.isInteger(period) || period < minimum) {
    throw new RangeError(`Period must be an integer greater than or equal to ${minimum}`);
  }
}

function assertFiniteSeries(values: readonly number[], name: string): void {
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`${name} must contain only finite values`);
    }
  }
}

function assertPositiveSeries(values: readonly number[], name: string): void {
  assertFiniteSeries(values, name);
  for (const value of values) {
    if (value <= 0) {
      throw new RangeError(`${name} must contain only positive values`);
    }
  }
}

function assertNonNegativeSeries(values: readonly number[], name: string): void {
  assertFiniteSeries(values, name);
  for (const value of values) {
    if (value < 0) {
      throw new RangeError(`${name} must contain only non-negative values`);
    }
  }
}

export function simpleMovingAverage(values: readonly number[], period: number): NullableSeries {
  assertPeriod(period);
  assertFiniteSeries(values, 'Values');

  const result: (number | null)[] = Array.from({ length: values.length }, () => null);
  let sum = 0;

  for (let index = 0; index < values.length; index += 1) {
    sum += values[index]!;
    if (index >= period) {
      sum -= values[index - period]!;
    }
    if (index >= period - 1) {
      result[index] = sum / period;
    }
  }

  return result;
}

export function exponentialMovingAverage(
  values: readonly number[],
  period: number,
): NullableSeries {
  assertPeriod(period);
  assertFiniteSeries(values, 'Values');
  return exponentialMovingAverageFromNullable(values, period);
}

function exponentialMovingAverageFromNullable(
  values: readonly (number | null)[],
  period: number,
): NullableSeries {
  const result: (number | null)[] = Array.from({ length: values.length }, () => null);
  const multiplier = 2 / (period + 1);
  let seed: number[] = [];
  let previous: number | null = null;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value === null) {
      seed = [];
      previous = null;
      continue;
    }

    if (previous === null) {
      seed.push(value);
      if (seed.length < period) {
        continue;
      }
      if (seed.length > period) {
        seed.shift();
      }
      previous = seed.reduce((sum, item) => sum + item, 0) / period;
      result[index] = previous;
      continue;
    }

    previous = value * multiplier + previous * (1 - multiplier);
    result[index] = previous;
  }

  return result;
}

export function macd(
  values: readonly number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdSeries {
  assertPeriod(fastPeriod);
  assertPeriod(slowPeriod);
  assertPeriod(signalPeriod);
  if (fastPeriod >= slowPeriod) {
    throw new RangeError('Fast MACD period must be shorter than slow period');
  }
  assertFiniteSeries(values, 'Values');

  const fast = exponentialMovingAverage(values, fastPeriod);
  const slow = exponentialMovingAverage(values, slowPeriod);
  const line = values.map((_, index) => {
    const fastValue = fast[index]!;
    const slowValue = slow[index]!;
    return fastValue === null || slowValue === null ? null : fastValue - slowValue;
  });
  const signal = exponentialMovingAverageFromNullable(line, signalPeriod);
  const histogram = line.map((value, index) => {
    const signalValue = signal[index]!;
    return value === null || signalValue === null ? null : value - signalValue;
  });

  return { line, signal, histogram };
}

function rsiValue(averageGain: number, averageLoss: number): number {
  if (averageGain === 0 && averageLoss === 0) {
    return 50;
  }
  if (averageLoss === 0) {
    return 100;
  }
  return 100 - 100 / (1 + averageGain / averageLoss);
}

export function relativeStrengthIndex(values: readonly number[], period = 14): NullableSeries {
  assertPeriod(period);
  assertFiniteSeries(values, 'Values');

  const result: (number | null)[] = Array.from({ length: values.length }, () => null);
  if (values.length <= period) {
    return result;
  }

  let gainSum = 0;
  let lossSum = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index]! - values[index - 1]!;
    gainSum += Math.max(change, 0);
    lossSum += Math.max(-change, 0);
  }

  let averageGain = gainSum / period;
  let averageLoss = lossSum / period;
  result[period] = rsiValue(averageGain, averageLoss);

  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index]! - values[index - 1]!;
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[index] = rsiValue(averageGain, averageLoss);
  }

  return result;
}

export function bollingerBands(
  values: readonly number[],
  period = 20,
  standardDeviationMultiplier = 2,
): BollingerSeries {
  assertPeriod(period);
  assertFiniteSeries(values, 'Values');
  if (!Number.isFinite(standardDeviationMultiplier) || standardDeviationMultiplier < 0) {
    throw new RangeError('Standard deviation multiplier must be finite and non-negative');
  }

  const mean = simpleMovingAverage(values, period);
  const upper: (number | null)[] = Array.from({ length: values.length }, () => null);
  const lower: (number | null)[] = Array.from({ length: values.length }, () => null);

  for (let index = period - 1; index < values.length; index += 1) {
    const average = mean[index]!;
    if (average === null) {
      continue;
    }
    let squaredDifferenceSum = 0;
    for (let windowIndex = index - period + 1; windowIndex <= index; windowIndex += 1) {
      squaredDifferenceSum += (values[windowIndex]! - average) ** 2;
    }
    const standardDeviation = Math.sqrt(squaredDifferenceSum / period);
    upper[index] = average + standardDeviationMultiplier * standardDeviation;
    lower[index] = average - standardDeviationMultiplier * standardDeviation;
  }

  return { mean, upper, lower };
}

export function classifyVolumeRatio(ratio: number): VolumeBand {
  if (!Number.isFinite(ratio) || ratio < 0) {
    throw new RangeError('Volume ratio must be finite and non-negative');
  }
  if (ratio >= 1.2) {
    return 'expanding';
  }
  if (ratio <= 0.8) {
    return 'contracting';
  }
  return 'normal';
}

export function volumeRatio(values: readonly number[], period = 20): VolumeRatioSeries {
  assertPeriod(period);
  assertNonNegativeSeries(values, 'Volumes');

  const averages = simpleMovingAverage(values, period);
  const ratios: (number | null)[] = Array.from({ length: values.length }, () => null);
  const bands: (VolumeBand | null)[] = Array.from({ length: values.length }, () => null);

  for (let index = period - 1; index < values.length; index += 1) {
    const average = averages[index]!;
    if (average === null || average === 0) {
      continue;
    }
    const ratio = values[index]! / average;
    ratios[index] = ratio;
    bands[index] = classifyVolumeRatio(ratio);
  }

  return { values: ratios, bands };
}

export function realizedVolatility(values: readonly number[], period = 20): NullableSeries {
  assertPeriod(period, 2);
  assertPositiveSeries(values, 'Closes');

  const returns = values.map((value, index) =>
    index === 0 ? null : Math.log(value / values[index - 1]!),
  );
  const result: (number | null)[] = Array.from({ length: values.length }, () => null);

  for (let index = period; index < values.length; index += 1) {
    const window = returns.slice(index - period + 1, index + 1) as number[];
    const mean = window.reduce((sum, value) => sum + value, 0) / period;
    const squaredDifferenceSum = window.reduce((sum, value) => sum + (value - mean) ** 2, 0);
    result[index] = Math.sqrt(squaredDifferenceSum / (period - 1)) * Math.sqrt(252);
  }

  return result;
}

export function drawdown(values: readonly number[]): DrawdownSeries {
  assertPositiveSeries(values, 'Closes');
  if (values.length === 0) {
    return { values: [], runningPeaks: [], maximum: null };
  }

  const runningPeaks: number[] = [];
  const drawdowns: number[] = [];
  let peak = values[0]!;
  let maximum = 0;

  for (const value of values) {
    peak = Math.max(peak, value);
    const current = value / peak - 1;
    runningPeaks.push(peak);
    drawdowns.push(current);
    maximum = Math.min(maximum, current);
  }

  return { values: drawdowns, runningPeaks, maximum };
}

export function calculateTechnicalIndicators(input: TechnicalIndicatorInput): TechnicalIndicators {
  if (input.closes.length !== input.volumes.length) {
    throw new RangeError('Close and volume series must have equal lengths');
  }

  return {
    sma5: simpleMovingAverage(input.closes, 5),
    sma20: simpleMovingAverage(input.closes, 20),
    sma60: simpleMovingAverage(input.closes, 60),
    ema12: exponentialMovingAverage(input.closes, 12),
    ema26: exponentialMovingAverage(input.closes, 26),
    macd: macd(input.closes),
    rsi14: relativeStrengthIndex(input.closes, 14),
    bollinger20: bollingerBands(input.closes, 20, 2),
    volumeRatio20: volumeRatio(input.volumes, 20),
    realizedVolatility20: realizedVolatility(input.closes, 20),
    drawdown: drawdown(input.closes),
  };
}
