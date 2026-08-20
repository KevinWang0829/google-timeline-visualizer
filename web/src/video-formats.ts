export type VideoFormatId = 'standard' | 'high' | 'ultra' | 'portrait' | 'landscape';

export interface VideoFormat {
  id: VideoFormatId;
  width: number;
  height: number;
  frameRate: number;
  bitrate: number;
  codec: string;
}

export const VIDEO_FORMATS: Record<VideoFormatId, VideoFormat> = {
  standard: { id: 'standard', width: 480, height: 480, frameRate: 24, bitrate: 2_500_000, codec: 'avc1.42001f' },
  high: { id: 'high', width: 720, height: 720, frameRate: 24, bitrate: 5_000_000, codec: 'avc1.42001f' },
  ultra: { id: 'ultra', width: 1080, height: 1080, frameRate: 24, bitrate: 8_000_000, codec: 'avc1.420028' },
  portrait: { id: 'portrait', width: 1080, height: 1920, frameRate: 30, bitrate: 12_000_000, codec: 'avc1.420028' },
  landscape: { id: 'landscape', width: 1920, height: 1080, frameRate: 30, bitrate: 12_000_000, codec: 'avc1.420028' },
};

export function previewDimensions(format: VideoFormat): { width: number; height: number } {
  if (format.width === format.height) return { width: 480, height: 480 };
  if (format.width < format.height) return { width: 360, height: 640 };
  return { width: 640, height: 360 };
}
