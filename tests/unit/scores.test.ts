import { describe, expect, it } from 'vitest';

import { isoDate } from '../../src/domain/stock';
import {
  CALCULATION_VERSION,
  calculateQualityScore,
  calculateTrendScore,
  calculateValuationScore,
  qualitativeBand,
} from '../../src/analysis/scores';

const CUTOFF = isoDate('2026-07-18');

describe('score engine', () => {
  it('normalizes and explains every complete quality factor with locked weights', () => {
    const result = calculateQualityScore(
      {
        roe: 0.16,
        grossMargin: 0.42,
        revenueGrowth: 0.2,
        profitGrowth: 0.2,
        operatingCashToNetProfit: 1.2,
        debtToAssets: 0.32,
      },
      CUTOFF,
    );

    expect(result).toMatchObject({
      calculationVersion: '1.0.0',
      cutoff: CUTOFF,
      score: 80,
      band: 'strong',
      status: 'complete',
      availableWeight: 100,
      missingInputs: [],
    });
    expect(
      result.observations.map(({ key, label, raw, clipped, weight }) => ({
        key,
        label,
        raw,
        clipped,
        weight,
      })),
    ).toEqual([
      {
        key: 'roe',
        label: 'Return on equity',
        raw: 0.16,
        clipped: 0.16,
        weight: 25,
      },
      {
        key: 'grossMargin',
        label: 'Gross margin',
        raw: 0.42,
        clipped: 0.42,
        weight: 15,
      },
      {
        key: 'revenueGrowth',
        label: 'Revenue growth',
        raw: 0.2,
        clipped: 0.2,
        weight: 15,
      },
      {
        key: 'profitGrowth',
        label: 'Profit growth',
        raw: 0.2,
        clipped: 0.2,
        weight: 15,
      },
      {
        key: 'operatingCashToNetProfit',
        label: 'Operating cash to net profit',
        raw: 1.2,
        clipped: 1.2,
        weight: 20,
      },
      {
        key: 'debtToAssets',
        label: 'Debt to assets',
        raw: 0.32,
        clipped: 0.32,
        weight: 10,
      },
    ]);
    for (const [index, expectedContribution] of [20, 12, 12, 12, 16, 8].entries()) {
      expect(result.observations[index]!.normalized).toBeCloseTo(80, 10);
      expect(result.observations[index]!.weightedContribution).toBeCloseTo(
        expectedContribution,
        10,
      );
    }
  });

  it('reweights a three-factor quality score from 55 available points to 100', () => {
    const result = calculateQualityScore(
      {
        roe: 0.2,
        operatingCashToNetProfit: 1.5,
        debtToAssets: 0.2,
      },
      CUTOFF,
    );

    expect(result).toMatchObject({
      score: 100,
      band: 'strong',
      status: 'partial',
      availableWeight: 55,
      missingInputs: ['grossMargin', 'revenueGrowth', 'profitGrowth'],
    });
    for (const [index, expectedContribution] of [25 / 0.55, 20 / 0.55, 10 / 0.55].entries()) {
      expect(result.observations[index]!.weightedContribution).toBeCloseTo(
        expectedContribution,
        10,
      );
    }
  });

  it('does not fabricate a quality score when only two factors are available', () => {
    const result = calculateQualityScore({ roe: 0.2, debtToAssets: 0.2 }, CUTOFF);

    expect(result).toMatchObject({
      score: null,
      band: null,
      status: 'insufficient',
      availableWeight: 35,
      missingInputs: ['grossMargin', 'revenueGrowth', 'profitGrowth', 'operatingCashToNetProfit'],
    });
    expect(
      result.observations.every(({ weightedContribution }) => weightedContribution === null),
    ).toBe(true);
  });

  it('clips quality inputs at the locked normalization thresholds while preserving raw values', () => {
    const result = calculateQualityScore(
      {
        roe: 0.3,
        grossMargin: 0,
        revenueGrowth: 1,
        profitGrowth: -1,
        operatingCashToNetProfit: 2,
        debtToAssets: 1,
      },
      CUTOFF,
    );

    expect(
      result.observations.map(({ raw, clipped, normalized }) => ({ raw, clipped, normalized })),
    ).toEqual([
      { raw: 0.3, clipped: 0.2, normalized: 100 },
      { raw: 0, clipped: 0.1, normalized: 0 },
      { raw: 1, clipped: 0.3, normalized: 100 },
      { raw: -1, clipped: -0.2, normalized: 0 },
      { raw: 2, clipped: 1.5, normalized: 100 },
      { raw: 1, clipped: 0.8, normalized: 0 },
    ]);
  });

  it('uses midrank percentile direction for PE, PB, and dividend yield', () => {
    const result = calculateValuationScore(
      {
        pe: { current: 15, reference: [10, 15, 20, 25] },
        pb: { current: 2, reference: [1, 2, 3, 4] },
        dividendYield: { current: 0.03, reference: [0.01, 0.02, 0.03, 0.04] },
      },
      CUTOFF,
    );

    expect(result).toMatchObject({
      calculationVersion: CALCULATION_VERSION,
      cutoff: CUTOFF,
      score: 62.5,
      band: 'constructive',
      status: 'complete',
      availableWeight: 100,
      missingInputs: [],
    });
    expect(result.observations.map(({ key, label }) => ({ key, label }))).toEqual([
      { key: 'pe', label: 'Price to earnings percentile' },
      { key: 'pb', label: 'Price to book percentile' },
      { key: 'dividendYield', label: 'Dividend yield percentile' },
    ]);
    for (const observation of result.observations) {
      expect(observation.normalized).toBe(62.5);
      expect(observation.weightedContribution).toBeCloseTo(62.5 / 3, 10);
    }
  });

  it('requires four references per valuation factor and at least two usable factors', () => {
    const result = calculateValuationScore(
      {
        pe: { current: 15, reference: [10, 15, 20] },
        pb: { current: 2, reference: [1, 2, 3, 4] },
      },
      CUTOFF,
    );

    expect(result).toMatchObject({
      score: null,
      band: null,
      status: 'insufficient',
      availableWeight: 100 / 3,
      missingInputs: ['pe', 'dividendYield'],
    });
  });

  it('awards 40 alignment points for the rising fixture and lists every missing trend observation', () => {
    const result = calculateTrendScore(
      {
        close: 80,
        ma20: 70.5,
        ma60: 50.5,
        previousMa20: null,
        macdHistogram: null,
        volumeRatio20: null,
        dailyReturn: null,
      },
      CUTOFF,
    );

    expect(result).toMatchObject({
      score: 100,
      band: 'strong',
      status: 'partial',
      availableWeight: 40,
      missingInputs: ['ma20Slope', 'macdHistogram', 'volumeConfirmation'],
    });
    expect(result.observations).toEqual([
      {
        key: 'maAlignment',
        label: 'Moving-average alignment',
        raw: { close: 80, ma20: 70.5, ma60: 50.5 },
        clipped: 40,
        normalized: 100,
        weight: 40,
        weightedContribution: 100,
      },
    ]);
  });

  it('uses the 20-day MA slope as the direction confirmed by daily return and volume', () => {
    const result = calculateTrendScore(
      {
        close: 80,
        ma20: 70.5,
        ma60: 50.5,
        previousMa20: 71,
        macdHistogram: 2,
        volumeRatio20: 1.1,
        dailyReturn: -0.01,
      },
      CUTOFF,
    );

    expect(result.score).toBe(80);
    expect(result.availableWeight).toBe(100);
    expect(
      result.observations.map(({ key, weightedContribution }) => ({
        key,
        weightedContribution,
      })),
    ).toEqual([
      { key: 'maAlignment', weightedContribution: 40 },
      { key: 'ma20Slope', weightedContribution: 0 },
      { key: 'macdHistogram', weightedContribution: 20 },
      { key: 'volumeConfirmation', weightedContribution: 20 },
    ]);
  });

  it('uses exact qualitative band boundaries without recommendation language', () => {
    expect([39.999, 40, 59.999, 60, 79.999, 80].map(qualitativeBand)).toEqual([
      'weak',
      'mixed',
      'mixed',
      'constructive',
      'constructive',
      'strong',
    ]);

    const serialized = JSON.stringify(
      calculateQualityScore({ roe: 0.2, operatingCashToNetProfit: 1.5, debtToAssets: 0.2 }, CUTOFF),
    ).toLowerCase();
    expect(serialized).not.toContain('buy');
    expect(serialized).not.toContain('sell');
  });

  it.each([
    ['quality', () => calculateQualityScore({ roe: Number.NaN }, CUTOFF)],
    [
      'valuation current',
      () =>
        calculateValuationScore(
          { pe: { current: Number.POSITIVE_INFINITY, reference: [1, 2, 3, 4] } },
          CUTOFF,
        ),
    ],
    [
      'valuation reference',
      () =>
        calculateValuationScore({ pe: { current: 1, reference: [1, 2, Number.NaN, 4] } }, CUTOFF),
    ],
    ['trend', () => calculateTrendScore({ close: Number.NEGATIVE_INFINITY }, CUTOFF)],
  ])('rejects non-finite %s inputs', (_name, calculate) => {
    expect(calculate).toThrow(RangeError);
  });
});
