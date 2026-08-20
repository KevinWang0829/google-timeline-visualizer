import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality } from 'mediabunny';
import { frameAtElapsedSeconds, OUTRO_SECONDS } from './animation';
import type { DistanceUnit } from './distance-unit';
import { drawFrame } from './renderer';
import type { PreparedJourney } from './types';
import { VIDEO_FORMATS } from './video-formats';
import type { VideoFormat } from './video-formats';

export interface ExportOptions {
  durationSeconds: number;
  title: string;
  periodLabel: string;
  distanceUnit: DistanceUnit;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  format?: VideoFormat;
}

export function hasVideoEncoder(): boolean {
  return typeof globalThis.VideoEncoder !== 'undefined';
}

export async function canCreateMp4(format: VideoFormat = VIDEO_FORMATS.standard): Promise<boolean> {
  if (!hasVideoEncoder()) return false;
  try {
    const result = await VideoEncoder.isConfigSupported({
      codec: format.codec,
      width: format.width,
      height: format.height,
      bitrate: format.bitrate,
      framerate: format.frameRate,
      hardwareAcceleration: 'no-preference',
    });
    return result.supported === true;
  } catch {
    return false;
  }
}

export function isMp4(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 12) return false;
  const bytes = new Uint8Array(buffer, 4, 8);
  return String.fromCharCode(...bytes).startsWith('ftyp');
}

export async function createJourneyMp4(
  canvas: HTMLCanvasElement,
  journey: PreparedJourney,
  options: ExportOptions,
): Promise<Blob> {
  if (!hasVideoEncoder()) {
    throw new Error('這個瀏覽器無法建立 MP4。請使用 Safari 16.4 或更新版本。');
  }

  const format = options.format ?? VIDEO_FORMATS.standard;
  if (canvas.width !== format.width || canvas.height !== format.height) {
    throw new Error(`影片畫布必須是 ${format.width}×${format.height}。`);
  }
  const fps = format.frameRate;
  const frameDuration = 1 / fps;
  const journeyFrameCount = Math.max(1, Math.round(options.durationSeconds * fps));
  const outroFrameCount = Math.round(OUTRO_SECONDS * fps);
  const frameCount = journeyFrameCount + outroFrameCount;
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target,
  });
  const source = new CanvasSource(canvas, {
    codec: 'avc',
    fullCodecString: format.codec,
    quality: new Quality({ bitrate: format.bitrate }),
    keyFrameInterval: 1,
    hardwareAcceleration: 'no-preference',
  });
  output.addVideoTrack(source, { frameRate: fps });
  output.setMetadataTags({ title: options.title });
  await output.start();

  for (let frame = 0; frame < frameCount; frame += 1) {
    if (options.signal?.aborted) {
      await output.cancel();
      throw new DOMException('Video creation was cancelled.', 'AbortError');
    }
    const animationFrame = frame < journeyFrameCount
      ? {
        journeyProgress: journeyFrameCount === 1 ? 1 : frame / (journeyFrameCount - 1),
        outroProgress: 0,
      }
      : frameAtElapsedSeconds(
        options.durationSeconds + (frame - journeyFrameCount) / fps,
        options.durationSeconds,
      );
    drawFrame(
      canvas,
      journey,
      animationFrame,
      options.title,
      options.periodLabel,
      options.distanceUnit,
    );
    await source.add(frame * frameDuration, frameDuration, { keyFrame: frame % fps === 0 });
    options.onProgress?.((frame + 1) / frameCount);
  }

  await output.finalize();
  if (!target.buffer) throw new Error('影片編碼器沒有產生 MP4 檔案。');
  if (!isMp4(target.buffer)) throw new Error('影片編碼器產生了無效的 MP4 檔案。');
  return new Blob([target.buffer], { type: 'video/mp4' });
}
