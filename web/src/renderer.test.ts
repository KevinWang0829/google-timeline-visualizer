import { describe, expect, it } from 'vitest';
import {
  overlayCard,
  overlayStatusLabel,
  trailDistanceRanges,
  worldToCanvas,
} from './renderer';
import { DistanceUnit } from './distance-unit';

describe('Android-style renderer geometry', () => {
  it('maps world coordinates with independent canvas width and height', () => {
    const viewport = { minX: 0, maxX: 2, minY: 0.25, maxY: 0.75, zoom: 4 };
    expect(worldToCanvas({ x: 1, y: 0.5 }, viewport, 1_920, 1_080)).toEqual([960, 540]);
  });

  it('unwraps points next to the viewport across the date line', () => {
    const viewport = { minX: 0.9, maxX: 1.1, minY: 0, maxY: 1, zoom: 4 };
    const [x] = worldToCanvas({ x: 0.02, y: 0.5 }, viewport, 1_000, 500);
    expect(x).toBeCloseTo(600, 9);
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
