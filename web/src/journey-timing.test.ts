import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LONG_TRIP_COMPRESSION,
  JourneyTiming,
  LONG_TRIP_COMPRESSION_EXPONENTS,
  LongTripCompression,
  type JourneyTimingJourney,
} from './journey-timing';

function journeyWithSegments(...segmentsKm: number[]): JourneyTimingJourney {
  const cumulativeDistanceKm = [0];
  for (const segmentKm of segmentsKm) {
    cumulativeDistanceKm.push(cumulativeDistanceKm.at(-1)! + segmentKm);
  }
  return {
    points: cumulativeDistanceKm.map(() => ({})),
    cumulativeDistanceKm,
    totalDistanceKm: cumulativeDistanceKm.at(-1) ?? 0,
  };
}

function progressAtDistance(timing: JourneyTiming, distanceKm: number): number {
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const middle = (low + high) / 2;
    if (timing.distanceAt(middle) < distanceKm) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

describe('LongTripCompression', () => {
  it('matches the Android v2.2.0 profiles and default', () => {
    expect(LONG_TRIP_COMPRESSION_EXPONENTS).toEqual({
      off: 1,
      gentle: 0.92,
      balanced: 0.85,
      strong: 0.75,
    });
    expect(DEFAULT_LONG_TRIP_COMPRESSION).toBe(LongTripCompression.BALANCED);
  });
});

describe('JourneyTiming', () => {
  it('reduces a long segment share without changing geometry or endpoints', () => {
    const journey = journeyWithSegments(0.1, 10, 0.1);
    const originalPoints = [...journey.points];
    const linear = JourneyTiming.create(journey, LongTripCompression.OFF);
    const balanced = JourneyTiming.create(journey, LongTripCompression.BALANCED);
    const longStartKm = journey.cumulativeDistanceKm[1];
    const longEndKm = journey.cumulativeDistanceKm[2];
    const linearShare = (
      progressAtDistance(linear, longEndKm) - progressAtDistance(linear, longStartKm)
    );
    const balancedShare = (
      progressAtDistance(balanced, longEndKm) - progressAtDistance(balanced, longStartKm)
    );

    expect(balancedShare).toBeLessThan(linearShare);
    expect(journey.points).toEqual(originalPoints);
    expect(balanced.distanceAt(0)).toBeCloseTo(0, 9);
    expect(balanced.distanceAt(1)).toBeCloseTo(journey.totalDistanceKm, 6);
  });

  it('keeps off timing exactly linear and clamps elapsed progress', () => {
    const journey = journeyWithSegments(0.1, 10);
    const timing = JourneyTiming.create(journey, LongTripCompression.OFF);

    for (const progress of [0, 0.1, 0.5, 0.9, 1]) {
      expect(timing.distanceAt(progress)).toBe(journey.totalDistanceKm * progress);
    }
    expect(timing.distanceAt(-1)).toBe(0);
    expect(timing.distanceAt(2)).toBe(journey.totalDistanceKm);
  });

  it('has no speed jump at a compressed segment boundary', () => {
    const journey = journeyWithSegments(0.1, 10, 0.1);
    const timing = JourneyTiming.create(journey, LongTripCompression.BALANCED);
    const boundaryProgress = progressAtDistance(timing, journey.cumulativeDistanceKm[1]);
    const step = 0.00001;
    const speedBefore = (
      timing.distanceAt(boundaryProgress) - timing.distanceAt(boundaryProgress - step)
    ) / step;
    const speedAfter = (
      timing.distanceAt(boundaryProgress + step) - timing.distanceAt(boundaryProgress)
    ) / step;

    expect(Math.abs(speedBefore - speedAfter)).toBeLessThanOrEqual(
      Math.max(1, speedBefore * 0.02),
    );
  });

  it('places every positive segment boundary at its power-weighted elapsed fraction', () => {
    const journey = journeyWithSegments(1, 4, 16);
    for (const compression of [
      LongTripCompression.GENTLE,
      LongTripCompression.BALANCED,
      LongTripCompression.STRONG,
    ]) {
      const exponent = LONG_TRIP_COMPRESSION_EXPONENTS[compression];
      const weights = [1, 4, 16].map((distance) => distance ** exponent);
      const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
      const timing = JourneyTiming.create(journey, compression);
      expect(timing.distanceAt(weights[0] / totalWeight)).toBeCloseTo(1, 12);
      expect(timing.distanceAt((weights[0] + weights[1]) / totalWeight)).toBeCloseTo(5, 12);
    }
  });

  it('falls back to linear timing for short or zero-distance journeys', () => {
    const onePoint: JourneyTimingJourney = {
      points: [{}],
      cumulativeDistanceKm: [0],
      totalDistanceKm: 0,
    };
    const stationary: JourneyTimingJourney = {
      points: [{}, {}, {}],
      cumulativeDistanceKm: [0, 0, 0],
      totalDistanceKm: 0,
    };

    expect(JourneyTiming.create(onePoint, LongTripCompression.STRONG).distanceAt(0.5)).toBe(0);
    expect(JourneyTiming.create(stationary, LongTripCompression.STRONG).distanceAt(0.5)).toBe(0);
  });

  it('remains monotone through highly uneven segments', () => {
    const timing = JourneyTiming.create(
      journeyWithSegments(0.001, 1000, 0.01, 300, 0.002),
      LongTripCompression.STRONG,
    );
    let previous = timing.distanceAt(0);
    for (let sample = 1; sample <= 10_000; sample += 1) {
      const current = timing.distanceAt(sample / 10_000);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});
