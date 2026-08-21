import type { GeoPoint, MonthOption } from './types';

export type TimelineParseReason =
  | 'malformed-json'
  | 'legacy-format'
  | 'raw-signals-only'
  | 'unsupported-format'
  | 'no-usable-locations';

export class TimelineParseError extends Error {
  constructor(
    public readonly reason: TimelineParseReason,
    message: string,
  ) {
    super(message);
    this.name = 'TimelineParseError';
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseCoordinate(value: unknown): [number, number] | null {
  if (isObject(value)) {
    return parseCoordinate(value.latLng ?? value.point);
  }
  if (typeof value !== 'string' || value.trim() === '') return null;

  const cleaned = value
    .trim()
    .replace(/^geo:/, '')
    .split('?', 1)[0]
    .replaceAll('°', '')
    .replaceAll(' ', '');
  const parts = cleaned.split(',');
  if (parts.length < 2) return null;

  let latitude = Number(parts[0]);
  let longitude = Number(parts[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 1_000_000 || Math.abs(longitude) > 1_000_000) {
    latitude /= 10_000_000;
    longitude /= 10_000_000;
  }
  if (latitude < -85.05112878 || latitude > 85.05112878 || longitude < -180 || longitude > 180) {
    return null;
  }
  return [latitude, longitude];
}

interface ParsedInstant {
  instant: Date;
  recordedDate?: string;
  timeZoneMissing: boolean;
}

interface ParsedTimelineSegment {
  anchor: Date | null;
  points: GeoPoint[];
  standalonePath: boolean;
  hasOwnPath: boolean;
}

interface TimeInterval {
  start: number;
  end: number;
}

interface ParsedPathPoint {
  point: GeoPoint;
  offsetMinutes: number | null;
  sourceIndex: number;
}

const SEGMENT_DIRECTION_SIGNAL_MS = 36 * 60 * 60 * 1000;

function parseInstant(value: unknown): ParsedInstant | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const raw = value.trim();
  const timeZoneMissing = !/(?:z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const instant = new Date(timeZoneMissing ? `${raw}Z` : raw);
  if (Number.isNaN(instant.getTime())) return null;
  return {
    instant,
    recordedDate: timeZoneMissing && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : undefined,
    timeZoneMissing,
  };
}

function parseOffsetMinutes(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function parseOffsetInstant(startValue: unknown, endValue: unknown, offsetValue: unknown): Date | null {
  const start = parseInstant(startValue);
  const offsetMinutes = parseOffsetMinutes(offsetValue);
  if (!start || offsetMinutes === null) return null;
  const timestamp = start.instant.getTime() + offsetMinutes * 60_000;
  if (!Number.isSafeInteger(timestamp)) return null;
  const instant = new Date(timestamp);
  if (Number.isNaN(instant.getTime())) return null;
  const end = parseInstant(endValue);
  if (
    end
    && !start.timeZoneMissing
    && !end.timeZoneMissing
    && instant.getTime() > end.instant.getTime() + 60_000
  ) return null;
  return instant;
}

function addPoint(output: GeoPoint[], time: unknown, coordinate: unknown): GeoPoint | null {
  const parsedTime = parseInstant(time);
  const parsed = parseCoordinate(coordinate);
  if (!parsedTime || !parsed) return null;
  const point: GeoPoint = {
    instant: parsedTime.instant,
    latitude: parsed[0],
    longitude: parsed[1],
    recordedDate: parsedTime.recordedDate,
    timeZoneMissing: parsedTime.timeZoneMissing,
  };
  output.push(point);
  return point;
}

function orderPathPoints(points: ParsedPathPoint[]): GeoPoint[] {
  const allTimezoneAware = points.every(({ point }) => !point.timeZoneMissing);
  const allHaveOffsets = points.every(({ offsetMinutes }) => offsetMinutes !== null);
  if (!allTimezoneAware && !allHaveOffsets) return points.map(({ point }) => point);

  return [...points]
    .sort((left, right) => {
      const leftOrder = allTimezoneAware ? left.point.instant.getTime() : left.offsetMinutes!;
      const rightOrder = allTimezoneAware ? right.point.instant.getTime() : right.offsetMinutes!;
      return leftOrder - rightOrder || left.sourceIndex - right.sourceIndex;
    })
    .map(({ point }) => point);
}

function mergeIntervals(intervals: TimeInterval[]): TimeInterval[] {
  const sorted = [...intervals].sort((left, right) => left.start - right.start);
  const merged: TimeInterval[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || interval.start > previous.end) {
      merged.push({ ...interval });
    } else if (interval.end > previous.end) {
      previous.end = interval.end;
    }
  }
  return merged;
}

function isCovered(point: GeoPoint, intervals: TimeInterval[]): boolean {
  if (point.timeZoneMissing) return false;
  const timestamp = point.instant.getTime();
  let low = 0;
  let high = intervals.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const interval = intervals[middle];
    if (timestamp < interval.start) high = middle - 1;
    else if (timestamp > interval.end) low = middle + 1;
    else return true;
  }
  return false;
}

function preferStandaloneDetail(segments: ParsedTimelineSegment[]): ParsedTimelineSegment[] {
  const detailCoverage = mergeIntervals(segments.flatMap((segment): TimeInterval[] => {
    if (
      !segment.standalonePath
      || segment.points.length < 2
      || segment.points.some((point) => point.timeZoneMissing)
    ) return [];
    return [{
      start: segment.points[0].instant.getTime(),
      end: segment.points.at(-1)!.instant.getTime(),
    }];
  }));

  for (const segment of segments) {
    if (segment.standalonePath || segment.hasOwnPath) continue;
    segment.points = segment.points.filter((point) => !isCovered(point, detailCoverage));
  }
  return segments.filter((segment) => segment.points.length > 0);
}

function normalizeSegmentDirection(segments: ParsedTimelineSegment[]): ParsedTimelineSegment[] {
  const anchors = segments
    .map((segment) => segment.anchor?.getTime())
    .filter((timestamp): timestamp is number => timestamp !== undefined);
  let ascendingSignals = 0;
  let descendingSignals = 0;
  for (let index = 1; index < anchors.length; index += 1) {
    const delta = anchors[index] - anchors[index - 1];
    if (Math.abs(delta) < SEGMENT_DIRECTION_SIGNAL_MS) continue;
    if (delta > 0) ascendingSignals += 1;
    else descendingSignals += 1;
  }
  const endpointDelta = (anchors.at(-1) ?? 0) - (anchors[0] ?? 0);
  if (Math.abs(endpointDelta) >= SEGMENT_DIRECTION_SIGNAL_MS) {
    if (endpointDelta > 0) ascendingSignals += 2;
    else descendingSignals += 2;
  }
  return descendingSignals > ascendingSignals ? [...segments].reverse() : segments;
}

export function parseTimelineJson(data: unknown): GeoPoint[] {
  let segments: unknown[];
  if (Array.isArray(data)) {
    segments = data;
  } else if (isObject(data) && Array.isArray(data.semanticSegments)) {
    segments = data.semanticSegments;
  } else if (isObject(data) && ('timelineObjects' in data || 'locations' in data)) {
    throw new TimelineParseError(
      'legacy-format',
      'This is an older Google Takeout format. Export Timeline data from your phone instead.',
    );
  } else if (isObject(data) && 'rawSignals' in data) {
    throw new TimelineParseError(
      'raw-signals-only',
      'This export contains raw signals but no reconstructed Timeline journeys.',
    );
  } else {
    throw new TimelineParseError(
      'unsupported-format',
      'Timeline JSON must be an array or contain semanticSegments.',
    );
  }

  const parsedSegments: ParsedTimelineSegment[] = [];
  for (const rawSegment of segments) {
    if (!isObject(rawSegment)) continue;
    const startTime = rawSegment.startTime;
    const endTime = rawSegment.endTime;
    const segmentPoints: GeoPoint[] = [];
    let semanticPointAdded = false;
    let parsedPathPointCount = 0;

    if (isObject(rawSegment.activity)) {
      semanticPointAdded = addPoint(segmentPoints, startTime, rawSegment.activity.start) !== null
        || semanticPointAdded;
    }

    if (isObject(rawSegment.visit) && isObject(rawSegment.visit.topCandidate)) {
      semanticPointAdded = addPoint(segmentPoints, startTime, rawSegment.visit.topCandidate.placeLocation) !== null
        || semanticPointAdded;
    }

    if (Array.isArray(rawSegment.timelinePath)) {
      const pathPoints: ParsedPathPoint[] = [];
      for (const [sourceIndex, rawPathPoint] of rawSegment.timelinePath.entries()) {
        if (!isObject(rawPathPoint)) continue;
        const absolute = parseInstant(rawPathPoint.time);
        const offsetMinutes = parseOffsetMinutes(rawPathPoint.durationMinutesOffsetFromStartTime);
        const offsetInstant = parseOffsetInstant(startTime, endTime, offsetMinutes);
        const coordinate = parseCoordinate(rawPathPoint.point);
        if ((absolute || offsetInstant) && coordinate) {
          const segmentStart = absolute ? null : parseInstant(startTime);
          pathPoints.push({
            point: {
              instant: absolute?.instant ?? offsetInstant!,
              latitude: coordinate[0],
              longitude: coordinate[1],
              recordedDate: absolute?.recordedDate
                ?? (segmentStart?.timeZoneMissing ? offsetInstant?.toISOString().slice(0, 10) : undefined),
              timeZoneMissing: absolute?.timeZoneMissing ?? segmentStart?.timeZoneMissing ?? false,
            },
            offsetMinutes,
            sourceIndex,
          });
        }
      }
      parsedPathPointCount = pathPoints.length;
      segmentPoints.push(...orderPathPoints(pathPoints));
    }

    if (isObject(rawSegment.activity)) {
      semanticPointAdded = addPoint(segmentPoints, endTime, rawSegment.activity.end) !== null
        || semanticPointAdded;
    }
    if (segmentPoints.length > 0) {
      parsedSegments.push({
        anchor: parseInstant(startTime)?.instant ?? segmentPoints[0].instant,
        points: segmentPoints,
        standalonePath: parsedPathPointCount > 0 && !semanticPointAdded,
        hasOwnPath: parsedPathPointCount > 0 && semanticPointAdded,
      });
    }
  }

  // Some exports append a detailed path history alongside coarse activities and
  // visits. Keep that path in place and suppress only covered semantic anchors.
  const reconciled = preferStandaloneDetail(parsedSegments);
  const points = normalizeSegmentDirection(reconciled).flatMap((segment) => segment.points);
  const unique = new Map<string, GeoPoint>();
  for (const point of points) {
    const key = `${point.instant.getTime()}:${point.latitude}:${point.longitude}`;
    unique.set(key, point);
  }
  const deduplicated = [...unique.values()];
  const normalized = deduplicated.some((point) => point.timeZoneMissing)
    ? deduplicated
    : deduplicated.sort((a, b) => a.instant.getTime() - b.instant.getTime());
  if (normalized.length === 0) {
    throw new TimelineParseError(
      'no-usable-locations',
      'This Timeline export contains no usable location points.',
    );
  }
  return normalized;
}

export function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function pointDateKey(point: GeoPoint): string {
  return point.recordedDate ?? localDateKey(point.instant);
}

function pointMonthKey(point: GeoPoint): string {
  return pointDateKey(point).slice(0, 7);
}

export function availableMonths(points: GeoPoint[]): MonthOption[] {
  const formatter = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
  const keys = [...new Set(points.map(pointMonthKey))].sort();
  return keys.map((key) => {
    const [year, month] = key.split('-').map(Number);
    return { key, label: formatter.format(new Date(year, month - 1, 1)) };
  });
}

export function selectRange(points: GeoPoint[], startMonth: string, endMonth: string): GeoPoint[] {
  return points.filter((point) => {
    const key = pointMonthKey(point);
    return key >= startMonth && key <= endMonth;
  });
}

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function selectDateRange(points: GeoPoint[], startDate: string, endDate: string): GeoPoint[] {
  return points.filter((point) => {
    const key = pointDateKey(point);
    return key >= startDate && key <= endDate;
  });
}
