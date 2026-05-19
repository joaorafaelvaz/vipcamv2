import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProbeSampleMeta } from "@vipcam/shared";
import type { DahuaHttpClient } from "../../ingest/dahua-http-client.js";
import { logger } from "../../obs/logger.js";
import { activeSampleDir, isProbeActive, noteSample } from "./state.js";

const SNAPSHOT_PATH = "/cgi-bin/snapshot.cgi?channel=1";

/** Over-sampling face filter: errs toward firing (wrong code guess must not
 * silently zero branch (b) evidence). Configurable via codeIncludes. */
export function isFaceish(
  evt: { code?: string; data?: unknown },
  codeIncludes: string[] = ["Face", "Object"],
): boolean {
  const code = evt.code ?? "";
  if (codeIncludes.some((c) => code.toLowerCase().includes(c.toLowerCase()))) return true;
  const d = evt.data;
  if (d && typeof d === "object") {
    const keys = Object.keys(d as Record<string, unknown>).join(",").toLowerCase();
    if (keys.includes("face") || keys.includes("object")) return true;
  }
  return false;
}

export function makeSnapshotSampler(client: DahuaHttpClient) {
  let seq = 0;
  return async function sample(evt: {
    idx: number;
    code?: string;
    data?: unknown;
    received_at: string;
  }): Promise<void> {
    try {
      if (!isProbeActive() || !isFaceish(evt)) return;
      const dir = activeSampleDir();
      if (!dir) return;
      const r = await client.get(SNAPSHOT_PATH);
      const ct = r.headers.get("content-type") ?? "";
      const buf = Buffer.from(await r.arrayBuffer());
      const n = seq++;
      const ext = ct.includes("jpeg") ? "jpg" : "bin";
      const evtMs = new Date(evt.received_at).getTime();
      const deltaMs = Number.isFinite(evtMs) ? Date.now() - evtMs : null;
      const meta: ProbeSampleMeta = {
        source: "snapshot",
        seq: n,
        event_idx: evt.idx,
        event_code: evt.code ?? null,
        event_ts: evt.received_at,
        captured_ts: new Date().toISOString(),
        delta_ms: deltaMs,
        content_type: ct,
        http_status: r.status,
        byte_len: buf.length,
        file: `snap-${n}.${ext}`,
      };
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, meta.file), buf);
      writeFileSync(join(dir, `snap-${n}.json`), JSON.stringify(meta));
      noteSample();
    } catch (err) {
      logger.warn({ err }, "image probe snapshot sampler error (ignored)");
    }
  };
}
