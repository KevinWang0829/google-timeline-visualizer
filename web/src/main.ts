import './style.css';
import { frameAtElapsedSeconds, frameAtOverallProgress, totalDurationSeconds } from './animation';
import {
  distanceUnitPreferenceLabel,
  DistanceUnitPreference,
  formatDistance,
  loadDistanceUnitPreference,
  resolveDistanceUnit,
  saveDistanceUnitPreference,
} from './distance-unit';
import type { DistanceUnit } from './distance-unit';
import { cumulativeDistances } from './geo';
import type { LongTripCompression } from './journey-timing';
import { filterLocationOutliers } from './outlier';
import { drawFrame, prepareJourney } from './renderer';
import { parseTimelineFile } from './timeline-file';
import type { TimelineFileStage } from './timeline-file';
import {
  availableMonths,
  localDateKey,
  parseTimelineJson,
  pointDateKey,
  selectDateRange,
  selectRange,
  TimelineParseError,
} from './timeline';
import type { CameraMovement, GeoPoint, MonthOption, PreparedJourney } from './types';
import { canCreateMp4, createJourneyMp4 } from './video';
import { previewDimensions, VIDEO_FORMATS } from './video-formats';
import type { VideoFormat, VideoFormatId } from './video-formats';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

const fileInput = element<HTMLInputElement>('timeline-file');
const sampleButton = element<HTMLButtonElement>('sample-button');
const loadingRow = element<HTMLElement>('loading-row');
const loadingStage = element<HTMLElement>('loading-stage');
const fileStatus = element<HTMLParagraphElement>('file-status');
const compatibilityStatus = element<HTMLParagraphElement>('compatibility-status');
const settingsCard = element<HTMLElement>('settings-card');
const exactDateToggle = element<HTMLInputElement>('exact-date-toggle');
const monthRangeFields = element<HTMLElement>('month-range-fields');
const exactDateFields = element<HTMLElement>('exact-date-fields');
const startSelect = element<HTMLSelectElement>('start-month');
const endSelect = element<HTMLSelectElement>('end-month');
const startDateInput = element<HTMLInputElement>('start-date');
const endDateInput = element<HTMLInputElement>('end-date');
const titleInput = element<HTMLInputElement>('video-title');
const durationSelect = element<HTMLSelectElement>('duration');
const customDurationField = element<HTMLElement>('custom-duration-field');
const customDurationInput = element<HTMLInputElement>('custom-duration');
const durationWarning = element<HTMLElement>('duration-warning');
const videoFormatSelect = element<HTMLSelectElement>('video-format');
const distanceUnitSelect = element<HTMLSelectElement>('distance-unit');
const cameraMovementSelect = element<HTMLSelectElement>('camera-movement');
const compressionSelect = element<HTMLSelectElement>('long-trip-compression');
const outlierFilter = element<HTMLInputElement>('outlier-filter');
const outlierSummary = element<HTMLElement>('outlier-summary');
const selectionSummary = element<HTMLParagraphElement>('selection-summary');
const mapConsent = element<HTMLInputElement>('map-consent');
const settingsError = element<HTMLParagraphElement>('settings-error');
const previewCard = element<HTMLElement>('preview-card');
const canvas = element<HTMLCanvasElement>('journey-canvas');
const timelineSeek = element<HTMLInputElement>('timeline-seek');
const previewButton = element<HTMLButtonElement>('preview-button');
const createButton = element<HTMLButtonElement>('create-button');
const cancelButton = element<HTMLButtonElement>('cancel-button');
const progress = element<HTMLProgressElement>('export-progress');
const progressLabel = element<HTMLSpanElement>('progress-label');
const errorMessage = element<HTMLParagraphElement>('error-message');
const resultVideo = element<HTMLVideoElement>('result-video');
const resultActions = element<HTMLElement>('result-actions');
const shareButton = element<HTMLButtonElement>('share-button');
const downloadLink = element<HTMLAnchorElement>('download-link');

