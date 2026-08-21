import { describe, expect, it } from 'vitest';
import {
  blendViewport,
  buildCameraTrack,
  cameraViewportAt,
  overviewSafeArea,
  overviewViewport,
  worldPositionAtProgress,
} from './camera';
import { cumulativeDistances, project, unwrapWorldPoints } from './geo';
import { requiredTiles } from './renderer';
import type { CameraMovement, GeoPoint } from './types';

function journey(points: Array<[number, number]>) {
  const geoPoints: GeoPoint[] = points.map(([latitude, longitude], index) => ({
    instant: new Date(index * 60_000),
    latitude,
    longitude,
  }));
  const cumulativeDistanceKm = cumulativeDistances(geoPoints);
  return {
    worldPoints: unwrapWorldPoints(geoPoints.map((point) => project(point.latitude, point.longitude))),
    cumulativeDistanceKm,
    totalDistanceKm: cumulativeDistanceKm.at(-1) ?? 0,
  };
}

function center(viewport: ReturnType<typeof cameraViewportAt>): [number, number] {
  return [(viewport.minX + viewport.maxX) / 2, (viewport.minY + viewport.maxY) / 2];
}

describe('camera track', () => {
  const koreanJourney = journey([
    [37.5665, 126.9780],
    [37.4563, 126.7052],
    [36.3504, 127.3845],
    [35.8714, 128.6014],
    [35.1796, 129.0756],
  ]);

  it.each<CameraMovement>(['fixed', 'steady', 'dynamic'])('%s follows the journey instead of freezing', (movement) => {
    const track = buildCameraTrack(koreanJourney, 480, 480, movement);
    const [startX, startY] = center(cameraViewportAt(track, 0));
    const [endX, endY] = center(cameraViewportAt(track, 1));
    expect(Math.hypot(endX - startX, endY - startY)).toBeGreaterThan(0.001);
  });

  it('keeps the marker inside the stable central area', () => {
    const track = buildCameraTrack(koreanJourney, 480, 480, 'dynamic');
    for (let sample = 0; sample <= 40; sample += 1) {
      const progress = sample / 40;
      const viewport = cameraViewportAt(track, progress);
      const marker = worldPositionAtProgress(koreanJourney, progress).point;
      const normalizedX = (marker.x - viewport.minX) / (viewport.maxX - viewport.minX);
      const normalizedY = (marker.y - viewport.minY) / (viewport.maxY - viewport.minY);
      expect(normalizedX).toBeGreaterThanOrEqual(0.299);
      expect(normalizedX).toBeLessThanOrEqual(0.701);
      expect(normalizedY).toBeGreaterThanOrEqual(0.299);
      expect(normalizedY).toBeLessThanOrEqual(0.701);
    }
  });

  it('keeps one zoom span in fixed mode while continuing to pan', () => {
    const track = buildCameraTrack(koreanJourney, 480, 480, 'fixed');
    const spans = [0, 0.2, 0.5, 0.8, 1].map((progress) => {
      const viewport = cameraViewportAt(track, progress);
      return viewport.maxY - viewport.minY;
    });
    spans.forEach((span) => expect(span).toBeCloseTo(spans[0], 12));
  });

  it('uses the short camera path and wrapped tiles across the date line', () => {
    const dateLineJourney = journey([[10, 179], [10.2, -179]]);
    const track = buildCameraTrack(dateLineJourney, 480, 480, 'dynamic');
    const middle = cameraViewportAt(track, 0.5);
    expect(middle.maxX - middle.minX).toBeLessThan(0.05);
    const count = 2 ** middle.zoom;
    requiredTiles(middle).forEach((tile) => {
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.x).toBeLessThan(count);
    });
  });

  it('smooths changing spans and stabilizes integer tile zoom', () => {
    const changingJourney = journey([
      [37.5665, 126.9780],
      [37.5650, 126.9850],
      [35.1796, 129.0756],
      [35.1800, 129.0800],
    ]);
    const track = buildCameraTrack(changingJourney, 480, 480, 'dynamic');
    for (let index = 1; index < track.frames.length; index += 1) {
      const previous = track.frames[index - 1];
      const current = track.frames[index];
      expect(Number.isFinite(current.spanY)).toBe(true);
      expect(Math.abs(Math.log(current.spanY / previous.spanY))).toBeLessThan(0.8);
      expect(Math.abs(current.zoom - previous.zoom)).toBeLessThanOrEqual(3);
    }
  });

  it.each([
    [1_080, 1_920],
    [1_920, 1_080],
  ])('keeps the Android camera aspect at %i×%i', (width, height) => {
    const track = buildCameraTrack(koreanJourney, width, height, 'dynamic');
    expect(track.aspect).toBeCloseTo(width / height, 12);
    for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
      const viewport = cameraViewportAt(track, progress);
      expect((viewport.maxX - viewport.minX) / (viewport.maxY - viewport.minY))
        .toBeCloseTo(width / height, 12);
      const marker = worldPositionAtProgress(koreanJourney, progress).point;
      const normalizedX = (marker.x - viewport.minX) / (viewport.maxX - viewport.minX);
      const normalizedY = (marker.y - viewport.minY) / (viewport.maxY - viewport.minY);
      expect(normalizedX).toBeGreaterThanOrEqual(0.299);
      expect(normalizedX).toBeLessThanOrEqual(0.701);
      expect(normalizedY).toBeGreaterThanOrEqual(0.299);
      expect(normalizedY).toBeLessThanOrEqual(0.701);
    }
  });

  it.each([
    [480, 480],
    [1_080, 1_920],
    [1_920, 1_080],
  ])('fits the overview safe area at %i×%i', (width, height) => {
    const viewport = overviewViewport(koreanJourney, width, height);
    const safe = overviewSafeArea(width, height);
    koreanJourney.worldPoints.forEach((point) => {
      const screenX = (point.x - viewport.minX) / (viewport.maxX - viewport.minX) * width;
      const screenY = (point.y - viewport.minY) / (viewport.maxY - viewport.minY) * height;
      expect(screenX).toBeGreaterThanOrEqual(safe.left);
      expect(screenX).toBeLessThanOrEqual(safe.right);
      expect(screenY).toBeGreaterThanOrEqual(safe.top);
      expect(screenY).toBeLessThanOrEqual(safe.bottom);
    });
  });

  it.each([
    [1_080, 1_920],
    [1_920, 1_080],
  ])('keeps a world-spanning overview undistorted and inside the safe area at %i×%i', (width, height) => {
    const worldSpanningJourney = {
      worldPoints: [
        { x: 0, y: 0.42 },
        { x: 0.5, y: 0.58 },
        { x: 1, y: 0.46 },
      ],
      cumulativeDistanceKm: [0, 10_000, 20_000],
      totalDistanceKm: 20_000,
    };
    const viewport = overviewViewport(worldSpanningJourney, width, height);
    const safe = overviewSafeArea(width, height);

    expect((viewport.maxX - viewport.minX) / (viewport.maxY - viewport.minY))
      .toBeCloseTo(width / height, 12);
    worldSpanningJourney.worldPoints.forEach((point) => {
      const screenX = (point.x - viewport.minX) / (viewport.maxX - viewport.minX) * width;
      const screenY = (point.y - viewport.minY) / (viewport.maxY - viewport.minY) * height;
      expect(screenX).toBeGreaterThanOrEqual(safe.left);
      expect(screenX).toBeLessThanOrEqual(safe.right);
      expect(screenY).toBeGreaterThanOrEqual(safe.top);
      expect(screenY).toBeLessThanOrEqual(safe.bottom);
    });
  });

  it('fits the complete route below the Android-style video header', () => {
    const size = 480;
    const viewport = overviewViewport(koreanJourney, size, size);
    const safe = overviewSafeArea(size, size);
    koreanJourney.worldPoints.forEach((point) => {
      const screenX = (point.x - viewport.minX) / (viewport.maxX - viewport.minX) * size;
      const screenY = (point.y - viewport.minY) / (viewport.maxY - viewport.minY) * size;
      expect(screenX).toBeGreaterThanOrEqual(safe.left);
      expect(screenX).toBeLessThanOrEqual(safe.right);
      expect(screenY).toBeGreaterThanOrEqual(safe.top);
      expect(screenY).toBeLessThanOrEqual(safe.bottom);
    });
  });

  it('calculates the same overview above browser argument limits', () => {
    const endpoints = unwrapWorldPoints([project(70, 20), project(-55, 20)]);
    const denseJourney = {
      worldPoints: Array.from({ length: 200_000 }, (_, index) => endpoints[index % endpoints.length]),
      cumulativeDistanceKm: [],
      totalDistanceKm: 0,
    };
    const endpointJourney = {
      worldPoints: endpoints,
      cumulativeDistanceKm: [],
      totalDistanceKm: 0,
    };

    expect(overviewViewport(denseJourney, 480, 480)).toEqual(overviewViewport(endpointJourney, 480, 480));
  });

  it('builds the moving camera above browser argument limits', () => {
    const point = koreanJourney.worldPoints[0];
    const pointCount = 130_000;
    const denseJourney = {
      worldPoints: Array.from({ length: pointCount }, () => point),
      cumulativeDistanceKm: new Array<number>(pointCount).fill(0),
      totalDistanceKm: 0,
    };

    const track = buildCameraTrack(denseJourney, 480, 480, 'steady');

    expect(track.frames).toHaveLength(481);
    expect(track.frames.every((frame) => Number.isFinite(frame.spanY))).toBe(true);
  });

  it('blends from the final following view to the full-route ending view', () => {
    const track = buildCameraTrack(koreanJourney, 480, 480, 'dynamic');
    const following = cameraViewportAt(track, 1);
    const overview = overviewViewport(koreanJourney, 480, 480);
    expect(blendViewport(following, overview, 0, 480, 480)).toEqual(following);
    const ending = blendViewport(following, overview, 1, 480, 480);
    expect(ending.minX).toBeCloseTo(overview.minX, 12);
    expect(ending.maxX).toBeCloseTo(overview.maxX, 12);
    expect(ending.minY).toBeCloseTo(overview.minY, 12);
    expect(ending.maxY).toBeCloseTo(overview.maxY, 12);
  });

  it('reaches a multi-world unwrapped overview without shifting it by one world', () => {
    const width = 1_080;
    const height = 1_920;
    const multiWorldJourney = {
      worldPoints: [
        { x: 0.1, y: 0.45 },
        { x: 0.8, y: 0.55 },
        { x: 1.4, y: 0.50 },
      ],
      cumulativeDistanceKm: [0, 10_000, 20_000],
      totalDistanceKm: 20_000,
    };
    const overview = overviewViewport(multiWorldJourney, width, height);
    const following = {
      minX: 1.35,
      maxX: 1.45,
      minY: 0.4,
      maxY: 0.4 + 0.1 * height / width,
      zoom: 4,
    };

    expect(blendViewport(following, overview, 1, width, height)).toEqual(overview);
    const middle = blendViewport(following, overview, 0.5, width, height);
    expect((middle.minX + middle.maxX) / 2).toBeLessThan(1.4);
    expect((middle.minY + middle.maxY) / 2).toBeCloseTo(
      ((following.minY + following.maxY) / 2 + (overview.minY + overview.maxY) / 2) / 2,
      12,
    );
    expect((middle.maxX - middle.minX) / (middle.maxY - middle.minY))
      .toBeCloseTo(width / height, 12);
  });
});
