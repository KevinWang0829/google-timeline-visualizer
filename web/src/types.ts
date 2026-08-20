import type { JourneyTiming, LongTripCompression } from './journey-timing';

export interface GeoPoint {
  instant: Date;
  latitude: number;
  longitude: number;
  recordedDate?: string;
  timeZoneMissing?: boolean;
}

export interface MonthOption {
  key: string;
  label: string;
}

export interface WorldPoint {
  x: number;
  y: number;
}

export interface Viewport {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  zoom: number;
}

export type CameraMovement = 'fixed' | 'steady' | 'dynamic';

export interface CameraFrame {
  centerX: number;
  centerY: number;
  spanY: number;
  zoom: number;
}

export interface CameraTrack {
  frames: CameraFrame[];
  aspect: number;
}

export interface TimelineFrame {
  journeyProgress: number;
  outroProgress: number;
}

export interface PreparedJourney {
  points: GeoPoint[];
  worldPoints: WorldPoint[];
  renderWorldPoints: WorldPoint[];
  renderCumulativeDistanceKm: number[];
  overviewRouteSegments: WorldPoint[][];
  cumulativeDistanceKm: number[];
  totalDistanceKm: number;
  timing: JourneyTiming;
  longTripCompression: LongTripCompression;
  journeyDurationSeconds: number;
  renderWidth: number;
  renderHeight: number;
  cameraTrack: CameraTrack;
  overviewViewport: Viewport;
  tiles: Map<string, HTMLImageElement>;
}