if (import.meta.env.VITE_PREVIEW === 'true') {
  element<HTMLElement>('preview-banner').classList.remove('hidden');
}

const numberFormatter = new Intl.NumberFormat('zh-TW');
const fileStageLabels: Record<TimelineFileStage, string> = {
  reading: '正在讀取 Timeline 檔案…',
  parsing: '正在解析 JSON…',
  normalizing: '正在整理 App 路線資料…',
};

type PreviewState = 'idle' | 'playing' | 'paused' | 'finished';

let rawPoints: GeoPoint[] = [];
let allPoints: GeoPoint[] = [];
let selectedPoints: GeoPoint[] = [];
let selectedDistance = 0;
let sourceName = '';
let removedOutlierCount = 0;
let months: MonthOption[] = [];
let prepared: PreparedJourney | null = null;
let preparedSignature = '';
let previewPrepared: PreparedJourney | null = null;
let resultUrl: string | null = null;
let resultFile: File | null = null;
let previewAnimation = 0;
let previewState: PreviewState = 'idle';
let previewElapsedSeconds = 0;
let previewBaseElapsedSeconds = 0;
let previewStartedAt = 0;
let encodingSupported = false;
let compatibilityChecked = false;
let compatibilityNonce = 0;
let isExporting = false;
let isPreparing = false;
let exportController: AbortController | null = null;
let distanceUnitPreference = loadDistanceUnitPreference();

function setError(message: string | null): void {
  errorMessage.textContent = message ?? '';
  errorMessage.classList.toggle('hidden', !message);
}

function setSettingsError(message: string | null): void {
  settingsError.textContent = message ?? '';
  settingsError.classList.toggle('hidden', !message);
}

function setLoading(visible: boolean, text?: string): void {
  loadingRow.classList.toggle('hidden', !visible);
  if (text) loadingStage.textContent = text;
  fileInput.disabled = visible;
  sampleButton.disabled = visible;
}

function selectedFormat(): VideoFormat {
  return VIDEO_FORMATS[videoFormatSelect.value as VideoFormatId] ?? VIDEO_FORMATS.standard;
}

function selectedCompression(): LongTripCompression {
  return compressionSelect.value as LongTripCompression;
}

function selectedDistanceUnit(): DistanceUnit {
  return resolveDistanceUnit(distanceUnitPreference);
}

function updateDistanceUnitOptions(): void {
  const automatic = distanceUnitSelect.querySelector<HTMLOptionElement>('option[value="automatic"]');
  if (automatic) {
    automatic.textContent = distanceUnitPreferenceLabel(DistanceUnitPreference.AUTOMATIC);
  }
  distanceUnitSelect.value = distanceUnitPreference;
}

function selectedDurationSeconds(): number {
  if (durationSelect.value !== 'custom') return Number(durationSelect.value);
  const value = Number(customDurationInput.value);
  return Number.isSafeInteger(value) && value >= 10 && value <= 300 ? value : Number.NaN;
}

function durationIsValid(): boolean {
  return Number.isFinite(selectedDurationSeconds());
}

function populateMonths(select: HTMLSelectElement, options: MonthOption[]): void {
  select.replaceChildren(...options.map(({ key, label }) => new Option(label, key)));
}

function formatInputDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium' }).format(new Date(year, month - 1, day));
}

function currentPeriodLabel(): string {
  if (exactDateToggle.checked) {
    const start = formatInputDate(startDateInput.value);
    const end = formatInputDate(endDateInput.value);
    return startDateInput.value === endDateInput.value ? start : `${start} – ${end}`;
  }
  const start = months.find((month) => month.key === startSelect.value)?.label ?? startSelect.value;
  const end = months.find((month) => month.key === endSelect.value)?.label ?? endSelect.value;
  return startSelect.value === endSelect.value ? start : `${start} – ${end}`;
}

function currentRangeSignature(): string {
  return exactDateToggle.checked
    ? `dates:${startDateInput.value}:${endDateInput.value}`
    : `months:${startSelect.value}:${endSelect.value}`;
}

