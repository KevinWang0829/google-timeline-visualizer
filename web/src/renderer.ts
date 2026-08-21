import { easeInOutCubic, easeOutCubic } from './animation';
import { DistanceUnit as DistanceUnits, formatDistance } from './distance-unit';
import type { DistanceUnit } from './distance-unit';
import {
  blendViewport,
  buildCameraTrack,
  cameraViewportAt,
  overviewViewport,
} from './camera';
import type { CameraJourney, WorldPosition } from './camera';
import { cumulativeDistances, project, unwrapWorldPoints } from './geo';
import {
  DEFAULT_LONG_TRIP_COMPRESSION,
  JourneyTiming,
} from './journey-timing';
import type { LongTripCompression } from './journey-timing';
import type {
  CameraMovement,
  GeoPoint,
  PreparedJourney,
  TimelineFrame,
  Viewport,
  WorldPoint,
} from './types';

const TILE_TEMPLATE = 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png';
const TRAIL_VISIBLE_SECONDS = 2.5;
const MIN_TRAIL_KM = 80;
const MAX_TRAIL_KM = 2_000;
const MIN_ROUTE_PIXEL_SPACING = 1.35;
const OVERVIEW_ROUTE_ALPHA = 190 / 255;
const CARD_TOP = 28;
const CARD_SIDE_INSET = 34;
const MAX_CARD_WIDTH = 720 - CARD_SIDE_INSET * 2;
const OVERLAY_BOTTOM = 132;
const MAX_RENDER_STEP_KM = 75;
const MAX_STEPS_PER_SEGMENT = 320;

const monthFormatter = new Intl.DateTimeFormat('zh-TW', {
  month: 'long',
  year: 'numeric',
});

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function unwrapNear(value: number, reference: number): number {
  let result = value;
  while (result - reference > 0.5) result -= 1;
  while (result - reference < -0.5) result += 1;
  return result;
}

export function worldToCanvas(
  point: WorldPoint,
  viewport: Viewport,
  width: number,
  height: number,
): [number, number] {
  return [
    ((point.x - viewport.minX) / (viewport.maxX - viewport.minX)) * width,
    ((point.y - viewport.minY) / (viewport.maxY - viewport.minY)) * height,
  ];
}

export interface TileCanvasRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function tileCanvasRect(
  tileX: number,
  tileY: number,
  viewport: Viewport,
  width: number,
  height: number,
): TileCanvasRect {
  const tileCount = 2 ** viewport.zoom;
  const left = ((tileX / tileCount - viewport.minX) / (viewport.maxX - viewport.minX)) * width;
  const right = (((tileX + 1) / tileCount - viewport.minX) / (viewport.maxX - viewport.minX)) * width;
  const top = ((tileY / tileCount - viewport.minY) / (viewport.maxY - viewport.minY)) * height;
  const bottom = (((tileY + 1) / tileCount - viewport.minY) / (viewport.maxY - viewport.minY)) * height;
  return {
    left,
    top,
    width: right - left + 1,
    height: bottom - top + 1,
  };
}

interface TileCoordinate {
  zoom: number;
  x: number;
  y: number;
}

function tileKey(tile: TileCoordinate): string {
  return `${tile.zoom}/${tile.x}/${tile.y}`;
}

function loadImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    const cleanup = (): void => signal?.removeEventListener('abort', abort);
    const abort = (): void => {
      image.src = '';
      cleanup();
      reject(new DOMException('Video creation was cancelled.', 'AbortError'));
    };
    image.onload = () => {
      cleanup();
      resolve(image);
    };
    image.onerror = () => {
      cleanup();
      reject(new Error(`Could not load map tile ${url}`));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    image.src = url;
  });
}

export function requiredTiles(viewport: Viewport): TileCoordinate[] {
  const tileCount = 2 ** viewport.zoom;
  const minTileX = Math.floor(viewport.minX * tileCount);
  const maxTileX = Math.floor(viewport.maxX * tileCount);
  const minTileY = clamp(Math.floor(viewport.minY * tileCount), 0, tileCount - 1);
  const maxTileY = clamp(Math.floor(viewport.maxY * tileCount), 0, tileCount - 1);
  const tiles: TileCoordinate[] = [];
  for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
    for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
      tiles.push({
        zoom: viewport.zoom,
        x: ((tileX % tileCount) + tileCount) % tileCount,
        y: tileY,
      });
    }
  }
  return tiles;
}

