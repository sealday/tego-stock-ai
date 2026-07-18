import type { IsoDate } from '../domain/stock';

export const CALCULATION_VERSION = '1.0.0' as const;

export type ScoreBand = 'weak' | 'mixed' | 'constructive' | 'strong';
export type ScoreStatus = 'complete' | 'partial' | 'insufficient';
export type ObservationRawValue = number | Readonly<Record<string, number>>;
export type MissingReason = 'missing' | 'insufficient-reference';

export type MissingInputDetail =
  | {
      readonly key: string;
      readonly label: string;
      readonly reason: 'missing';
    }
  | {
      readonly key: string;
      readonly label: string;
      readonly reason: 'insufficient-reference';
      readonly availableReferenceCount: number;
      readonly requiredReferenceCount: number;
    };

export interface ScoreObservation {
  readonly key: string;
  readonly label: string;
  readonly raw: ObservationRawValue;
  readonly clipped: number;
  readonly normalized: number;
  readonly weight: number;
  readonly weightedContribution: number | null;
}

export interface ExplainableScore {
  readonly calculationVersion: typeof CALCULATION_VERSION;
  readonly cutoff: IsoDate;
  readonly score: number | null;
  readonly band: ScoreBand | null;
  readonly status: ScoreStatus;
  readonly observations: readonly ScoreObservation[];
  readonly missingInputs: readonly string[];
  readonly missingDetails: readonly MissingInputDetail[];
  readonly availableWeight: number;
}

export interface QualityScoreInput {
  readonly roe?: number | null;
  readonly grossMargin?: number | null;
  readonly revenueGrowth?: number | null;
  readonly profitGrowth?: number | null;
  readonly operatingCashToNetProfit?: number | null;
  readonly debtToAssets?: number | null;
}

export interface ValuationFactorInput {
  readonly current: number;
  readonly reference: readonly number[];
}

export interface ValuationScoreInput {
  readonly pe?: ValuationFactorInput | null;
  readonly pb?: ValuationFactorInput | null;
  readonly dividendYield?: ValuationFactorInput | null;
}

export interface TrendScoreInput {
  readonly close?: number | null;
  readonly ma20?: number | null;
  readonly ma60?: number | null;
  readonly previousMa20?: number | null;
  readonly macdHistogram?: number | null;
  readonly volumeRatio20?: number | null;
  readonly dailyReturn?: number | null;
}

type QualityKey = keyof QualityScoreInput;

interface QualityDefinition {
  readonly key: QualityKey;
  readonly label: string;
  readonly weight: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly inverse?: true;
}

const QUALITY_DEFINITIONS: readonly QualityDefinition[] = [
  {
    key: 'roe',
    label: 'Return on equity',
    weight: 25,
    minimum: 0,
    maximum: 0.2,
  },
  {
    key: 'grossMargin',
    label: 'Gross margin',
    weight: 15,
    minimum: 0.1,
    maximum: 0.5,
  },
  {
    key: 'revenueGrowth',
    label: 'Revenue growth',
    weight: 15,
    minimum: -0.2,
    maximum: 0.3,
  },
  {
    key: 'profitGrowth',
    label: 'Profit growth',
    weight: 15,
    minimum: -0.2,
    maximum: 0.3,
  },
  {
    key: 'operatingCashToNetProfit',
    label: 'Operating cash to net profit',
    weight: 20,
    minimum: 0,
    maximum: 1.5,
  },
  {
    key: 'debtToAssets',
    label: 'Debt to assets',
    weight: 10,
    minimum: 0.2,
    maximum: 0.8,
    inverse: true,
  },
];