function clearResult(): void {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = null;
  resultFile = null;
  resultVideo.removeAttribute('src');
  resultVideo.load();
  resultVideo.classList.add('hidden');
  resultActions.classList.add('hidden');
}

function stopPreview(nextState: PreviewState = 'idle'): void {
  cancelAnimationFrame(previewAnimation);
  previewAnimation = 0;
  previewState = nextState;
}

function invalidatePrepared(clearGenerated = true): void {
  stopPreview('idle');
  prepared = null;
  preparedSignature = '';
  previewPrepared = null;
  previewElapsedSeconds = 0;
  timelineSeek.value = '0';
  progressLabel.textContent = '準備就緒';
  if (clearGenerated) clearResult();
}

function updateDurationUi(): void {
  const custom = durationSelect.value === 'custom';
  customDurationField.classList.toggle('hidden', !custom);
  const seconds = selectedDurationSeconds();
  const format = selectedFormat();
  durationWarning.classList.toggle(
    'hidden',
    !(seconds > 60 || format.width > 720 || format.height > 720),
  );
}

function refreshActionAvailability(): void {
  const hasJourney = selectedPoints.length >= 2 && selectedDistance > 0;
  const validDuration = durationIsValid();
  previewButton.disabled = isExporting || isPreparing || !hasJourney || !validDuration;
  createButton.disabled = isExporting
    || isPreparing
    || !hasJourney
    || !validDuration
    || !encodingSupported;

  previewButton.textContent = previewState === 'playing'
    ? '暫停'
    : previewState === 'paused'
      ? '繼續'
      : previewState === 'finished'
        ? '重新預覽'
        : '預覽';

  if (!validDuration) {
    previewButton.title = '自訂秒數必須是 10–300 的整數。';
    createButton.title = previewButton.title;
  } else {
    previewButton.removeAttribute('title');
    if (!compatibilityChecked) {
      createButton.title = '正在檢查此影片格式。';
    } else if (!encodingSupported) {
      createButton.title = '此瀏覽器無法輸出選擇的解析度；你仍可預覽。';
    } else if (!hasJourney) {
      createButton.title = '請選擇包含至少兩個不同位置的期間。';
    } else {
      createButton.removeAttribute('title');
    }
  }
}

function updateSelectionSummary(): void {
  if (selectedPoints.length === 0) {
    selectionSummary.textContent = '此期間沒有位置點';
  } else if (selectedPoints.length === 1) {
    selectionSummary.textContent = '1 個位置點 · 請選擇更大的範圍';
  } else if (selectedDistance <= 0) {
    selectionSummary.textContent = `${numberFormatter.format(selectedPoints.length)} 個位置點 · 未偵測到移動`;
  } else {
    selectionSummary.textContent = `${numberFormatter.format(selectedPoints.length)} 個位置點 · 約 ${formatDistance(selectedDistance, selectedDistanceUnit())} · ${currentPeriodLabel()}`;
  }
}

function updateSelection(): void {
  if (exactDateToggle.checked) {
    if (startDateInput.value > endDateInput.value) endDateInput.value = startDateInput.value;
    selectedPoints = selectDateRange(allPoints, startDateInput.value, endDateInput.value);
  } else {
    if (startSelect.value > endSelect.value) endSelect.value = startSelect.value;
    selectedPoints = selectRange(allPoints, startSelect.value, endSelect.value);
  }
  selectedDistance = cumulativeDistances(selectedPoints).at(-1) ?? 0;
  updateSelectionSummary();
  invalidatePrepared();
  setSettingsError(null);
  refreshActionAvailability();
}

