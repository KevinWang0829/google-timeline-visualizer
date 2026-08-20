/**
 * Long-trip playback profiles from Android v2.2.0's CameraSettings.kt.
 *
 * Smaller exponents give disproportionately long route segments less screen
 * time. `off` deliberately stays on the exact linear fast path.
 */
export const LongTripCompression = {
  OFF: 'off',
  GENTLE: 'gentle',
  BALANCED: 'balanced',
  STRONG: 'strong',
} as const;

export type LongTripCompression =
  (typeof LongTripCompression)[keyof typeof LongTripCompression];

export const LONG_TRIP_COMPRESSION_EXPONENTS: Readonly<Record<LongTripCompression, number>> = {
  [LongTripCompression.OFF]: 1,
  [LongTripCompression.GENTLE]: 0.92,
  [LongTripCompression.BALANCED]: 0.85,
  [LongTripCompression.STRONG]: 0.75,
};

export const DEFAULT_LONG_TRIP_COMPRESSION: LongTripCompression =
  LongTripCompression.BALANCED;

export interface JourneyTimingJourney {
  readonly points: readonly unknown[];
  readonly cumulativeDistanceKm: readonly number[];
  readonly totalDistanceKm: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function binarySearch(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const value = values[middle];
    if (value < target) low = middle + 1;
    else if (value > target) high = middle - 1;
    else return middle;
  }
  return -low - 1;
}

function endpointSlope(
  firstWidth: number,
  secondWidth: number,
  first: number,
  second: number,
): number {
  const slope = (
    (2 * firstWidth + secondWidth) * first - firstWidth * second
  ) / (firstWidth + secondWidth);
  if (slope <= 0) return 0;
  if (slope > 3 * first) return 3 * first;
  return slope;
}

function monotoneSlopes(x: readonly number[], y: readonly number[]): number[] {
  const segmentCount = x.length - 1;
  const delta = Array.from(
    { length: segmentCount },
    (_, index) => (y[index + 1] - y[index]) / (x[index + 1] - x[index]),
  );
  if (segmentCount === 1) return [delta[0], delta[0]];

  const slopes = new Array<number>(x.length).fill(0);
  slopes[0] = endpointSlope(x[1] - x[0], x[2] - x[1], delta[0], delta[1]);
  for (let index = 1; index < x.length - 1; index += 1) {
    if (delta[index - 1] <= 0 || delta[index] <= 0) {
      slopes[index] = 0;
      continue;
    }
    const beforeWidth = x[index] - x[index - 1];
    const afterWidth = x[index + 1] - x[index];
    const weightBefore = 2 * afterWidth + beforeWidth;
    const weightAfter = afterWidth + 2 * beforeWidth;
    slopes[index] = (weightBefore + weightAfter) / (
      weightBefore / delta[index - 1] + weightAfter / delta[index]
    );
  }
  const last = slopes.length - 1;
  slopes[last] = endpointSlope(
    x[last] - x[last - 1],
    x[last - 1] - x[last - 2],
    delta[delta.length - 1],
    delta[delta.length - 2],
  );
  return slopes;
}

/** Maps elapsed video progress to original route distance without changing geometry. */
export class JourneyTiming {
  private constructor(
    private readonly elapsedFractions: readonly number[],
    private readonly distancesKm: readonly number[],
    private readonly slopes: readonly number[],
    private readonly linearDistanceKm: number | null,
  ) {}

  static create(
    journey: JourneyTimingJourney,
    compression: LongTripCompression,
  ): JourneyTiming {
    if (compression === LongTripCompression.OFF || journey.points.length < 2) {
      return new JourneyTiming([], [], [], journey.totalDistanceKm);
    }

    const distances = new Array<number>(journey.cumulativeDistanceKm.length).fill(0);
    const effective = new Array<number>(journey.cumulativeDistanceKm.length).fill(0);
    const exponent = LONG_TRIP_COMPRESSION_EXPONENTS[compression];
    let count = 1;
    let effectiveTotal = 0;
    for (let index = 1; index < journey.cumulativeDistanceKm.length; index += 1) {
      const segmentKm = (
        journey.cumulativeDistanceKm[index] - journey.cumulativeDistanceKm[index - 1]
      );
      if (segmentKm <= 0) continue;
      effectiveTotal += segmentKm ** exponent;
      distances[count] = journey.cumulativeDistanceKm[index];
      effective[count] = effectiveTotal;
      count += 1;
    }

    if (effectiveTotal <= 0 || count < 2) {
      return new JourneyTiming([], [], [], journey.totalDistanceKm);
    }

    const elapsedFractions = effective
      .slice(0, count)
      .map((distance) => distance / effectiveTotal);
    const compressedDistances = distances.slice(0, count);
    return new JourneyTiming(
      elapsedFractions,
      compressedDistances,
      monotoneSlopes(elapsedFractions, compressedDistances),
      null,
    );
  }

  distanceAt(progress: number): number {
    const elapsed = clamp(progress, 0, 1);
    if (this.linearDistanceKm !== null) return this.linearDistanceKm * elapsed;
    if (this.elapsedFractions.length < 2) return this.distancesKm.at(-1) ?? 0;

    const exact = binarySearch(this.elapsedFractions, elapsed);
    if (exact >= 0) return this.distancesKm[exact];
    const to = clamp(-exact - 1, 1, this.elapsedFractions.length - 1);
    const from = to - 1;
    const width = this.elapsedFractions[to] - this.elapsedFractions[from];
    if (width <= 0) return this.distancesKm[from];

    const t = clamp((elapsed - this.elapsedFractions[from]) / width, 0, 1);
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * this.distancesKm[from]
      + (t3 - 2 * t2 + t) * width * this.slopes[from]
      + (-2 * t3 + 3 * t2) * this.distancesKm[to]
      + (t3 - t2) * width * this.slopes[to]
    );
  }
}

