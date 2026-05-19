import { logger } from "../../obs/logger.js";

const HARD_CAP_MINUTES = 60;

export interface ImageProbeConfig {
  windowMinutes: number;
  maxSamples: number;
  sampleDir: string;
}
export interface ImageProbeStatus {
  active: boolean;
  run_id: string | null;
  window_minutes: number;
  max_samples: number;
  samples_captured: number;
  sample_dir: string | null;
  started_at: string | null;
  expires_at: string | null;
}

interface Internal extends ImageProbeStatus {
  _timer: ReturnType<typeof setTimeout> | null;
}

let st: Internal = blank();

function blank(): Internal {
  return {
    active: false,
    run_id: null,
    window_minutes: 0,
    max_samples: 0,
    samples_captured: 0,
    sample_dir: null,
    started_at: null,
    expires_at: null,
    _timer: null,
  };
}

export function startImageProbe(cfg: ImageProbeConfig): ImageProbeStatus {
  if (st.active) return snapshot();
  const windowMinutes = Math.min(Math.max(cfg.windowMinutes, 0), HARD_CAP_MINUTES);
  const now = Date.now();
  const runId = `run-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
  const timer = setTimeout(
    () => {
      logger.info({ run_id: runId }, "image probe auto-expired");
      stopImageProbe();
    },
    Math.max(windowMinutes * 60_000, 1),
  );
  st = {
    active: true,
    run_id: runId,
    window_minutes: windowMinutes,
    max_samples: cfg.maxSamples,
    samples_captured: 0,
    sample_dir: cfg.sampleDir,
    started_at: new Date(now).toISOString(),
    expires_at: new Date(now + windowMinutes * 60_000).toISOString(),
    _timer: timer,
  };
  logger.info({ run_id: runId, windowMinutes }, "image probe started");
  return snapshot();
}

export function stopImageProbe(): void {
  if (st._timer) clearTimeout(st._timer);
  if (st.active) logger.info({ run_id: st.run_id }, "image probe stopped");
  st = blank();
}

export function noteSample(): void {
  if (!st.active) return;
  st.samples_captured += 1;
  if (st.samples_captured >= st.max_samples) {
    logger.info({ run_id: st.run_id, n: st.samples_captured }, "image probe sample cap reached");
    stopImageProbe();
  }
}

export function isProbeActive(): boolean {
  return st.active;
}
export function activeSampleDir(): string | null {
  return st.active ? st.sample_dir : null;
}
function snapshot(): ImageProbeStatus {
  const { _timer, ...pub } = st;
  return { ...pub };
}
export function imageProbeStatus(): ImageProbeStatus {
  return snapshot();
}
/** test-only */
export function _resetImageProbe(): void {
  stopImageProbe();
}