function drawMapBackground(
  canvas: HTMLCanvasElement,
  viewport: Viewport,
  tiles: Map<string, HTMLImageElement>,
): void {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas rendering is unavailable.');
  const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, '#faf6f7');
  gradient.addColorStop(1, '#e0e8ef');
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  const tileCount = 2 ** viewport.zoom;
  const minTileX = Math.floor(viewport.minX * tileCount);
  const maxTileX = Math.floor(viewport.maxX * tileCount);
  const minTileY = clamp(Math.floor(viewport.minY * tileCount), 0, tileCount - 1);
  const maxTileY = clamp(Math.floor(viewport.maxY * tileCount), 0, tileCount - 1);

  for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
    for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
      const wrappedX = ((tileX % tileCount) + tileCount) % tileCount;
      const image = tiles.get(tileKey({ zoom: viewport.zoom, x: wrappedX, y: tileY }));
      if (!image) continue;
      const rect = tileCanvasRect(tileX, tileY, viewport, canvas.width, canvas.height);
      context.drawImage(image, rect.left, rect.top, rect.width, rect.height);
    }
  }
}

async function loadRequiredTiles(
  coordinates: TileCoordinate[],
  signal?: AbortSignal,
  onProgress?: (completed: number, total: number) => void,
): Promise<Map<string, HTMLImageElement>> {
  const tiles = new Map<string, HTMLImageElement>();
  let nextIndex = 0;
  let completed = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < coordinates.length) {
      if (signal?.aborted) throw new DOMException('Video creation was cancelled.', 'AbortError');
      const coordinate = coordinates[nextIndex];
      nextIndex += 1;
      const url = TILE_TEMPLATE.replace('{z}', String(coordinate.zoom))
        .replace('{x}', String(coordinate.x))
        .replace('{y}', String(coordinate.y));
      try {
        tiles.set(tileKey(coordinate), await loadImage(url, signal));
      } catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
      }
      completed += 1;
      onProgress?.(completed, coordinates.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, coordinates.length) }, worker));
  return tiles;
}

function interpolateGeoPoint(a: GeoPoint, b: GeoPoint, fraction: number): GeoPoint {
  if (fraction <= 0) return a;
  if (fraction >= 1) return b;
  const lat1 = a.latitude * Math.PI / 180;
  const lon1 = a.longitude * Math.PI / 180;
  const lat2 = b.latitude * Math.PI / 180;
  const lon2 = b.longitude * Math.PI / 180;
  const ax = Math.cos(lat1) * Math.cos(lon1);
  const ay = Math.cos(lat1) * Math.sin(lon1);
  const az = Math.sin(lat1);
  const bx = Math.cos(lat2) * Math.cos(lon2);
  const by = Math.cos(lat2) * Math.sin(lon2);
  const bz = Math.sin(lat2);
  const dot = clamp(ax * bx + ay * by + az * bz, -1, 1);
  const omega = Math.acos(dot);
  const sine = Math.sin(omega);
  const left = Math.abs(sine) < 1e-8 ? 1 - fraction : Math.sin((1 - fraction) * omega) / sine;
  const right = Math.abs(sine) < 1e-8 ? fraction : Math.sin(fraction * omega) / sine;
  const x = left * ax + right * bx;
  const y = left * ay + right * by;
  const z = left * az + right * bz;
  return {
    instant: new Date(a.instant.getTime() + (b.instant.getTime() - a.instant.getTime()) * fraction),
    latitude: Math.atan2(z, Math.sqrt(x * x + y * y)) * 180 / Math.PI,
    longitude: Math.atan2(y, x) * 180 / Math.PI,
  };
}

interface RenderPath {
  worldPoints: WorldPoint[];
  cumulativeDistanceKm: number[];
}