function rebuildFilteredTimeline(): void {
  const result = filterLocationOutliers(rawPoints, outlierFilter.checked ? 'conservative' : 'off');
  allPoints = result.points;
  removedOutlierCount = result.removedCount;
  months = availableMonths(allPoints);
  populateMonths(startSelect, months);
  populateMonths(endSelect, months);
  startSelect.value = months[0].key;
  endSelect.value = months.at(-1)?.key ?? months[0].key;

  const dateKeys = allPoints.map(pointDateKey).sort();
  const firstDate = dateKeys[0] ?? localDateKey(allPoints[0].instant);
  const lastDate = dateKeys.at(-1) ?? firstDate;
  startDateInput.min = firstDate;
  startDateInput.max = lastDate;
  endDateInput.min = firstDate;
  endDateInput.max = lastDate;
  startDateInput.value = firstDate;
  endDateInput.value = lastDate;
  exactDateToggle.checked = false;
  monthRangeFields.classList.remove('hidden');
  exactDateFields.classList.add('hidden');

  const timezoneNote = allPoints.some((point) => point.timeZoneMissing)
    ? ' · 原檔無時區，已保留匯出順序'
    : '';
  const filterNote = removedOutlierCount > 0
    ? ` · 已忽略 ${numberFormatter.format(removedOutlierCount)} 個可疑位置`
    : '';
  fileStatus.textContent = `${sourceName} · ${numberFormatter.format(allPoints.length)} 個有效位置 · ${months[0].label} 至 ${months.at(-1)?.label}${filterNote}${timezoneNote}`;
  outlierSummary.textContent = outlierFilter.checked
    ? removedOutlierCount > 0
      ? `已保守忽略 ${numberFormatter.format(removedOutlierCount)} 個可疑位置`
      : '已啟用保守篩選，未偵測到可疑位置'
    : '已關閉，保留所有位置點';
  updateSelection();
}

function applyTimelinePoints(points: GeoPoint[], name: string): void {
  rawPoints = points;
  sourceName = name;
  mapConsent.checked = false;
  settingsCard.classList.remove('hidden');
  previewCard.classList.add('hidden');
  setError(null);
  rebuildFilteredTimeline();
}

function parseTimelineText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TimelineParseError('malformed-json', '這不是有效或完整的 JSON 檔案。');
  }
}

function localizedTimelineError(error: unknown): string {
  if (!(error instanceof TimelineParseError)) {
    return error instanceof Error ? error.message : '無法讀取選擇的檔案。';
  }
  const messages: Record<TimelineParseError['reason'], string> = {
    'malformed-json': '這不是有效或完整的 JSON 檔案。',
    'legacy-format': '這是舊版 Google Takeout 格式；請改用手機 Google 地圖中的「匯出 Timeline 資料」。',
    'raw-signals-only': '這份匯出只有原始訊號，沒有可重建的 Timeline 旅程。',
    'unsupported-format': 'Timeline JSON 必須是陣列，或包含 semanticSegments。',
    'no-usable-locations': '這份 Timeline 沒有可用的位置點。',
  };
  return messages[error.reason];
}

async function loadTimeline(file: File): Promise<void> {
  setError(null);
  setSettingsError(null);
  settingsCard.classList.add('hidden');
  previewCard.classList.add('hidden');
  const sizeWarning = file.size > 100_000_000 ? '大型檔案，請保持此頁開啟…' : undefined;
  setLoading(true, sizeWarning ?? `正在讀取 ${file.name}…`);
  fileStatus.textContent = `正在讀取 ${file.name}…`;
  try {
    const points = await parseTimelineFile(file, (stage) => {
      loadingStage.textContent = fileStageLabels[stage];
    });
    applyTimelinePoints(points, file.name);
  } catch (error) {
    fileStatus.textContent = '無法載入 Timeline';
    setError(localizedTimelineError(error));
    previewCard.classList.remove('hidden');
  } finally {
    setLoading(false);
  }
}

