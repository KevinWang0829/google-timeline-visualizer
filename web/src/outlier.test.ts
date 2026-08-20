import { describe, expect, it } from 'vitest';
import { filterLocationOutliers } from './outlier';
import type { GeoPoint } from './types';

function point(instant: string, latitude: number, longitude: number): GeoPoint {
  return { instant: new Date(instant), latitude, longitude };
}

describe('filterLocationOutliers', () => {
  it('removes one impossible out-and-back point', () => {
    const points = [
      point('2026-01-01T00:00:00Z', 37.5665, 126.9780),
      point('2026-01-01T01:00:00Z', 0, -50),
      point('2026-01-01T02:00:00Z', 37.57, 126.98),
    ];
    expect(filterLocationOutliers(points)).toEqual({
      points: [points[0], points[2]],
      removedCount: 1,
    });
  });

  it('removes a short clustered spoofing excursion', () => {
    const points = [
      point('2026-01-01T00:00:00Z', 37.5665, 126.9780),
      point('2026-01-01T01:00:00Z', 0, -50),
      point('2026-01-01T01:10:00Z', .2, -50.1),
      point('2026-01-01T02:00:00Z', 37.57, 126.98),
    ];
    expect(filterLocationOutliers(points)).toEqual({
      points: [points[0], points[3]],
      removedCount: 2,
    });
  });

  it('preserves plausibly timed intercontinental travel', () => {
    const points = [
      point('2026-01-01T00:00:00Z', 37.5665, 126.9780),
      point('2026-01-02T14:00:00Z', -23.5505, -46.6333),
      point('2026-01-10T12:00:00Z', 37.57, 126.98),
    ];
    expect(filterLocationOutliers(points)).toEqual({ points, removedCount: 0 });
  });

  it('returns every point when disabled', () => {
    const points = [
      point('2026-01-01T00:00:00Z', 37.5665, 126.9780),
      point('2026-01-01T01:00:00Z', 0, -50),
      point('2026-01-01T02:00:00Z', 37.57, 126.98),
    ];
    expect(filterLocationOutliers(points, 'off')).toEqual({ points, removedCount: 0 });
  });
});
