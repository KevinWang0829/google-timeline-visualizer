/// <reference lib="webworker" />

import { parseTimelineJson, TimelineParseError } from './timeline';
import type { GeoPoint } from './types';

type ParseStage = 'reading' | 'parsing' | 'normalizing';

interface ParseRequest {
  file: File;
}

type ParseResponse =
  | { type: 'stage'; stage: ParseStage }
  | { type: 'success'; points: GeoPoint[] }
  | { type: 'error'; message: string; reason?: TimelineParseError['reason'] };

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = async (event: MessageEvent<ParseRequest>): Promise<void> => {
  try {
    workerScope.postMessage({ type: 'stage', stage: 'reading' } satisfies ParseResponse);
    const text = await event.data.file.text();
    workerScope.postMessage({ type: 'stage', stage: 'parsing' } satisfies ParseResponse);
    let data: unknown;
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      throw new TimelineParseError('malformed-json', '這不是有效或完整的 JSON 檔案。');
    }
    workerScope.postMessage({ type: 'stage', stage: 'normalizing' } satisfies ParseResponse);
    const points = parseTimelineJson(data);
    workerScope.postMessage({ type: 'success', points } satisfies ParseResponse);
  } catch (error) {
    workerScope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : '無法讀取選擇的檔案。',
      reason: error instanceof TimelineParseError ? error.reason : undefined,
    } satisfies ParseResponse);
  }
};
