import { describe, expect, it } from 'vitest';
import {
  overlayCard,
  overlayStatusLabel,
  requiredTiles,
  tileCanvasRect,
  trailDistanceRanges,
  worldToCanvas,
} from './renderer';
import { DistanceUnit } from './distance-unit';

describe('Android-style renderer geometry', () => {
  it('maps world coordinates with independent canvas width and height', () => {
    const viewport = { minX: 0, maxX: 2, minY: 0.25, maxY: 0.75, zoom: 4 };
    expect(worldToCanvas({ x: 1, y: 0.5 }, viewport, 1_920, 1_080)).toEqual([960, 540]);
  });

  it('maps an already-unwrapped point next to the viewport across the date line', () => {
    const viewport = { minX: 0.9, maxX: 1.1, minY: 0, maxY: 1, zoom: 4 };
    const [x] = worldToCanvas({ x: 1.02, y: 0.5 }, viewport, 1_000, 500);
    expect(x).toBeCloseTo(600, 9);
  });

  it('keeps an unwrapped route continuous across the date line', () => {
    const viewport = { minX: -0.05, maxX: 0.05, minY: 0, maxY: 1, zoom: 4 };
    const [before] = worldToCanvas(
      { x: -0.01, y: 0.5 },
      viewport,
      1_000,
      500,
    );
    const [after] = worldToCanvas(
      { x: 0.01, y: 0.5 },
      viewport,
      1_000,
      500,
    );
    expect(before).toBeCloseTo(400, 9);
    expect(after).toBeCloseTo(600, 9);
  });

  it('keeps low-zoom portrait tile rectangles positive across a world edge', () => {
    const viewport = { minX: 0.15, maxX: 0.83, minY: -0.104, maxY: 1.104, zoom: 2 };
    const rect = tileCanvasRect(3, 1, viewport, 1_080, 1_920);
    expect(viewport.maxX - viewport.minX).toBeGreaterThan(0.5);
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
  });

  it('returns every visible tile when a wide overview needs more than 36', () => {
    const viewport = { minX: -0.75, maxX: 1.75, minY: 0, maxY: 1, zoom: 2 };
    const tiles = requiredTiles(viewport);
    expect(tiles.length).toBe(44);
    expect(tiles.every((tile) => tile.x >= 0 && tile.x < 4)).toBe(true);
  });

  it('uses the 2.5-second trail window and Android 45/30/25 split', () => {
    expect(trailDistanceRanges(12_000, 5_000, 30)).toEqual({
      old: [4_000, 4_450],
      middle: [4_450, 4_750],
      recent: [4_750, 5_000],
    });
  });

  it('clamps the visible trail window to 80–2,000 km', () => {
    expect(trailDistanceRanges(1_000, 500, 1_000).old[0]).toBe(420);
    expect(trailDistanceRanges(100_000, 50_000, 1).old[0]).toBe(48_000);
  });

  it('centers and caps the title card in every Android export shape', () => {
    const square = overlayCard(1_080, 1_080);
    const portrait = overlayCard(1_080, 1_920);
    const landscape = overlayCard(1_920, 1_080);
    for (const [width, height, card] of [
      [1_080, 1_080, square],
      [1_080, 1_920, portrait],
      [1_920, 1_080, landscape],
    ] as const) {
      expect(card.left).toBeGreaterThanOrEqual(0);
      expect(card.right).toBeLessThanOrEqual(width);
      expect(card.top).toBeGreaterThanOrEqual(0);
      expect(card.bottom).toBeLessThanOrEqual(height);
      expect((card.left + card.right) / 2).toBeCloseTo(width / 2, 9);
    }
    expect(landscape.right - landscape.left).toBeCloseTo(square.right - square.left, 9);
    expect(landscape.right - landscape.left).toBeLessThan(1_920 * 0.75);
  });

  it('uses the selected display unit in the preview and video overlay label', () => {
    const august = new Date(2025, 7, 19, 12);
    expect(overlayStatusLabel(august, 'fallback', 100, DistanceUnit.KILOMETERS))
      .toBe('2025年8月  ·  100 km');
    expect(overlayStatusLabel(august, 'fallback', 100, DistanceUnit.MILES))
      .toBe('2025年8月  ·  62 mi');
  });
});