async function checkFormatSupport(): Promise<void> {
  const nonce = ++compatibilityNonce;
  compatibilityChecked = false;
  encodingSupported = false;
  const format = selectedFormat();
  compatibilityStatus.textContent = `正在檢查 ${format.width}×${format.height} MP4 支援…`;
  refreshActionAvailability();
  const supported = await canCreateMp4(format);
  if (nonce !== compatibilityNonce) return;
  compatibilityChecked = true;
  encodingSupported = supported;
  compatibilityStatus.textContent = supported
    ? `此瀏覽器可建立 ${format.width}×${format.height} H.264 MP4。`
    : `可預覽，但此瀏覽器無法輸出 ${format.width}×${format.height} H.264 MP4。`;
  refreshActionAvailability();
}

function currentPreparationSignature(width: number, height: number): string {
  return [
    currentRangeSignature(),
    `${width}x${height}`,
    `camera:${cameraMovementSelect.value}`,
    `compression:${compressionSelect.value}`,
    `duration:${selectedDurationSeconds()}`,
  ].join(':');
}

async function getPreparedJourney(
  width: number,
  height: number,
  signal?: AbortSignal,
): Promise<PreparedJourney> {
  const signature = currentPreparationSignature(width, height);
  if (prepared && preparedSignature === signature) return prepared;
  if (signal?.aborted) throw new DOMException('已取消建立影片。', 'AbortError');
  progressLabel.textContent = '正在準備 App 鏡頭與地圖';
  const nextJourney = await prepareJourney(
    selectedPoints,
    width,
    height,
    cameraMovementSelect.value as CameraMovement,
    selectedCompression(),
    selectedDurationSeconds(),
    signal,
    (completed, total) => {
      progressLabel.textContent = `正在準備地圖 ${completed}/${total}`;
    },
  );
  if (signal?.aborted) throw new DOMException('已取消建立影片。', 'AbortError');
  prepared = nextJourney;
  preparedSignature = signature;
  return nextJourney;
}

function requireMapConsent(): boolean {
  if (mapConsent.checked) return true;
  setSettingsError('請先確認地圖隱私說明，再向 CARTO 請求地圖圖磚。');
  mapConsent.focus();
  return false;
}

function drawPreviewAt(elapsedSeconds: number): void {
  if (!previewPrepared) return;
  const duration = selectedDurationSeconds();
  const total = totalDurationSeconds(duration);
  previewElapsedSeconds = Math.max(0, Math.min(total, elapsedSeconds));
  drawFrame(
    canvas,
    previewPrepared,
    frameAtElapsedSeconds(previewElapsedSeconds, duration),
    titleInput.value.trim(),
    currentPeriodLabel(),
    selectedDistanceUnit(),
  );
  timelineSeek.value = String(Math.round((previewElapsedSeconds / total) * 1000));
}

function previewTick(now: number): void {
  if (previewState !== 'playing' || !previewPrepared) return;
  const total = totalDurationSeconds(selectedDurationSeconds());
  const elapsed = previewBaseElapsedSeconds + (now - previewStartedAt) / 1000;
  drawPreviewAt(elapsed);
  if (previewElapsedSeconds < total) {
    progressLabel.textContent = `預覽中 ${Math.floor(previewElapsedSeconds)} / ${Math.ceil(total)} 秒`;
    previewAnimation = requestAnimationFrame(previewTick);
  } else {
    previewState = 'finished';
    progressLabel.textContent = '預覽完成';
    refreshActionAvailability();
  }
}

function startPreviewPlayback(restart: boolean): void {
  if (!previewPrepared) return;
  cancelAnimationFrame(previewAnimation);
  if (restart) drawPreviewAt(0);
  previewBaseElapsedSeconds = previewElapsedSeconds;
  previewStartedAt = performance.now();
  previewState = 'playing';
  previewAnimation = requestAnimationFrame(previewTick);
  refreshActionAvailability();
}

function pausePreview(): void {
  if (previewState !== 'playing') return;
  cancelAnimationFrame(previewAnimation);
  previewAnimation = 0;
  previewState = 'paused';
  progressLabel.textContent = '已暫停';
  refreshActionAvailability();
}

async function requestWakeLock(): Promise<WakeLockSentinel | null> {
  try {
    return await navigator.wakeLock.request('screen');
  } catch {
    return null;
  }
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void loadTimeline(file);
});

