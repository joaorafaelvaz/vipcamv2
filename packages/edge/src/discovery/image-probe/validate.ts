import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DetectResult, ProbeSampleMeta, SourceMetrics } from "@vipcam/shared";
import { logger } from "../../obs/logger.js";
import type { Thresholds } from "./decision.js";
import { ReidError, detect } from "./reid-client.js";

export interface ScoredSample {
  meta: ProbeSampleMeta;
  detect: DetectResult;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function isUsable(d: DetectResult, t: Thresholds): boolean {
  return d.faces.some(
    (f) => f.det_score >= t.min_det_score && Math.min(f.bbox[2], f.bbox[3]) >= t.min_bbox_px,
  );
}

function sampleHasImage(m: ProbeSampleMeta): boolean {
  if (m.source === "event") return true; // capturado pelo tap = era parte image/*
  return (
    m.http_status != null &&
    m.http_status >= 200 &&
    m.http_status < 300 &&
    m.content_type.startsWith("image/")
  );
}

/** Pure: agrega ScoredSample[] em SourceMetrics[] por fonte. */
export function aggregate(
  samples: ScoredSample[],
  _faceEvents: number,
  t: Thresholds,
): { metrics: SourceMetrics[] } {
  const sources: ProbeSampleMeta["source"][] = ["event", "snapshot"];
  const metrics: SourceMetrics[] = [];
  for (const src of sources) {
    const grp = samples.filter((s) => s.meta.source === src);
    if (grp.length === 0) continue;
    const withImage = grp.filter((s) => sampleHasImage(s.meta));
    const usable = grp.filter((s) => isUsable(s.detect, t));
    const bboxPx = grp
      .map((s) => {
        const f = s.detect.faces[0];
        return f ? Math.min(f.bbox[2], f.bbox[3]) : null;
      })
      .filter((x): x is number => x != null);
    const deltas = grp.map((s) => s.meta.delta_ms).filter((x): x is number => x != null);
    metrics.push({
      source: src,
      samples: grp.length,
      with_image: withImage.length,
      usable_face: usable.length,
      median_bbox_px: median(bboxPx),
      median_infer_ms: median(grp.map((s) => s.detect.infer_ms)),
      median_delta_ms: src === "snapshot" ? median(deltas) : null,
    });
  }
  return { metrics };
}

const EMPTY: DetectResult = { faces: [], width: 0, height: 0, infer_ms: 0 };

export interface ValidateArgs {
  sampleDir: string;
  reidBaseUrl: string;
  thresholds: Thresholds;
}
export interface ValidateResult {
  metrics: SourceMetrics[];
  faceEvents: number;
  reid_failures: number;
}

/** Lê o sampleDir, chama reid por imagem (tolerante a falhas — conta e
 *  segue, tratando falha como sem-rosto), agrega. Re-rodável sem recapturar. */
export async function validateSamples(a: ValidateArgs): Promise<ValidateResult> {
  let files: string[];
  try {
    files = await readdir(a.sampleDir);
  } catch {
    return { metrics: [], faceEvents: 0, reid_failures: 0 };
  }
  const sidecars = files.filter((f) => f.endsWith(".json") && f !== "report.json");
  const scored: ScoredSample[] = [];
  let reidFailures = 0;
  for (const sc of sidecars) {
    let m: ProbeSampleMeta;
    try {
      m = JSON.parse(await readFile(join(a.sampleDir, sc), "utf8")) as ProbeSampleMeta;
    } catch {
      continue;
    }
    let det: DetectResult = EMPTY;
    try {
      const img = await readFile(join(a.sampleDir, m.file));
      det = await detect(a.reidBaseUrl, img, m.content_type, m.file);
    } catch (err) {
      reidFailures += 1;
      if (err instanceof ReidError)
        logger.warn({ err: err.message, file: m.file }, "reid detect failed; counting as no-face");
      else logger.warn({ err, file: m.file }, "sample read error; counting as no-face");
    }
    scored.push({ meta: m, detect: det });
  }
  const eventCount = scored.filter((s) => s.meta.source === "event").length;
  const snapIdx = new Set(
    scored
      .filter((s) => s.meta.source === "snapshot" && s.meta.event_idx != null)
      .map((s) => s.meta.event_idx),
  );
  const faceEvents = Math.max(eventCount, snapIdx.size);
  const { metrics } = aggregate(scored, faceEvents, a.thresholds);
  return { metrics, faceEvents, reid_failures: reidFailures };
}