function buildRenderPath(points: GeoPoint[], distances: number[]): RenderPath {
  if (points.length === 0) return { worldPoints: [], cumulativeDistanceKm: [] };
  const worldPoints: WorldPoint[] = [project(points[0].latitude, points[0].longitude)];
  const renderDistances = [0];
  for (let toIndex = 1; toIndex < points.length; toIndex += 1) {
    const startDistance = distances[toIndex - 1];
    const segmentDistance = distances[toIndex] - startDistance;
    const steps = clamp(Math.ceil(segmentDistance / MAX_RENDER_STEP_KM), 1, MAX_STEPS_PER_SEGMENT);
    for (let step = 1; step <= steps; step += 1) {
      const fraction = step / steps;
      const point = interpolateGeoPoint(points[toIndex - 1], points[toIndex], fraction);
      const projected = project(point.latitude, point.longitude);
      projected.x = unwrapNear(projected.x, worldPoints.at(-1)?.x ?? projected.x);
      worldPoints.push(projected);
      renderDistances.push(startDistance + segmentDistance * fraction);
    }
  }
  return { worldPoints, cumulativeDistanceKm: renderDistances };
}

function positionAtDistance(
  points: readonly GeoPoint[],
  worldPoints: readonly WorldPoint[],
  cumulativeDistanceKm: readonly number[],
  totalDistanceKm: number,
  distanceKm: number,
): WorldPosition {
  if (points.length === 0) {
    return {
      point: { x: 0.5, y: 0.5 },
      distanceKm: 0,
      fromIndex: 0,
      toIndex: 0,
      segmentFraction: 0,
    };
  }
  if (points.length === 1 || totalDistanceKm <= 0) {
    return {
      point: worldPoints[0],
      distanceKm: 0,
      fromIndex: 0,
      toIndex: 0,
      segmentFraction: 0,
    };
  }
  const target = clamp(distanceKm, 0, totalDistanceKm);
  const exact = lowerBound(cumulativeDistanceKm, target);
  if (exact < cumulativeDistanceKm.length && cumulativeDistanceKm[exact] === target) {
    return {
      point: worldPoints[exact],
      distanceKm: target,
      fromIndex: exact,
      toIndex: exact,
      segmentFraction: 0,
    };
  }
  const toIndex = clamp(exact, 1, points.length - 1);
  const fromIndex = toIndex - 1;
  const segmentDistance = cumulativeDistanceKm[toIndex] - cumulativeDistanceKm[fromIndex];
  const segmentFraction = segmentDistance <= 0
    ? 0
    : clamp((target - cumulativeDistanceKm[fromIndex]) / segmentDistance, 0, 1);
  const geoPoint = interpolateGeoPoint(points[fromIndex], points[toIndex], segmentFraction);
  const projected = project(geoPoint.latitude, geoPoint.longitude);
  const referenceX = worldPoints[fromIndex].x
    + (worldPoints[toIndex].x - worldPoints[fromIndex].x) * segmentFraction;
  projected.x = unwrapNear(projected.x, referenceX);
  return { point: projected, distanceKm: target, fromIndex, toIndex, segmentFraction };
}