const VALUATION_WEIGHT = 100 / 3;

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite`);
  }
}

function assertOptionalFinite(value: number | null | undefined, name: string): void {
  if (value !== null && value !== undefined) {
    assertFinite(value, name);
  }
}

export function clip(value: number, minimum: number, maximum: number): number {
  assertFinite(value, 'Value');
  assertFinite(minimum, 'Minimum');
  assertFinite(maximum, 'Maximum');
  if (minimum >= maximum) {
    throw new RangeError('Minimum must be less than maximum');
  }
  return Math.min(Math.max(value, minimum), maximum);
}

export function normalizeLinear(
  value: number,
  minimum: number,
  maximum: number,
  inverse = false,
): { readonly clipped: number; readonly normalized: number } {
  const clippedValue = clip(value, minimum, maximum);
  const position = (clippedValue - minimum) / (maximum - minimum);
  return {
    clipped: clippedValue,
    normalized: (inverse ? 1 - position : position) * 100,
  };
}

export function percentileRank(current: number, reference: readonly number[]): number {
  assertFinite(current, 'Current value');
  if (reference.length === 0) {
    throw new RangeError('Percentile reference must not be empty');
  }
  for (const value of reference) {
    assertFinite(value, 'Reference value');
  }

  let countLess = 0;
  let countEqual = 0;
  for (const value of reference) {
    if (value < current) {
      countLess += 1;
    } else if (value === current) {
      countEqual += 1;
    }
  }
  return (countLess + 0.5 * countEqual) / reference.length;
}

export function qualitativeBand(score: number): ScoreBand {
  assertFinite(score, 'Score');
  if (score < 0 || score > 100) {
    throw new RangeError('Score must be between 0 and 100');
  }
  if (score < 40) {
    return 'weak';
  }
  if (score < 60) {
    return 'mixed';
  }
  if (score < 80) {
    return 'constructive';
  }
  return 'strong';
}

function composeScore(
  observations: readonly Omit<ScoreObservation, 'weightedContribution'>[],
  missingDetails: readonly MissingInputDetail[],
  cutoff: IsoDate,
  expectedObservationCount: number,
  minimumObservationCount: number,
): ExplainableScore {
  const availableWeight = observations.reduce((sum, observation) => sum + observation.weight, 0);
  const enoughInputs = observations.length >= minimumObservationCount && availableWeight > 0;
  const score = enoughInputs
    ? observations.reduce(
        (sum, observation) => sum + observation.normalized * observation.weight,
        0,
      ) / availableWeight
    : null;
  const explainedObservations = observations.map(
    (observation): ScoreObservation => ({
      ...observation,
      weightedContribution:
        score === null ? null : (observation.normalized * observation.weight) / availableWeight,
    }),
  );

  return {
    calculationVersion: CALCULATION_VERSION,
    cutoff,
    score,
    band: score === null ? null : qualitativeBand(score),
    status:
      score === null
        ? 'insufficient'
        : observations.length === expectedObservationCount
          ? 'complete'
          : 'partial',
    observations: explainedObservations,
    missingInputs: missingDetails.map(({ key }) => key),
    missingDetails,
    availableWeight,
  };
}

function missingDetail(key: string, label: string): MissingInputDetail {
  return { key, label, reason: 'missing' };
}

export function calculateQualityScore(input: QualityScoreInput, cutoff: IsoDate): ExplainableScore {
  const observations: Omit<ScoreObservation, 'weightedContribution'>[] = [];
  const missingDetails: MissingInputDetail[] = [];

  for (const definition of QUALITY_DEFINITIONS) {
    const raw = input[definition.key];
    assertOptionalFinite(raw, definition.key);
    if (raw === null || raw === undefined) {
      missingDetails.push(missingDetail(definition.key, definition.label));
      continue;
    }

    const normalized = normalizeLinear(
      raw,
      definition.minimum,
      definition.maximum,
      definition.inverse,
    );
    observations.push({
      key: definition.key,
      label: definition.label,
      raw,
      clipped: normalized.clipped,
      normalized: normalized.normalized,
      weight: definition.weight,
    });
  }

  return composeScore(observations, missingDetails, cutoff, QUALITY_DEFINITIONS.length, 3);
}

type ValuationEvaluation =
  | { readonly observation: Omit<ScoreObservation, 'weightedContribution'> }
  | { readonly missingDetail: MissingInputDetail };

function evaluateValuationFactor(
  key: 'pe' | 'pb' | 'dividendYield',
  label: string,
  input: ValuationFactorInput | null | undefined,
  lowerIsBetter: boolean,
): ValuationEvaluation {
  if (input === null || input === undefined) {
    return { missingDetail: missingDetail(key, label) };
  }
  assertFinite(input.current, `${key} current`);
  for (const referenceValue of input.reference) {
    assertFinite(referenceValue, `${key} reference`);
  }
  if (input.reference.length < 4) {
    return {
      missingDetail: {
        key,
        label,
        reason: 'insufficient-reference',
        availableReferenceCount: input.reference.length,
        requiredReferenceCount: 4,
      },
    };
  }

  const percentile = percentileRank(input.current, input.reference);
  const normalized = (lowerIsBetter ? 1 - percentile : percentile) * 100;
  return {
    observation: {
      key,
      label,
      raw: {
        current: input.current,
        percentile,
        referenceCount: input.reference.length,
      },
      clipped: input.current,
      normalized,
      weight: VALUATION_WEIGHT,
    },
  };
}

export function calculateValuationScore(
  input: ValuationScoreInput,
  cutoff: IsoDate,
): ExplainableScore {
  const candidates = [
    evaluateValuationFactor('pe', 'Price to earnings percentile', input.pe, true),
    evaluateValuationFactor('pb', 'Price to book percentile', input.pb, true),
    evaluateValuationFactor(
      'dividendYield',
      'Dividend yield percentile',
      input.dividendYield,
      false,
    ),
  ] as const;
  const observations: Omit<ScoreObservation, 'weightedContribution'>[] = [];
  const missingDetails: MissingInputDetail[] = [];

  for (const candidate of candidates) {
    if ('missingDetail' in candidate) {
      missingDetails.push(candidate.missingDetail);
    } else {
      observations.push(candidate.observation);
    }
  }

  return composeScore(observations, missingDetails, cutoff, 3, 2);
}

function available(value: number | null | undefined): value is number {
  return value !== null && value !== undefined;
}

function trendObservation(
  key: string,
  label: string,
  raw: Readonly<Record<string, number>> | number,
  points: number,
  weight: number,
): Omit<ScoreObservation, 'weightedContribution'> {
  return {
    key,
    label,
    raw,
    clipped: points,
    normalized: (points / weight) * 100,
    weight,
  };
}

export function calculateTrendScore(input: TrendScoreInput, cutoff: IsoDate): ExplainableScore {
  const providedValues: readonly (readonly [string, number | null | undefined])[] = [
    ['close', input.close],
    ['ma20', input.ma20],
    ['ma60', input.ma60],
    ['previousMa20', input.previousMa20],
    ['macdHistogram', input.macdHistogram],
    ['volumeRatio20', input.volumeRatio20],
    ['dailyReturn', input.dailyReturn],
  ];
  for (const [name, value] of providedValues) {
    assertOptionalFinite(value, name);
  }
  if (available(input.volumeRatio20) && input.volumeRatio20 < 0) {
    throw new RangeError('volumeRatio20 must be non-negative');
  }

  const observations: Omit<ScoreObservation, 'weightedContribution'>[] = [];
  const missingDetails: MissingInputDetail[] = [];

  if (available(input.close) && available(input.ma20) && available(input.ma60)) {
    const points =
      input.close > input.ma20 && input.ma20 > input.ma60
        ? 40
        : input.close < input.ma20 && input.ma20 < input.ma60
          ? 0
          : 20;
    observations.push(
      trendObservation(
        'maAlignment',
        'Moving-average alignment',
        { close: input.close, ma20: input.ma20, ma60: input.ma60 },
        points,
        40,
      ),
    );
  } else {
    missingDetails.push(missingDetail('maAlignment', 'Moving-average alignment'));
  }

  if (available(input.ma20) && available(input.previousMa20)) {
    observations.push(
      trendObservation(
        'ma20Slope',
        '20-day moving-average slope',
        { current: input.ma20, previous: input.previousMa20 },
        input.ma20 > input.previousMa20 ? 20 : 0,
        20,
      ),
    );
  } else {
    missingDetails.push(missingDetail('ma20Slope', '20-day moving-average slope'));
  }

  if (available(input.macdHistogram)) {
    observations.push(
      trendObservation(
        'macdHistogram',
        'MACD histogram direction',
        input.macdHistogram,
        input.macdHistogram > 0 ? 20 : 0,
        20,
      ),
    );
  } else {
    missingDetails.push(missingDetail('macdHistogram', 'MACD histogram direction'));
  }

  if (
    available(input.volumeRatio20) &&
    available(input.dailyReturn) &&
    available(input.ma20) &&
    available(input.previousMa20)
  ) {
    const directionAgrees =
      (input.ma20 > input.previousMa20 && input.dailyReturn > 0) ||
      (input.ma20 < input.previousMa20 && input.dailyReturn < 0);
    observations.push(
      trendObservation(
        'volumeConfirmation',
        'Volume and direction confirmation',
        {
          volumeRatio20: input.volumeRatio20,
          dailyReturn: input.dailyReturn,
          ma20: input.ma20,
          previousMa20: input.previousMa20,
        },
        input.volumeRatio20 >= 1 && directionAgrees ? 20 : 0,
        20,
      ),
    );
  } else {
    missingDetails.push(missingDetail('volumeConfirmation', 'Volume and direction confirmation'));
  }

  return composeScore(observations, missingDetails, cutoff, 4, 1);
}
