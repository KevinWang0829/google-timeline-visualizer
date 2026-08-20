import { TimelineParseError } from './timeline';
import type { GeoPoint } from './types';

export type TimelineFileStage = 'reading' | 'parsing' | 'normalizing';

type ParseResponse =
  | { type: 'stage'; stage: TimelineFileStage }
  | { type: 'success'; points: GeoPoint[] }
  | { type: 'error'; message: string; reason?: TimelineParseError['reason'] };

export function parseTimelineFile(
  file: File,
  onStage?: (stage: TimelineFileStage) => void,
): Promise<GeoPoint[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./timeline-worker.ts', import.meta.url), { type: 'module' });
    const finish = (): void => worker.terminate();
    worker.onmessage = (event: MessageEvent<ParseResponse>) => {
      const response = event.data;
      if (response.type === 'stage') {
        onStage?.(response.stage);
        return;
      }
      finish();
      if (response.type === 'success') {
        resolve(response.points);
      } else if (response.reason) {
        reject(new TimelineParseError(response.reason, response.message));
      } else {
        reject(new Error(response.message));
      }
    };
    worker.onerror = () => {
      finish();
      reject(new Error('瀏覽器無法在背景解析這個 Timeline 檔案。'));
    };
    worker.postMessage({ file });
  });
}