export async function prepareJourney(
  points: GeoPoint[],
  width = 480,
  height = width,
  cameraMovement: CameraMovement = 'steady',
  longTripCompression: LongTripCompression = DEFAULT_LONG_TRIP_COMPRESSION,
  durationSeconds = 30,
  signal?: AbortSignal,
  onProgress?: (completed: number, total: number) => void,
): Promise<PreparedJourney> {
  if (points.length < 2) throw new Error('Select a period containing at least two location points.');
  if (width <= 0 || height <= 0) throw new Error('Video dimensions must be positive.');
  const worldPoints = unwrapWorldPoints(points.map((point) => project(point.latitude, point.longitude)));
  const distances = cumulativeDistances(points);
  const totalDistanceKm = distances.at(-1) ?? 0;
  const timing = JourneyTiming.create({ points, cumulativeDistanceKm: distances, totalDistanceKm }, longTripCompression);
  const renderPath = buildRenderPath(points, distances);
  const position = (distanceKm: number): WorldPosition => positionAtDistance(
    points,
    worldPoints,
    distances,
    totalDistanceKm,
    distanceKm,
  );
  const camera: CameraJourney = {
    worldPoints,
    cumulativeDistanceKm: distances,
    totalDistanceKm,
    timing,
    renderWorldPoints: renderPath.worldPoints,
    renderCumulativeDistanceKm: renderPath.cumulativeDistanceKm,
    legCumulativeDistanceKm: distances,
    positionAtDistance: position,
  };
  const cameraTrack = buildCameraTrack(camera, width, height, cameraMovement);
  const endingOverview = overviewViewport(camera, width, height);
  const sampleCount = Math.max(
    20,
    Math.min(durationSeconds * 8, Math.max(durationSeconds * 2, Math.ceil(totalDistanceKm / 250))),
  );
  const required = new Map<string, TileCoordinate>();
  for (let sample = 0; sample <= sampleCount; sample += 1) {
    for (const tile of requiredTiles(cameraViewportAt(cameraTrack, sample / sampleCount))) {
      required.set(tileKey(tile), tile);
    }
  }
  const journeyEnd = cameraViewportAt(cameraTrack, 1);
  for (let sample = 0; sample <= 12; sample += 1) {
    const ending = blendViewport(
      journeyEnd,
      endingOverview,
      easeOutCubic(sample / 12),
      width,
      height,
    );
    for (const tile of requiredTiles(ending)) required.set(tileKey(tile), tile);
  }
  const tiles = await loadRequiredTiles([...required.values()], signal, onProgress);
  return {
    points,
    worldPoints,
    renderWorldPoints: renderPath.worldPoints,
    renderCumulativeDistanceKm: renderPath.cumulativeDistanceKm,
    overviewRouteSegments: [renderPath.worldPoints],
    cumulativeDistanceKm: distances,
    totalDistanceKm,
    timing,
    longTripCompression,
    journeyDurationSeconds: durationSeconds,
    renderWidth: width,
    renderHeight: height,
    cameraTrack,
    overviewViewport: endingOverview,
    tiles,
  };
}

export interface TrailDistanceRanges {
  old: readonly [number, number];
  middle: readonly [number, number];
  recent: readonly [number, number];
}

export function trailDistanceRanges(
  totalDistanceKm: number,
  currentDistanceKm: number,
  journeyDurationSeconds: number,
): TrailDistanceRanges {
  const total = Math.max(0, totalDistanceKm);
  const current = clamp(currentDistanceKm, 0, total);
  const rawWindow = total <= 0 ? 0 : total * TRAIL_VISIBLE_SECONDS / Math.max(1, journeyDurationSeconds);
  const trailWindow = Math.min(total, total <= 0 ? 0 : clamp(rawWindow, MIN_TRAIL_KM, MAX_TRAIL_KM));
  const trailStart = Math.max(0, current - trailWindow);
  const visibleTrail = current - trailStart;
  const oldEnd = trailStart + visibleTrail * 0.45;
  const middleEnd = trailStart + visibleTrail * 0.75;
  return {
    old: [trailStart, Math.min(oldEnd, current)],
    middle: [Math.min(oldEnd, current), Math.min(middleEnd, current)],
    recent: [Math.min(middleEnd, current), current],
  };
}

interface StrokeOptions {
  color: string;
  width: number;
  alpha: number;
}