sampleButton.addEventListener('click', async () => {
  setError(null);
  setSettingsError(null);
  setLoading(true, '正在載入虛構旅程…');
  fileStatus.textContent = '正在載入虛構旅程…';
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}sample-timeline.json`);
    if (!response.ok) throw new Error('無法載入虛構旅程。');
    applyTimelinePoints(parseTimelineJson(parseTimelineText(await response.text())), '虛構旅程');
  } catch (error) {
    settingsCard.classList.add('hidden');
    fileStatus.textContent = '無法載入範例';
    setError(localizedTimelineError(error));
    previewCard.classList.remove('hidden');
  } finally {
    setLoading(false);
  }
});

startSelect.addEventListener('change', updateSelection);
endSelect.addEventListener('change', updateSelection);
startDateInput.addEventListener('change', updateSelection);
endDateInput.addEventListener('change', updateSelection);
exactDateToggle.addEventListener('change', () => {
  monthRangeFields.classList.toggle('hidden', exactDateToggle.checked);
  exactDateFields.classList.toggle('hidden', !exactDateToggle.checked);
  updateSelection();
});

durationSelect.addEventListener('change', () => {
  updateDurationUi();
  invalidatePrepared();
  refreshActionAvailability();
});
customDurationInput.addEventListener('input', () => {
  updateDurationUi();
  invalidatePrepared();
  refreshActionAvailability();
});
videoFormatSelect.addEventListener('change', () => {
  updateDurationUi();
  invalidatePrepared();
  refreshActionAvailability();
  void checkFormatSupport();
});
cameraMovementSelect.addEventListener('change', () => {
  invalidatePrepared();
  refreshActionAvailability();
});
compressionSelect.addEventListener('change', () => {
  invalidatePrepared();
  refreshActionAvailability();
});
distanceUnitSelect.addEventListener('change', () => {
  distanceUnitPreference = distanceUnitSelect.value as DistanceUnitPreference;
  saveDistanceUnitPreference(distanceUnitPreference);
  updateDistanceUnitOptions();
  updateSelectionSummary();
  clearResult();
  if (previewPrepared && previewState !== 'playing') drawPreviewAt(previewElapsedSeconds);
});
outlierFilter.addEventListener('change', () => {
  if (rawPoints.length > 0) rebuildFilteredTimeline();
});
mapConsent.addEventListener('change', () => {
  if (mapConsent.checked) setSettingsError(null);
});
titleInput.addEventListener('input', () => {
  if (previewPrepared && previewState !== 'playing') drawPreviewAt(previewElapsedSeconds);
});

previewButton.addEventListener('click', async () => {
  if (previewState === 'playing') {
    pausePreview();
    return;
  }
  if (previewPrepared && previewState === 'paused') {
    startPreviewPlayback(false);
    return;
  }
  if (previewPrepared && previewState === 'finished') {
    startPreviewPlayback(true);
    return;
  }
  if (!requireMapConsent()) return;

  setError(null);
  resultActions.classList.add('hidden');
  resultVideo.classList.add('hidden');
  previewCard.classList.remove('hidden');
  previewCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  isPreparing = true;
  refreshActionAvailability();
  try {
    const dimensions = previewDimensions(selectedFormat());
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    previewPrepared = await getPreparedJourney(dimensions.width, dimensions.height);
    drawPreviewAt(0);
    startPreviewPlayback(false);
  } catch (error) {
    setError(error instanceof Error ? error.message : '無法建立預覽。');
    progressLabel.textContent = '預覽失敗';
  } finally {
    isPreparing = false;
    refreshActionAvailability();
  }
});

timelineSeek.addEventListener('input', () => {
  if (!previewPrepared || isExporting) return;
  stopPreview('paused');
  const fraction = Number(timelineSeek.value) / 1000;
  drawFrame(
    canvas,
    previewPrepared,
    frameAtOverallProgress(fraction, selectedDurationSeconds()),
    titleInput.value.trim(),
    currentPeriodLabel(),
    selectedDistanceUnit(),
  );
  previewElapsedSeconds = fraction * totalDurationSeconds(selectedDurationSeconds());
  previewState = fraction >= 1 ? 'finished' : 'paused';
  progressLabel.textContent = previewState === 'finished' ? '預覽完成' : '已暫停';
  refreshActionAvailability();
});

cancelButton.addEventListener('click', () => {
  cancelButton.disabled = true;
  progressLabel.textContent = '正在取消…';
  exportController?.abort();
});

createButton.addEventListener('click', async () => {
  if (!requireMapConsent()) return;
  pausePreview();
  setError(null);
  resultActions.classList.add('hidden');
  resultVideo.classList.add('hidden');
  previewCard.classList.remove('hidden');
  progress.classList.remove('hidden');
  cancelButton.classList.remove('hidden');
  cancelButton.disabled = false;
  progress.value = 0;
  isExporting = true;
  refreshActionAvailability();
  previewCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  exportController = new AbortController();
  const wakeLock = await requestWakeLock();
  const format = selectedFormat();
  try {
    canvas.width = format.width;
    canvas.height = format.height;
    const journey = await getPreparedJourney(format.width, format.height, exportController.signal);
    progressLabel.textContent = '正在建立 MP4';
    const title = titleInput.value.trim() || '我的旅程';
    const blob = await createJourneyMp4(canvas, journey, {
      durationSeconds: selectedDurationSeconds(),
      title,
      periodLabel: currentPeriodLabel(),
      distanceUnit: selectedDistanceUnit(),
      format,
      signal: exportController.signal,
      onProgress: (fraction) => {
        progress.value = fraction;
        progressLabel.textContent = `正在建立 MP4 ${Math.round(fraction * 100)}%`;
      },
    });
    clearResult();
    resultUrl = URL.createObjectURL(blob);
    const filename = `timeline-journey-${format.id}.mp4`;
    resultFile = new File([blob], filename, { type: 'video/mp4' });
    downloadLink.href = resultUrl;
    downloadLink.download = filename;
    resultVideo.src = resultUrl;
    resultVideo.classList.remove('hidden');
    resultActions.classList.remove('hidden');
    progressLabel.textContent = `影片已完成 · ${(blob.size / 1_000_000).toFixed(1)} MB`;
    const shareData = { files: [resultFile] };
    const canShare = typeof navigator.share === 'function'
      && (typeof navigator.canShare !== 'function' || navigator.canShare(shareData));
    shareButton.hidden = !canShare;
  } catch (error) {
    if (exportController.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      progressLabel.textContent = '已取消建立影片';
      progress.value = 0;
    } else {
      setError(error instanceof Error ? error.message : '無法建立影片。');
      progressLabel.textContent = '建立影片失敗';
    }
  } finally {
    await wakeLock?.release().catch(() => undefined);
    exportController = null;
    isExporting = false;
    cancelButton.classList.add('hidden');
    refreshActionAvailability();
  }
});

shareButton.addEventListener('click', async () => {
  if (!resultFile || typeof navigator.share !== 'function') return;
  try {
    await navigator.share({ files: [resultFile], title: titleInput.value.trim() || '我的旅程' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    setError('無法開啟系統分享面板，請改用「下載 MP4」。');
  }
});

window.addEventListener('beforeunload', () => {
  cancelAnimationFrame(previewAnimation);
  exportController?.abort();
  if (resultUrl) URL.revokeObjectURL(resultUrl);
});

window.addEventListener('languagechange', () => {
  if (distanceUnitPreference !== DistanceUnitPreference.AUTOMATIC) return;
  updateDistanceUnitOptions();
  updateSelectionSummary();
  if (previewPrepared) drawPreviewAt(previewElapsedSeconds);
});

updateDistanceUnitOptions();
updateDurationUi();
refreshActionAvailability();
void checkFormatSupport();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}service-worker.js`);
  });
}
