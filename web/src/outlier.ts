import { haversineKm } from './geo';
import type { GeoPoint } from './types';

export type LocationFilterMode = 'conservative' | 'off';

export interface LocationFilterResult {
  points: GeoPoint[];
  removedCount: number;
}

const MAX_OUTLIER_RUN_POINTS = 3;
const MIN_OUTLIER_HOP_KM = 500;
const MAX_REJOIN_DISTANCE_KM = 200;
const MAX_OUTLIER_CLUSTER_SPAN_KM = 200;
const MAX_PLAUSIBLE_SPEED_KMH = 1_300;
const MAX_EXCURSION_DURATION_MS = 12 * 60 * 60 * 1_000;

function speedKmPerHour(from: GeoPoint, to: GeoPoint, distanceKm: number): number {
  const milliseconds = to.instant.getTime() - from.instant.getTime();
  if (milliseconds <= 0) return Number.POSITIVE_INFINITY;
  return distanceKm / (milliseconds / 3_600_000);
}

function isSuspiciousExcursion(
  before: GeoPoint,
  points: GeoPoint[],
  start: number,
  end: number,
  after: GeoPoint,
): boolean {
  const windowMs = after.instant.getTime() - before.instant.getTime();
  if (windowMs < 0 || windowMs > MAX_EXCURSION_DURATION_MS) return false;
  if (haversineKm(before, after) > MAX_REJOIN_DISTANCE_KM) return false;

  const first = points[start];
  const last = points[end];
  const ingressKm = haversineKm(before, first);
  const egressKm = haversineKm(last, after);
  if (ingressKm < MIN_OUTLIER_HOP_KM || egressKm < MIN_OUTLIER_HOP_KM) return false;
  if (speedKmPerHour(before, first, ingressKm) <= MAX_PLAUSIBLE_SPEED_KMH) return false;
  if (speedKmPerHour(last, after, egressKm) <= MAX_PLAUSIBLE_SPEED_KMH) return false;

  for (let index = start; index <= end; index += 1) {
    const candidate = points[index];
    if (haversineKm(first, candidate) > MAX_OUTLIER_CLUSTER_SPAN_KM) return false;
    if (
      haversineKm(before, candidate) < MIN_OUTLIER_HOP_KM
      || haversineKm(candidate, after) < MIN_OUTLIER_HOP_KM
    ) return false;
  }
  return true;
}

function suspiciousRunEnd(points: GeoPoint[], before: GeoPoint, start: number): number | null {
  const latestEnd = Math.min(start + MAX_OUTLIER_RUN_POINTS - 1, points.length - 2);
  for (let end = latestEnd; end >= start; end -= 1) {
    if (isSuspiciousExcursion(before, points, start, end, points[end + 1])) return end;
  }
  return null;
}

export function filterLocationOutliers(
  points: GeoPoint[],
  mode: LocationFilterMode = 'conservative',
): LocationFilterResult {
  if (mode === 'off' || points.length < 3) return { points, removedCount: 0 };

  const kept: GeoPoint[] = [points[0]];
  let removedCount = 0;
  let index = 1;
  while (index < points.length - 1) {
    const runEnd = suspiciousRunEnd(points, kept.at(-1)!, index);
    if (runEnd === null) {
      kept.push(points[index]);
      index += 1;
    } else {
      removedCount += runEnd - index + 1;
      index = runEnd + 1;
    }
  }
  kept.push(points.at(-1)!);
  return { points: kept, removedCount };
}