function drawRouteRange(
  context: CanvasRenderingContext2D,
  journey: PreparedJourney,
  viewport: Viewport,
  width: number,
  height: number,
  startDistanceKm: number,
  endDistanceKm: number,
  stroke: StrokeOptions,
): void {
  if (endDistanceKm <= startDistanceKm || journey.renderWorldPoints.length === 0 || stroke.alpha <= 0) return;
  const start = positionAtDistance(
    journey.points,
    journey.worldPoints,
    journey.cumulativeDistanceKm,
    journey.totalDistanceKm,
    startDistanceKm,
  );
  const end = positionAtDistance(
    journey.points,
    journey.worldPoints,
    journey.cumulativeDistanceKm,
    journey.totalDistanceKm,
    endDistanceKm,
  );
  const firstIndex = Math.min(
    lowerBound(journey.renderCumulativeDistanceKm, startDistanceKm),
    journey.renderWorldPoints.length - 1,
  );
  const lastIndex = upperBound(journey.renderCumulativeDistanceKm, endDistanceKm) - 1;
  const [startX, startY] = worldToCanvas(start.point, viewport, width, height);
  const [endX, endY] = worldToCanvas(end.point, viewport, width, height);
  context.save();
  context.beginPath();
  context.moveTo(startX, startY);
  let lastX = startX;
  let lastY = startY;
  for (let index = firstIndex; index <= lastIndex && index < journey.renderWorldPoints.length; index += 1) {
    const [x, y] = worldToCanvas(journey.renderWorldPoints[index], viewport, width, height);
    const dx = x - lastX;
    const dy = y - lastY;
    if (dx * dx + dy * dy >= MIN_ROUTE_PIXEL_SPACING * MIN_ROUTE_PIXEL_SPACING) {
      context.lineTo(x, y);
      lastX = x;
      lastY = y;
    }
  }
  context.lineTo(endX, endY);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = stroke.color;
  context.lineWidth = stroke.width;
  context.globalAlpha = stroke.alpha;
  context.stroke();
  context.restore();
}

export interface OverlayCard {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function overlayScale(width: number, height: number): number {
  return Math.min(width, height) / 720;
}

export function overlayCard(width: number, height: number): OverlayCard {
  const scale = overlayScale(width, height);
  const cardWidth = Math.min(width - CARD_SIDE_INSET * 2 * scale, MAX_CARD_WIDTH * scale);
  const left = (width - cardWidth) / 2;
  return {
    left,
    top: CARD_TOP * scale,
    right: left + cardWidth,
    bottom: OVERLAY_BOTTOM * scale,
  };
}

function fitTitle(
  context: CanvasRenderingContext2D,
  title: string,
  availableWidth: number,
  scale: number,
): { text: string; size: number } {
  let size = 34 * scale;
  const minimum = 20 * scale;
  const font = (): void => {
    context.font = `700 ${size}px -apple-system, BlinkMacSystemFont, sans-serif`;
  };
  font();
  while (size > minimum && context.measureText(title).width > availableWidth) {
    size = Math.max(minimum, size - scale);
    font();
  }
  if (context.measureText(title).width <= availableWidth) return { text: title, size };
  const characters = Array.from(title);
  const ellipsis = '…';
  const textWidth = Math.max(0, availableWidth - context.measureText(ellipsis).width);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (context.measureText(characters.slice(0, middle).join('')).width <= textWidth) low = middle;
    else high = middle - 1;
  }
  return { text: `${characters.slice(0, Math.max(1, low)).join('').trimEnd()}${ellipsis}`, size };
}

function currentGeoPoint(journey: PreparedJourney, position: WorldPosition): GeoPoint {
  if (position.fromIndex === position.toIndex) return journey.points[position.fromIndex] ?? journey.points[0];
  return interpolateGeoPoint(
    journey.points[position.fromIndex],
    journey.points[position.toIndex],
    position.segmentFraction,
  );
}

export function overlayStatusLabel(
  instant: Date,
  fallbackPeriodLabel: string,
  distanceKm: number,
  distanceUnit: DistanceUnit,
): string {
  const month = Number.isNaN(instant.getTime())
    ? fallbackPeriodLabel
    : monthFormatter.format(instant);
  return `${month}  ·  ${formatDistance(distanceKm, distanceUnit)}`;
}

