import { describe, expect, it } from 'vitest';
import {
  automaticDistanceUnit,
  DEFAULT_DISTANCE_UNIT_PREFERENCE,
  distanceFromKilometers,
  DistanceUnit,
  DistanceUnitPreference,
  distanceUnitPreferenceLabel,
  formatDistance,
  loadDistanceUnitPreference,
  MILES_PER_KILOMETER,
  resetDistanceUnitPreference,
  resolveDistanceUnit,
  saveDistanceUnitPreference,
} from './distance-unit';
import type { PreferenceStorage } from './distance-unit';

class MemoryStorage implements PreferenceStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('Android v2.2.5 distance units', () => {
  it.each(['en-US', 'en-GB', 'en-LR', 'my-MM'])(
    'uses miles automatically in %s',
    (locale) => expect(automaticDistanceUnit([locale])).toBe(DistanceUnit.MILES),
  );

  it.each(['zh-TW', 'ko-KR', 'ja-JP', 'de-DE'])(
    'uses kilometers automatically in %s',
    (locale) => expect(automaticDistanceUnit([locale])).toBe(DistanceUnit.KILOMETERS),
  );

  it('falls back safely for invalid or missing locale regions', () => {
    expect(automaticDistanceUnit(['not_a_locale'])).toBe(DistanceUnit.KILOMETERS);
    expect(automaticDistanceUnit([])).toBe(DistanceUnit.KILOMETERS);
  });

  it('lets an explicit preference override the locale', () => {
    expect(resolveDistanceUnit(DistanceUnitPreference.KILOMETERS, ['en-US'])).toBe(DistanceUnit.KILOMETERS);
    expect(resolveDistanceUnit(DistanceUnitPreference.MILES, ['zh-TW'])).toBe(DistanceUnit.MILES);
  });

  it('converts only display values with the App multiplier', () => {
    expect(MILES_PER_KILOMETER).toBe(0.621371192237334);
    expect(distanceFromKilometers(100, DistanceUnit.MILES)).toBeCloseTo(62.1371192237334, 12);
    expect(distanceFromKilometers(100, DistanceUnit.KILOMETERS)).toBe(100);
  });

  it('formats rounded Traditional Chinese display values and symbols', () => {
    expect(formatDistance(100, DistanceUnit.MILES)).toBe('62 mi');
    expect(formatDistance(1_234.4, DistanceUnit.KILOMETERS)).toBe('1,234 km');
  });

  it('uses Traditional Chinese preference labels including the automatic resolution', () => {
    expect(distanceUnitPreferenceLabel(DistanceUnitPreference.AUTOMATIC, ['zh-TW'])).toBe('自動 · 公里');
    expect(distanceUnitPreferenceLabel(DistanceUnitPreference.AUTOMATIC, ['en-US'])).toBe('自動 · 英里');
    expect(distanceUnitPreferenceLabel(DistanceUnitPreference.KILOMETERS)).toBe('公里');
    expect(distanceUnitPreferenceLabel(DistanceUnitPreference.MILES)).toBe('英里');
  });

  it('persists the preference and resets it to Automatic', () => {
    const storage = new MemoryStorage();
    expect(loadDistanceUnitPreference(storage)).toBe(DEFAULT_DISTANCE_UNIT_PREFERENCE);
    saveDistanceUnitPreference(DistanceUnitPreference.MILES, storage);
    expect(loadDistanceUnitPreference(storage)).toBe(DistanceUnitPreference.MILES);
    resetDistanceUnitPreference(storage);
    expect(loadDistanceUnitPreference(storage)).toBe(DistanceUnitPreference.AUTOMATIC);
  });

  it('treats unknown or inaccessible stored values as Automatic', () => {
    const storage = new MemoryStorage();
    storage.setItem('timeline-visualizer.distance-unit', 'nautical-miles');
    expect(loadDistanceUnitPreference(storage)).toBe(DistanceUnitPreference.AUTOMATIC);
    const unavailable: PreferenceStorage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    expect(loadDistanceUnitPreference(unavailable)).toBe(DistanceUnitPreference.AUTOMATIC);
    expect(() => saveDistanceUnitPreference(DistanceUnitPreference.MILES, unavailable)).not.toThrow();
  });
});
