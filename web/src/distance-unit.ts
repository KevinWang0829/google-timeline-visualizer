export const DistanceUnit = {
  KILOMETERS: 'kilometers',
  MILES: 'miles',
} as const;

export type DistanceUnit = (typeof DistanceUnit)[keyof typeof DistanceUnit];

export const DistanceUnitPreference = {
  AUTOMATIC: 'automatic',
  KILOMETERS: 'kilometers',
  MILES: 'miles',
} as const;

export type DistanceUnitPreference =
  (typeof DistanceUnitPreference)[keyof typeof DistanceUnitPreference];

export const DEFAULT_DISTANCE_UNIT_PREFERENCE = DistanceUnitPreference.AUTOMATIC;
export const DISTANCE_UNIT_STORAGE_KEY = 'timeline-visualizer.distance-unit';
export const MILES_PER_KILOMETER = 0.621371192237334;

const MILE_REGIONS = new Set(['GB', 'LR', 'MM', 'US']);

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserLocaleTags(): readonly string[] {
  if (typeof navigator !== 'undefined') {
    if (navigator.languages.length > 0) return navigator.languages;
    if (navigator.language) return [navigator.language];
  }
  return [Intl.DateTimeFormat().resolvedOptions().locale];
}

function localeRegion(localeTag: string): string | undefined {
  try {
    const locale = new Intl.Locale(localeTag);
    return (locale.region ?? locale.maximize().region)?.toUpperCase();
  } catch {
    return undefined;
  }
}

export function automaticDistanceUnit(
  localeTags: readonly string[] = browserLocaleTags(),
): DistanceUnit {
  for (const localeTag of localeTags) {
    const region = localeRegion(localeTag);
    if (region) return MILE_REGIONS.has(region) ? DistanceUnit.MILES : DistanceUnit.KILOMETERS;
  }
  return DistanceUnit.KILOMETERS;
}

export function resolveDistanceUnit(
  preference: DistanceUnitPreference,
  localeTags?: readonly string[],
): DistanceUnit {
  if (preference === DistanceUnitPreference.KILOMETERS) return DistanceUnit.KILOMETERS;
  if (preference === DistanceUnitPreference.MILES) return DistanceUnit.MILES;
  return automaticDistanceUnit(localeTags);
}

export function distanceUnitSymbol(unit: DistanceUnit): 'km' | 'mi' {
  return unit === DistanceUnit.MILES ? 'mi' : 'km';
}

export function distanceUnitName(unit: DistanceUnit): '公里' | '英里' {
  return unit === DistanceUnit.MILES ? '英里' : '公里';
}

export function distanceUnitPreferenceLabel(
  preference: DistanceUnitPreference,
  localeTags?: readonly string[],
): string {
  if (preference === DistanceUnitPreference.AUTOMATIC) {
    return `自動 · ${distanceUnitName(resolveDistanceUnit(preference, localeTags))}`;
  }
  return distanceUnitName(resolveDistanceUnit(preference, localeTags));
}

export function distanceFromKilometers(kilometers: number, unit: DistanceUnit): number {
  return kilometers * (unit === DistanceUnit.MILES ? MILES_PER_KILOMETER : 1);
}

export function formatDistance(
  kilometers: number,
  unit: DistanceUnit,
  locale = 'zh-TW',
): string {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  return `${number.format(distanceFromKilometers(kilometers, unit))} ${distanceUnitSymbol(unit)}`;
}

function browserStorage(): PreferenceStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isDistanceUnitPreference(value: string | null): value is DistanceUnitPreference {
  return Object.values(DistanceUnitPreference).some((preference) => preference === value);
}

export function loadDistanceUnitPreference(
  storage: PreferenceStorage | null = browserStorage(),
): DistanceUnitPreference {
  try {
    const stored = storage?.getItem(DISTANCE_UNIT_STORAGE_KEY) ?? null;
    return isDistanceUnitPreference(stored) ? stored : DEFAULT_DISTANCE_UNIT_PREFERENCE;
  } catch {
    return DEFAULT_DISTANCE_UNIT_PREFERENCE;
  }
}

export function saveDistanceUnitPreference(
  preference: DistanceUnitPreference,
  storage: PreferenceStorage | null = browserStorage(),
): void {
  try {
    storage?.setItem(DISTANCE_UNIT_STORAGE_KEY, preference);
  } catch {
    // Storage can be unavailable in private or locked-down browser contexts.
  }
}

export function resetDistanceUnitPreference(storage: PreferenceStorage | null = browserStorage()): void {
  saveDistanceUnitPreference(DEFAULT_DISTANCE_UNIT_PREFERENCE, storage);
}