function drawOverlay(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  journey: PreparedJourney,
  position: WorldPosition,
  title: string,
  fallbackPeriodLabel: string,
  distanceUnit: DistanceUnit,
): void {
  const scale = overlayScale(width, height);
  const card = overlayCard(width, height);
  context.save();
  context.fillStyle = 'rgba(255, 248, 250, 0.862745)';
  context.beginPath();
  context.roundRect(
    card.left,
    card.top,
    card.right - card.left,
    card.bottom - card.top,
    24 * scale,
  );
  context.fill();
  context.textAlign = 'center';
  const displayTitle = title || 'My Journey';
  const fitted = fitTitle(context, displayTitle, card.right - card.left - 36 * scale, scale);
  context.fillStyle = '#24191d';
  context.font = `700 ${fitted.size}px -apple-system, BlinkMacSystemFont, sans-serif`;
  context.fillText(fitted.text, (card.left + card.right) / 2, 72 * scale);

  const geoPoint = currentGeoPoint(journey, position);
  context.fillStyle = '#5c4b52';
  context.font = `${20 * scale}px -apple-system, BlinkMacSystemFont, sans-serif`;
  context.fillText(
    overlayStatusLabel(
      geoPoint.instant,
      fallbackPeriodLabel,
      position.distanceKm,
      distanceUnit,
    ),
    (card.left + card.right) / 2,
    108 * scale,
  );

  context.textAlign = 'right';
  context.fillStyle = 'rgba(36, 25, 29, 0.72549)';
  context.font = `${13 * scale}px -apple-system, BlinkMacSystemFont, sans-serif`;
  context.fillText('© OpenStreetMap  © CARTO', width - 12 * scale, height - 12 * scale);
  context.restore();
}

export function drawFrame(
  canvas: HTMLCanvasElement,
  journey: PreparedJourney,
  frame: TimelineFrame,
  title: string,
  periodLabel: string,
  distanceUnit: DistanceUnit = DistanceUnits.KILOMETERS,
): void {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas rendering is unavailable.');
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);
  const journeyViewport = cameraViewportAt(journey.cameraTrack, frame.journeyProgress);
  const viewport = frame.outroProgress <= 0
    ? journeyViewport
    : blendViewport(
      journeyViewport,
      journey.overviewViewport,
      easeOutCubic(frame.outroProgress),
      width,
      height,
    );
  drawMapBackground(canvas, viewport, journey.tiles);

  const currentDistance = journey.timing.distanceAt(clamp(frame.journeyProgress, 0, 1));
  const current = positionAtDistance(
    journey.points,
    journey.worldPoints,
    journey.cumulativeDistanceKm,
    journey.totalDistanceKm,
    currentDistance,
  );
  const activeAlpha = 1 - easeOutCubic(frame.outroProgress);
  const ranges = trailDistanceRanges(
    journey.totalDistanceKm,
    current.distanceKm,
    journey.journeyDurationSeconds,
  );
  drawRouteRange(context, journey, viewport, width, height, ...ranges.old, {
    color: '#e90064', width: 4, alpha: activeAlpha * (55 / 255),
  });
  drawRouteRange(context, journey, viewport, width, height, ...ranges.middle, {
    color: '#e90064', width: 6, alpha: activeAlpha * (135 / 255),
  });
  drawRouteRange(context, journey, viewport, width, height, ...ranges.recent, {
    color: '#e90064', width: 8, alpha: activeAlpha,
  });

  if (frame.outroProgress > 0) {
    drawRouteRange(
      context,
      journey,
      viewport,
      width,
      height,
      0,
      journey.totalDistanceKm,
      {
        color: '#e90064',
        width: 3.5,
        alpha: OVERVIEW_ROUTE_ALPHA * easeInOutCubic(frame.outroProgress),
      },
    );
  }

  if (activeAlpha > 0) {
    const [headX, headY] = worldToCanvas(current.point, viewport, width, height);
    const markerEdge = Math.min(width, height);
    context.save();
    context.globalAlpha = activeAlpha;
    context.shadowColor = 'rgba(0, 0, 0, 0.352941)';
    context.shadowBlur = 8;
    context.shadowOffsetY = 2;
    context.fillStyle = '#24191d';
    context.beginPath();
    context.arc(headX, headY, markerEdge * 0.013, 0, Math.PI * 2);
    context.fill();
    context.shadowColor = 'transparent';
    context.shadowBlur = 0;
    context.shadowOffsetY = 0;
    context.strokeStyle = '#e90064';
    context.lineWidth = 5;
    context.beginPath();
    context.arc(headX, headY, markerEdge * 0.017, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }

  drawOverlay(context, width, height, journey, current, title, periodLabel, distanceUnit);
}
