import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProbeSampleMeta } from "@vipcam/shared";
import { logger } from "../../obs/logger.js";
import { activeSampleDir, isProbeActive, noteSample } from "./state.js";
import { parseMultipartPartsRaw } from "./raw-multipart.js";

const MAX_QUEUE = 64;

export interface CaptureTap {
  (chunk: Buffer, boundary: string): void;
}

export function makeCaptureTap(): CaptureTap {
  let pending: Buffer = Buffer.alloc(0);
  let seq = 0;
  let inFlight = 0;
  let dropped = 0;
  let warnedDrop = false;

  return function tap(chunk: Buffer, boundary: string): void {
    try {
      if (!isProbeActive()) {
        pending = Buffer.alloc(0);
        return;
      }
      const dir = activeSampleDir();
      if (!dir) return;
      pending = Buffer.concat([pending, chunk]);
      const { parts, remainder } = parseMultipartPartsRaw(pending, boundary);
      pending = remainder;
      for (const p of parts) {
        const ct = p.headers["content-type"] ?? "";
        if (!ct.startsWith("image/")) continue;
        if (inFlight >= MAX_QUEUE) {
          dropped += 1;
          if (!warnedDrop) {
            warnedDrop = true;
            logger.warn({ dropped }, "image probe: sample queue full, dropping");
          }
          continue;
        }
        const n = seq++;
        const ext = ct.includes("jpeg") || ct.includes("jpg") ? "jpg" : "bin";
        const meta: ProbeSampleMeta = {
          source: "event",
          seq: n,
          event_idx: null,
          event_code: null,
          event_ts: null,
          captured_ts: new Date().toISOString(),
          delta_ms: null,
          content_type: ct,
          http_status: null,
          byte_len: p.body.length,
          file: `${n}.${ext}`,
        };
        inFlight += 1;
        queueMicrotask(() => {
          try {
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, meta.file), p.body);
            writeFileSync(join(dir, `${n}.json`), JSON.stringify(meta));
            noteSample();
          } catch (err) {
            logger.warn({ err }, "image probe: sample write failed");
          } finally {
            inFlight -= 1;
          }
        });
      }
    } catch (err) {
      logger.warn({ err }, "image probe tap error (ignored, ingest continues)");
    }
  };
}
