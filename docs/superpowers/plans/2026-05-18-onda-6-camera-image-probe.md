# Onda 6 — Camera Image-Source Probe Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an empirical probe that captures real per-detection camera images (event-embedded + snapshot.cgi), validates them with real InsightFace, and emits an a/b/c/d go/no-go decision report for the future Failover B re-id feature.

**Architecture:** Byte-level header-aware multipart parser tees the *already-open* production ingest stream (no 2nd camera connection) into a bounded sample store; a snapshot.cgi sampler runs in parallel; the `packages/reid` Python sidecar is bootstrapped with real InsightFace `buffalo_s` + `POST /detect`; a decoupled validation runner scores samples and a pure decision module concludes a/b/c/d. Capture and validation are decoupled (samples persist; validation re-runnable).

**Tech Stack:** Bun + Hono + TypeScript (edge), Python 3.11 + FastAPI + InsightFace + onnxruntime (reid), systemd, Zod.

**Spec:** `docs/superpowers/specs/2026-05-18-camera-image-source-probe-design.md` (spec-reviewer approved, commit `e5f34d7`).

**Branch:** `onda-6-camera-image-probe`.

**Environment note (offline dev):** No camera, no Postgres, no InsightFace locally. Offline-runnable gates: `bun run typecheck` (3/3, hard gate), pure unit tests (raw-multipart parser, decision module, tap-guard), reid `pytest` only where Python+InsightFace installed. Camera capture + InsightFace `/detect` + the decision report are **operational artifacts produced on the VPS** (the onda's whole point) — same deferred-validation pattern as Ondas 4/5; flag in summaries. Do NOT weaken tests to make them pass without the env.

---

## Chunk 1: Capture core — byte-level multipart parser + production-safe tap

### File Structure

- **Create** `packages/shared/src/types/discovery.ts` additions — `ProbeSampleMeta`, `ImageSourceConclusion` (types only; report types come in Chunk 3).
- **Create** `packages/edge/src/discovery/image-probe/raw-multipart.ts` — `parseMultipartPartsRaw` (pure, byte-level, header-aware). One responsibility: split a multipart buffer into `{headers, body:Buffer}` parts + remainder, binary-safe.
- **Create** `packages/edge/src/discovery/image-probe/state.ts` — runtime singleton: probe on/off, run config, counters, sample dir, hard ≤60min auto-expire. One responsibility: probe lifecycle state.
- **Create** `packages/edge/src/discovery/image-probe/capture-tap.ts` — `makeCaptureTap(state)`: byte tap that extracts `image/*` parts and persists samples (bounded queue, drop on backpressure).
- **Create** `packages/edge/src/discovery/image-probe/snapshot-sampler.ts` — on face-ish event, GET `snapshot.cgi`, persist sample + Δtiming; configurable over-sampling code filter.
- **Modify** `packages/edge/src/ingest/listener-stream.ts` — add injected optional `probeTap?` to `ConsumeStreamOptions` (keeps function pure).
- **Modify** `packages/edge/src/ingest/listener.ts:69-77` — pass `probeTap` from `state` when active (only production-path touch; guarded).
- **Tests:** `packages/edge/tests/unit/discovery/image-probe/raw-multipart.test.ts`, `.../tap-guard.test.ts`.

---

### Task 1.1: Shared sample/conclusion types

**Files:**
- Modify: `packages/shared/src/types/discovery.ts` (append)

- [ ] **Step 1: Append types**

Append to `packages/shared/src/types/discovery.ts`:

```ts
// ---- Onda 6: camera image-source probe ----
export type ProbeSampleSource = "event" | "snapshot";

export interface ProbeSampleMeta {
  source: ProbeSampleSource;
  seq: number;
  event_idx: number | null; // ingest event index correlated (snapshot/event)
  event_code: string | null; // Dahua event code if known
  event_ts: string | null; // ISO — when the correlated event was received
  captured_ts: string; // ISO — when this image was captured
  delta_ms: number | null; // snapshot only: captured_ts - event_ts
  content_type: string;
  http_status: number | null; // snapshot only
  byte_len: number;
  file: string; // relative filename within the run dir
}

export type ImageSourceConclusion =
  | "a_event_embedded"
  | "b_snapshot_cgi"
  | "c_recommend_rtsp_followup"
  | "d_infeasible"
  | "inconclusive";
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: exit 0, 3/3 (additive types, nothing consumes them yet).

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types/discovery.ts
git commit -m "$(cat <<'EOF'
feat(shared): Onda 6 — probe sample/conclusion types

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.2: Byte-level header-aware multipart parser (TDD — highest risk)

**Files:**
- Create: `packages/edge/src/discovery/image-probe/raw-multipart.ts`
- Test: `packages/edge/tests/unit/discovery/image-probe/raw-multipart.test.ts`

Mirrors the boundary/remainder semantics of `parseMultipartChunks` (`discovery/capture.ts:30-60`) but: (a) keeps each part's **headers** parsed into a map, (b) keeps the body as a raw **Buffer** (no utf8 decode — binary-safe), (c) same remainder rule (keep from last complete boundary).

- [ ] **Step 1: Write the failing test**

Create `packages/edge/tests/unit/discovery/image-probe/raw-multipart.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { parseMultipartPartsRaw } from "../../../../src/discovery/image-probe/raw-multipart.js";

const B = "--myboundary";

function part(headers: string, body: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${B}\r\n${headers}\r\n\r\n`),
    body,
    Buffer.from("\r\n"),
  ]);
}

describe("parseMultipartPartsRaw", () => {
  test("text part: headers parsed, body preserved", () => {
    const buf = Buffer.concat([
      part("Content-Type: text/plain", Buffer.from("Code=FaceDetection;action=Start")),
      Buffer.from(`${B}`),
    ]);
    const { parts } = parseMultipartPartsRaw(buf, B);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.headers["content-type"]).toBe("text/plain");
    expect(parts[0]!.body.toString("utf8")).toBe("Code=FaceDetection;action=Start");
  });

  test("binary image part with boundary-like bytes is NOT corrupted", () => {
    // body contains the ASCII of the boundary AND non-utf8 bytes
    const evil = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]), // JPEG SOI/APP0
      Buffer.from("--myboundaryISH-not-real"),
      Buffer.from([0x00, 0x80, 0xfe, 0xff]),
    ]);
    const buf = Buffer.concat([
      part("Content-Type: image/jpeg", evil),
      Buffer.from(`${B}`),
    ]);
    const { parts } = parseMultipartPartsRaw(buf, B);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.headers["content-type"]).toBe("image/jpeg");
    expect(Buffer.compare(parts[0]!.body, evil)).toBe(0); // byte-exact, no utf8 mangle
  });

  test("incomplete trailing part → remainder kept from last complete boundary", () => {
    const complete = part("Content-Type: text/plain", Buffer.from("a"));
    const partial = Buffer.from(`${B}\r\nContent-Type: image/jpeg\r\n\r\n\xff\xd8`); // no closing boundary
    const buf = Buffer.concat([complete, partial]);
    const { parts, remainder } = parseMultipartPartsRaw(buf, B);
    expect(parts).toHaveLength(1);
    // remainder must still contain the boundary so next concat re-parses it
    expect(remainder.indexOf(Buffer.from(B))).toBeGreaterThanOrEqual(0);
  });

  test("multiple parts in one buffer", () => {
    const buf = Buffer.concat([
      part("Content-Type: text/plain", Buffer.from("x")),
      part("Content-Type: image/jpeg", Buffer.from([0x01, 0x02])),
      Buffer.from(`${B}`),
    ]);
    const { parts } = parseMultipartPartsRaw(buf, B);
    expect(parts.map((p) => p.headers["content-type"])).toEqual(["text/plain", "image/jpeg"]);
  });

  test("no boundary yet → no parts, whole buffer is remainder", () => {
    const buf = Buffer.from("partial bytes no boundary");
    const { parts, remainder } = parseMultipartPartsRaw(buf, B);
    expect(parts).toHaveLength(0);
    expect(remainder.length).toBe(buf.length);
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd packages/edge && bun test tests/unit/discovery/image-probe/raw-multipart.test.ts`
Expected: FAIL — module `raw-multipart.js` not found.

- [ ] **Step 3: Implement**

Create `packages/edge/src/discovery/image-probe/raw-multipart.ts`:

```typescript
/**
 * Parser multipart/x-mixed-replace byte-level e header-aware (Onda 6).
 *
 * Diferente de discovery/capture.ts:parseMultipartChunks (que faz
 * .toString("utf8") e descarta headers — corromperia image/jpeg), aqui
 * preservamos os headers de cada parte e o BODY como Buffer cru. Mesma
 * semântica de boundary/remainder (mantém do último boundary completo).
 */
export interface RawPart {
  headers: Record<string, string>; // lower-cased keys
  body: Buffer;
}
export interface RawParseResult {
  parts: RawPart[];
  remainder: Buffer;
}

const CRLF2 = Buffer.from("\r\n\r\n");
const LF2 = Buffer.from("\n\n");

function parseHeaders(headerBytes: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of headerBytes.toString("latin1").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

export function parseMultipartPartsRaw(buf: Buffer, boundary: string): RawParseResult {
  const bb = Buffer.from(boundary);
  const parts: RawPart[] = [];
  let cursor = 0;
  let lastBoundary = 0;

  while (true) {
    const idx = buf.indexOf(bb, cursor);
    if (idx < 0) break;
    const next = buf.indexOf(bb, idx + bb.length);
    if (next < 0) break; // closing boundary not arrived → stop, keep remainder
    const partBuf = buf.subarray(idx + bb.length, next);

    let sepIdx = partBuf.indexOf(CRLF2);
    let sepLen = CRLF2.length;
    if (sepIdx < 0) {
      sepIdx = partBuf.indexOf(LF2);
      sepLen = LF2.length;
    }
    if (sepIdx >= 0) {
      const headers = parseHeaders(partBuf.subarray(0, sepIdx));
      // body: between header sep and the trailing CRLF before next boundary
      let body = partBuf.subarray(sepIdx + sepLen);
      // trim a single leading CRLF/LF and trailing CRLF/LF (delimiters), byte-safe
      if (body.length >= 2 && body[0] === 0x0d && body[1] === 0x0a) body = body.subarray(2);
      else if (body.length >= 1 && body[0] === 0x0a) body = body.subarray(1);
      if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
        body = body.subarray(0, body.length - 2);
      } else if (body.length >= 1 && body[body.length - 1] === 0x0a) {
        body = body.subarray(0, body.length - 1);
      }
      if (body.length > 0) parts.push({ headers, body: Buffer.from(body) });
    }
    cursor = next;
    lastBoundary = next;
  }

  return { parts, remainder: Buffer.from(buf.subarray(lastBoundary)) };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd packages/edge && bun test tests/unit/discovery/image-probe/raw-multipart.test.ts`
Expected: PASS (5/5). If the remainder/trim assertions fail, adjust delimiter trimming **without** changing the binary-safety guarantee (the byte-exact image test is the invariant that must hold).

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck` → 3/3.

```bash
git add packages/edge/src/discovery/image-probe/raw-multipart.ts packages/edge/tests/unit/discovery/image-probe/raw-multipart.test.ts
git commit -m "$(cat <<'EOF'
feat(edge): Onda 6 — byte-level header-aware multipart parser

Binary-safe (no utf8 decode) part splitter preserving headers, for
extracting image/* parts from the camera event stream. Mirrors
parseMultipartChunks boundary/remainder semantics.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.3: Probe state singleton (lifecycle + auto-expire)

**Files:**
- Create: `packages/edge/src/discovery/image-probe/state.ts`
- Test: `packages/edge/tests/unit/discovery/image-probe/state.test.ts`

One responsibility: hold probe on/off + run config + counters + sample dir; enforce hard ≤60min auto-expire; idempotent start/stop; status snapshot. No camera/network here.

- [ ] **Step 1: Write the failing test**

Create `packages/edge/tests/unit/discovery/image-probe/state.test.ts`:

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import {
  _resetImageProbe,
  imageProbeStatus,
  isProbeActive,
  startImageProbe,
  stopImageProbe,
} from "../../../../src/discovery/image-probe/state.js";

afterEach(() => _resetImageProbe());

describe("image probe state", () => {
  test("inactive by default", () => {
    expect(isProbeActive()).toBe(false);
    expect(imageProbeStatus().active).toBe(false);
  });

  test("start activates with runId + clamps window to 60min", () => {
    const s = startImageProbe({ windowMinutes: 999, maxSamples: 10, sampleDir: "/tmp/x" });
    expect(s.active).toBe(true);
    expect(s.run_id).toMatch(/^run-/);
    expect(s.window_minutes).toBe(60); // hard cap
    expect(isProbeActive()).toBe(true);
  });

  test("start is idempotent (returns existing run if already active)", () => {
    const a = startImageProbe({ windowMinutes: 5, maxSamples: 10, sampleDir: "/tmp/x" });
    const b = startImageProbe({ windowMinutes: 5, maxSamples: 10, sampleDir: "/tmp/x" });
    expect(b.run_id).toBe(a.run_id);
  });

  test("stop deactivates", () => {
    startImageProbe({ windowMinutes: 5, maxSamples: 10, sampleDir: "/tmp/x" });
    stopImageProbe();
    expect(isProbeActive()).toBe(false);
  });

  test("auto-expire deactivates after window", async () => {
    startImageProbe({ windowMinutes: 0.001, maxSamples: 10, sampleDir: "/tmp/x" }); // ~60ms
    await new Promise((r) => setTimeout(r, 120));
    expect(isProbeActive()).toBe(false);
  });

  test("reaching maxSamples flips inactive via noteSample", () => {
    const { noteSample } = require("../../../../src/discovery/image-probe/state.js");
    startImageProbe({ windowMinutes: 5, maxSamples: 2, sampleDir: "/tmp/x" });
    noteSample();
    expect(isProbeActive()).toBe(true);
    noteSample();
    expect(isProbeActive()).toBe(false); // cap reached
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd packages/edge && bun test tests/unit/discovery/image-probe/state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/edge/src/discovery/image-probe/state.ts`:

```typescript
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
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd packages/edge && bun test tests/unit/discovery/image-probe/state.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck` → 3/3.

```bash
git add packages/edge/src/discovery/image-probe/state.ts packages/edge/tests/unit/discovery/image-probe/state.test.ts
git commit -m "$(cat <<'EOF'
feat(edge): Onda 6 — image probe state singleton (auto-expire, sample cap)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.4: Capture tap + snapshot sampler

**Files:**
- Create: `packages/edge/src/discovery/image-probe/capture-tap.ts`
- Create: `packages/edge/src/discovery/image-probe/snapshot-sampler.ts`
- Test: `packages/edge/tests/unit/discovery/image-probe/capture-tap.test.ts`

`capture-tap.ts` — `makeCaptureTap(): (chunk: Buffer, boundary: string) => void`. Maintains its own rolling buffer, runs `parseMultipartPartsRaw`, and for each part whose `content-type` starts with `image/`, writes the body + a `ProbeSampleMeta` sidecar JSON into `activeSampleDir()`, then `noteSample()`. Persistence is **fire-and-forget** via a bounded in-memory queue; if queue is full, **drop** (increment a dropped counter, log once). Never throws to the caller (wrap everything; log + swallow).

`snapshot-sampler.ts` — `makeSnapshotSampler(client, opts)`: given a parsed event `{idx, code, received_at}`, if the code matches the **over-sampling face filter** (default: code includes `Face` OR data has an `Object`/face-ish key — configurable; errs toward firing), GET `/cgi-bin/snapshot.cgi?channel=1`, persist image + meta with `delta_ms`. Independent of the stream.

- [ ] **Step 1: Write the failing test (capture tap, fs-backed temp dir)**

Create `packages/edge/tests/unit/discovery/image-probe/capture-tap.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCaptureTap } from "../../../../src/discovery/image-probe/capture-tap.js";
import { _resetImageProbe, startImageProbe } from "../../../../src/discovery/image-probe/state.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "probe-"));
});
afterEach(() => {
  _resetImageProbe();
  rmSync(dir, { recursive: true, force: true });
});

const B = "--myboundary";
function imgPart(): Buffer {
  return Buffer.concat([
    Buffer.from(`${B}\r\nContent-Type: image/jpeg\r\n\r\n`),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from(`\r\n${B}`),
  ]);
}

describe("capture tap", () => {
  test("persists image part as sample + sidecar when probe active", async () => {
    startImageProbe({ windowMinutes: 5, maxSamples: 10, sampleDir: dir });
    const tap = makeCaptureTap();
    tap(imgPart(), B);
    await new Promise((r) => setTimeout(r, 50)); // let fire-and-forget flush
    const files = readdirSync(dir);
    expect(files.some((f) => f.endsWith(".jpg") || f.endsWith(".bin"))).toBe(true);
    expect(files.some((f) => f.endsWith(".json"))).toBe(true);
  });

  test("no-op when probe inactive (no files, no throw)", async () => {
    const tap = makeCaptureTap();
    expect(() => tap(imgPart(), B)).not.toThrow();
    await new Promise((r) => setTimeout(r, 30));
    expect(readdirSync(dir)).toHaveLength(0);
  });

  test("tap never throws even on garbage input", () => {
    startImageProbe({ windowMinutes: 5, maxSamples: 10, sampleDir: dir });
    const tap = makeCaptureTap();
    expect(() => tap(Buffer.from([0x00, 0x01, 0x02]), B)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd packages/edge && bun test tests/unit/discovery/image-probe/capture-tap.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `capture-tap.ts`**

```typescript
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
  let pending = Buffer.alloc(0);
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
        // fire-and-forget persist (sync write off the socket read path is OK
        // here since tap is already called fire-and-forget by consumeStream;
        // keep it minimal)
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
```

- [ ] **Step 4: Run capture-tap test — PASS**

Run: `cd packages/edge && bun test tests/unit/discovery/image-probe/capture-tap.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Implement `snapshot-sampler.ts`**

```typescript
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
      const t0 = Date.now();
      const r = await client.get(SNAPSHOT_PATH);
      const ct = r.headers.get("content-type") ?? "";
      const buf = Buffer.from(await r.arrayBuffer());
      const n = seq++;
      const ext = ct.includes("jpeg") ? "jpg" : "bin";
      const meta: ProbeSampleMeta = {
        source: "snapshot",
        seq: n,
        event_idx: evt.idx,
        event_code: evt.code ?? null,
        event_ts: evt.received_at,
        captured_ts: new Date().toISOString(),
        delta_ms: Date.now() - new Date(evt.received_at).getTime(),
        content_type: ct,
        http_status: r.status,
        byte_len: buf.length,
        file: `snap-${n}.${ext}`,
      };
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, meta.file), buf);
      writeFileSync(join(dir, `snap-${n}.json`), JSON.stringify(meta));
      noteSample();
      void t0;
    } catch (err) {
      logger.warn({ err }, "image probe snapshot sampler error (ignored)");
    }
  };
}
```

- [ ] **Step 6: Typecheck + commit**

Run: `bun run typecheck` → 3/3.

```bash
git add packages/edge/src/discovery/image-probe/capture-tap.ts packages/edge/src/discovery/image-probe/snapshot-sampler.ts packages/edge/tests/unit/discovery/image-probe/capture-tap.test.ts
git commit -m "$(cat <<'EOF'
feat(edge): Onda 6 — capture tap + snapshot.cgi sampler

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.5: Wire injected `probeTap` into ingest (production path, guarded)

**Files:**
- Modify: `packages/edge/src/ingest/listener-stream.ts`
- Modify: `packages/edge/src/ingest/listener.ts`
- Test: `packages/edge/tests/unit/discovery/image-probe/tap-guard.test.ts`

`consumeStream` stays a pure function — add an **optional injected** `probeTap?: (chunk: Buffer, boundary: string) => void` to `ConsumeStreamOptions`; call it (try/caught) right after `pending = Buffer.concat(...)` and before `parseMultipartChunks`. `listener.ts` supplies it from state: `probeTap: isProbeActive() ? sharedCaptureTap : undefined` (sharedCaptureTap = a module-singleton `makeCaptureTap()` created once). The snapshot sampler is invoked from `listener.ts`'s `onEvent`.

- [ ] **Step 1: Write the failing guard test**

Create `packages/edge/tests/unit/discovery/image-probe/tap-guard.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { consumeStream } from "../../../../src/ingest/listener-stream.js";

function readerFrom(chunks: Uint8Array[]) {
  let i = 0;
  return {
    read: async () =>
      i < chunks.length ? { done: false, value: chunks[i++]! } : { done: true, value: undefined },
    cancel: async () => {},
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}
const B = "--myboundary";
const evt = Buffer.from(`${B}\r\nContent-Type: text/plain\r\n\r\nCode=Test;action=Start\r\n${B}`);

describe("consumeStream probeTap injection", () => {
  test("no probeTap → behaves exactly as before (events dispatched)", async () => {
    const seen: string[] = [];
    await consumeStream({
      reader: readerFrom([new Uint8Array(evt)]),
      boundary: B,
      signal: new AbortController().signal,
      onEvent: (e) => seen.push(e.raw),
    });
    expect(seen.length).toBeGreaterThan(0);
  });

  test("probeTap that THROWS does not break ingest (events still dispatched)", async () => {
    const seen: string[] = [];
    await consumeStream({
      reader: readerFrom([new Uint8Array(evt)]),
      boundary: B,
      signal: new AbortController().signal,
      onEvent: (e) => seen.push(e.raw),
      probeTap: () => {
        throw new Error("boom");
      },
    });
    expect(seen.length).toBeGreaterThan(0); // ingest unaffected
  });

  test("probeTap receives chunk bytes + boundary", async () => {
    let got: { len: number; b: string } | null = null;
    await consumeStream({
      reader: readerFrom([new Uint8Array(evt)]),
      boundary: B,
      signal: new AbortController().signal,
      onEvent: () => {},
      probeTap: (chunk, b) => {
        got = { len: chunk.length, b };
      },
    });
    expect(got).not.toBeNull();
    expect(got!.b).toBe(B);
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd packages/edge && bun test tests/unit/discovery/image-probe/tap-guard.test.ts`
Expected: FAIL — `probeTap` not a known option / not invoked.

- [ ] **Step 3: Modify `listener-stream.ts`**

Add to `ConsumeStreamOptions` interface:

```typescript
  /** Onda 6: tap opcional injetado p/ o image-probe. Recebe os bytes crus
   *  do chunk + boundary ANTES do parse string. Exceções são engolidas —
   *  nunca quebram o ingest. Ausente = comportamento idêntico ao anterior. */
  probeTap?: (chunk: Buffer, boundary: string) => void;
```

In the loop, change the concat/parse section to call the tap (insert right after `if (value) pending = Buffer.concat([pending, Buffer.from(value)]);`):

```typescript
      if (value) {
        const chunkBuf = Buffer.from(value);
        pending = Buffer.concat([pending, chunkBuf]);
        if (opts.probeTap) {
          try {
            opts.probeTap(chunkBuf, opts.boundary);
          } catch {
            /* probe é best-effort — nunca quebra o ingest */
          }
        }
      }
```

(Remove the old standalone `if (value) pending = Buffer.concat(...)` line replaced above.)

- [ ] **Step 4: Run guard test — PASS**

Run: `cd packages/edge && bun test tests/unit/discovery/image-probe/tap-guard.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Modify `listener.ts` to supply tap + snapshot sampler**

In `packages/edge/src/ingest/listener.ts`: add imports + a module singleton, and wire into `consumeStream` in `runOnce`:

```typescript
import { makeCaptureTap } from "../discovery/image-probe/capture-tap.js";
import { makeSnapshotSampler } from "../discovery/image-probe/snapshot-sampler.js";
import { isProbeActive } from "../discovery/image-probe/state.js";
```

Create singletons once (module scope): `const captureTap = makeCaptureTap();` and inside `startListener`/`runOnce` (it has `client`): `const snapshotSampler = makeSnapshotSampler(client);`. Then in `consumeStream({...})`:

```typescript
  await consumeStream({
    reader: response.body.getReader(),
    boundary,
    signal: abortCtrl.signal,
    probeTap: isProbeActive() ? captureTap : undefined,
    onEvent: (captured) => {
      void processEvent(captured, camera.id);
      if (isProbeActive() && captured.parsed) {
        void snapshotSampler({
          idx: captured.index,
          code: captured.parsed.code,
          data: captured.parsed.data,
          received_at: captured.received_at,
        });
      }
    },
  });
```

Note: `probeTap` is resolved once per connection (per `runOnce`); the listener reconnects periodically (backoff loop) so toggling the probe takes effect on the next reconnect within seconds — acceptable for an operational probe. Document this in the route's response ("probe ativa no próximo ciclo de reconexão do listener, ≤ alguns segundos"). The `onEvent` check is per-event (immediate) for the snapshot sampler.

- [ ] **Step 6: Typecheck + full edge unit suite + commit**

Run: `bun run typecheck` → 3/3.
Run: `cd packages/edge && bun test tests/unit` → all pass (new image-probe tests + existing ingest tests green; `listener` has no unit test that asserts exact consumeStream call shape — verify nothing regressed).

```bash
git add packages/edge/src/ingest/listener-stream.ts packages/edge/src/ingest/listener.ts packages/edge/tests/unit/discovery/image-probe/tap-guard.test.ts
git commit -m "$(cat <<'EOF'
feat(edge): Onda 6 — inject guarded probeTap into ingest stream

consumeStream gains optional injected probeTap (pure; absent = identical
behavior; throwing tap cannot break ingest). listener supplies the
capture tap + snapshot sampler only while the probe is active.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Chunk 1 review gate

Dispatch spec-compliance + code-quality reviews (subagent-driven-development) for Chunk 1 before Chunk 2. Gate: `bun run typecheck` 3/3, all edge unit suites green; production ingest path provably unaffected when probe inactive (tap-guard tests).

---

## Chunk 2: reid sidecar — real InsightFace `/detect` + systemd

### File Structure

- **Modify** `packages/reid/pyproject.toml` — add InsightFace runtime deps.
- **Modify** `packages/reid/src/main.py` — add `POST /detect`.
- **Create** `packages/reid/tests/test_detect.py` — pytest (face fixture vs blank).
- **Create** `packages/reid/tests/fixtures/` — one face image + one blank image.
- **Modify** `infra/systemd/vipcam-reid.service.example` — fix stale `/home/vipcam` → `/var/lib/vipcam`, add `HOME`/`INSIGHTFACE_HOME`, fix `ReadWritePaths`.
- **Modify** `infra/install.sh` — optionally install `vipcam-reid` unit for this onda (documented, opt-in).

> **Environment note:** InsightFace + onnxruntime are heavy and not installed in offline dev. The reid pytest runs only where Python 3.11 + the deps + the `buffalo_s` model are available (VPS or a provisioned CI). Locally: validate `pyproject.toml` parses and `main.py` imports are syntactically correct (`python -m py_compile`); flag detect-test as VPS-deferred.

---

### Task 2.1: Add InsightFace deps + `/detect` endpoint

**Files:**
- Modify: `packages/reid/pyproject.toml`
- Modify: `packages/reid/src/main.py`

- [ ] **Step 1: Add deps to `pyproject.toml`**

Add to `[project].dependencies`:

```toml
  "insightface>=0.7.3",
  "onnxruntime>=1.19.0",
  "numpy>=1.26,<2.0",
  "pillow>=10.4.0",
  "python-multipart>=0.0.9",
```

- [ ] **Step 2: Implement `/detect` in `main.py`**

Replace `packages/reid/src/main.py` with:

```python
"""vipcam-reid sidecar — Onda 6: InsightFace buffalo_s (CPU) face detection.

/detect resolve o gate do Failover B: dado uma imagem, retorna faces
detectadas (bbox px na imagem nativa + det_score) e infer_ms. /health mantido.
"""
import io
import os
import time

import numpy as np
from fastapi import FastAPI, File, UploadFile
from PIL import Image
from pydantic import BaseModel

app = FastAPI(title="vipcam-reid", version="0.1.0")

# INSIGHTFACE_HOME deve apontar p/ um path em ReadWritePaths do systemd unit
# (default ~/.insightface é bloqueado por ProtectHome=read-only).
_MODEL = None


def _model():
    global _MODEL
    if _MODEL is None:
        from insightface.app import FaceAnalysis

        _MODEL = FaceAnalysis(name="buffalo_s", providers=["CPUExecutionProvider"])
        _MODEL.prepare(ctx_id=-1, det_size=(640, 640))
    return _MODEL


class HealthResponse(BaseModel):
    status: str
    version: str


class Face(BaseModel):
    bbox: list[float]  # [x, y, w, h] px na imagem nativa
    det_score: float


class DetectResponse(BaseModel):
    faces: list[Face]
    width: int
    height: int
    infer_ms: int


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="healthy", version="0.1.0")


@app.post("/detect", response_model=DetectResponse)
async def detect(file: UploadFile = File(...)) -> DetectResponse:
    raw = await file.read()
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    w, h = img.size
    arr = np.asarray(img)[:, :, ::-1]  # RGB->BGR p/ InsightFace
    t0 = time.monotonic()
    faces = _model().get(arr)
    infer_ms = int((time.monotonic() - t0) * 1000)
    out = []
    for f in faces:
        x1, y1, x2, y2 = f.bbox
        out.append(Face(bbox=[float(x1), float(y1), float(x2 - x1), float(y2 - y1)],
                         det_score=float(f.det_score)))
    return DetectResponse(faces=out, width=w, height=h, infer_ms=infer_ms)
```

- [ ] **Step 3: Local syntax validation (no InsightFace install)**

Run: `cd packages/reid && python -m py_compile src/main.py && echo "py_compile OK"`
Expected: `py_compile OK` (imports are lazy via `_model()`; module import does not require InsightFace, only numpy/PIL/fastapi which py_compile does not execute — compile only checks syntax). If `uv` is available locally and deps resolve, optionally `uv sync` — otherwise defer to VPS.

- [ ] **Step 4: Commit**

```bash
git add packages/reid/pyproject.toml packages/reid/src/main.py
git commit -m "$(cat <<'EOF'
feat(reid): Onda 6 — InsightFace buffalo_s /detect endpoint

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.2: reid pytest (face fixture vs blank)

**Files:**
- Create: `packages/reid/tests/test_detect.py`
- Create: `packages/reid/tests/fixtures/face.jpg`, `packages/reid/tests/fixtures/blank.jpg`

- [ ] **Step 1: Add fixtures**

Generate a blank image and obtain a face image. Blank: `python -c "from PIL import Image; Image.new('RGB',(640,480),'white').save('packages/reid/tests/fixtures/blank.jpg')"`. Face: use any small public-domain face photo committed as `face.jpg` (a clearly frontal face, ≥200px). (If no face image is available offline, create the test to be `@pytest.mark.skipif` when fixture missing, and document that the VPS run must add a real face fixture — but prefer committing one now.)

- [ ] **Step 2: Write the test**

Create `packages/reid/tests/test_detect.py`:

```python
import os
import pytest
from fastapi.testclient import TestClient
from src.main import app

client = TestClient(app)
FIX = os.path.join(os.path.dirname(__file__), "fixtures")
HAS_FACE = os.path.exists(os.path.join(FIX, "face.jpg"))


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "healthy"


@pytest.mark.skipif(not HAS_FACE, reason="face fixture not committed")
def test_detect_finds_face():
    with open(os.path.join(FIX, "face.jpg"), "rb") as f:
        r = client.post("/detect", files={"file": ("face.jpg", f, "image/jpeg")})
    assert r.status_code == 200
    body = r.json()
    assert len(body["faces"]) >= 1
    assert body["faces"][0]["det_score"] >= 0.5
    assert body["infer_ms"] >= 0


def test_detect_blank_no_face():
    with open(os.path.join(FIX, "blank.jpg"), "rb") as f:
        r = client.post("/detect", files={"file": ("blank.jpg", f, "image/jpeg")})
    assert r.status_code == 200
    assert r.json()["faces"] == []
```

- [ ] **Step 3: Run where deps exist (else document deferral)**

Run (VPS/CI with deps): `cd packages/reid && uv run pytest -q`
Expected: `test_health` + `test_detect_blank_no_face` + `test_detect_finds_face` pass. **Offline:** cannot run (InsightFace/onnxruntime not installed) — flag as VPS-deferred per Environment note; do NOT delete/skip-by-default the face test (the skipif is fixture-presence, not env).

- [ ] **Step 4: Commit**

```bash
git add packages/reid/tests/
git commit -m "$(cat <<'EOF'
test(reid): Onda 6 — /detect pytest (face fixture vs blank)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.3: Fix `vipcam-reid` systemd unit (home moved in Onda 4 D3)

**Files:**
- Modify: `infra/systemd/vipcam-reid.service.example`

The example still references `/home/vipcam/.local/bin/uv` and `ReadWritePaths` lacking the InsightFace model cache. Onda 4 D3 moved the service-user home to `/var/lib/vipcam`.

- [ ] **Step 1: Edit the unit**

In `infra/systemd/vipcam-reid.service.example`:
- `Environment=PATH=/usr/local/bin:/usr/bin:/bin:/var/lib/vipcam/.local/bin`
- add `Environment=HOME=/var/lib/vipcam`
- add `Environment=INSIGHTFACE_HOME=/var/lib/vipcam/.insightface`
- `ExecStart=/var/lib/vipcam/.local/bin/uv run uvicorn src.main:app --host 127.0.0.1 --port 5005`
- `ReadWritePaths=/var/log/vipcam /opt/vipcamv2/packages/reid/.venv /var/lib/vipcam`

(`/var/lib/vipcam` covers `.insightface` model cache + uv cache; it's already a dedicated writable dir from Onda 4 D3.)

- [ ] **Step 2: Validate**

Run: `grep -nE 'HOME=|INSIGHTFACE_HOME=|ExecStart=|ReadWritePaths=' infra/systemd/vipcam-reid.service.example`
Expected: shows `/var/lib/vipcam` in PATH, HOME, INSIGHTFACE_HOME, ExecStart, ReadWritePaths (no `/home/vipcam`).

- [ ] **Step 3: Commit**

```bash
git add infra/systemd/vipcam-reid.service.example
git commit -m "$(cat <<'EOF'
fix(infra): vipcam-reid unit — /var/lib/vipcam home + INSIGHTFACE_HOME

Onda 4 D3 moved the service-user home; the reid unit example still
pointed at /home/vipcam and lacked a writable InsightFace model cache.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Chunk 2 review gate

Dispatch spec-compliance + code-quality reviews for Chunk 2. Gate: `python -m py_compile` OK, pyproject valid, unit file correct, systemd unit corrected. reid `/detect` runtime behavior is VPS-deferred (flagged).

---

## Chunk 3: Validation, decision, report + API

### File Structure

- **Create** `packages/shared/src/types/discovery.ts` additions — `DetectFace`, `DetectResult`, `ImageSourceProbeReport`.
- **Create** `packages/edge/src/discovery/image-probe/reid-client.ts` — thin HTTP client to reid `/detect`.
- **Create** `packages/edge/src/discovery/image-probe/decision.ts` — pure: aggregated metrics + thresholds → conclusion + evidence. Heavy TDD.
- **Create** `packages/edge/src/discovery/image-probe/validate.ts` — read samples dir, call reid, aggregate per-source metrics.
- **Create** `packages/edge/src/discovery/image-probe/report.ts` — build JSON report + render markdown decision doc.
- **Create** `packages/edge/src/api/routes/image-probe.ts` — `createImageProbeRoutes(deps)`: start/stop/status/validate.
- **Modify** `packages/edge/src/api/server.ts` — mount at `/api/discovery/image-probe` with `requireKey`.
- **Tests:** `.../decision.test.ts`, `.../image-probe-route.test.ts`.

---

### Task 3.1: Shared report types

**Files:** Modify `packages/shared/src/types/discovery.ts` (append)

- [ ] **Step 1: Append**

```ts
export interface DetectFace {
  bbox: [number, number, number, number]; // x,y,w,h px
  det_score: number;
}
export interface DetectResult {
  faces: DetectFace[];
  width: number;
  height: number;
  infer_ms: number;
}
export interface SourceMetrics {
  source: ProbeSampleSource;
  samples: number;
  with_image: number; // event: parts that were image/*; snapshot: http image responses
  usable_face: number; // ≥1 face det_score≥thr & bbox≥minPx
  median_bbox_px: number | null;
  median_infer_ms: number | null;
  median_delta_ms: number | null; // snapshot only
}
export interface ImageSourceProbeReport {
  generated_at: string;
  run_id: string;
  thresholds: {
    min_event_image_rate: number;
    min_face_rate: number;
    min_det_score: number;
    min_bbox_px: number;
    min_snapshot_image_rate: number;
    max_snapshot_delta_ms: number;
    min_samples: number;
  };
  face_events_captured: number;
  metrics: SourceMetrics[];
  conclusion: ImageSourceConclusion;
  evidence: string[];
  failover_b_recommendation: string;
}
```

- [ ] **Step 2: Typecheck → 3/3. Commit.**

```bash
git add packages/shared/src/types/discovery.ts
git commit -m "feat(shared): Onda 6 — image-source probe report types

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3.2: Pure decision module (TDD — the gate logic)

**Files:**
- Create: `packages/edge/src/discovery/image-probe/decision.ts`
- Test: `packages/edge/tests/unit/discovery/image-probe/decision.test.ts`

Pure function: given `SourceMetrics[]` (event + snapshot), `face_events_captured`, and thresholds → `{conclusion, evidence[], failover_b_recommendation}` per spec §5. Default thresholds = spec defaults.

- [ ] **Step 1: Write the failing test**

Create `packages/edge/tests/unit/discovery/image-probe/decision.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { DEFAULT_THRESHOLDS, decide } from "../../../../src/discovery/image-probe/decision.js";
import type { SourceMetrics } from "@vipcam/shared";

const ev = (o: Partial<SourceMetrics>): SourceMetrics => ({
  source: "event", samples: 0, with_image: 0, usable_face: 0,
  median_bbox_px: null, median_infer_ms: null, median_delta_ms: null, ...o,
});
const sn = (o: Partial<SourceMetrics>): SourceMetrics => ({ ...ev(o), source: "snapshot" });

describe("decide", () => {
  test("<30 face events → inconclusive", () => {
    const r = decide({ faceEvents: 10, metrics: [ev({ samples: 10 })], thresholds: DEFAULT_THRESHOLDS });
    expect(r.conclusion).toBe("inconclusive");
  });

  test("strong event-embedded → a", () => {
    const r = decide({
      faceEvents: 40,
      metrics: [ev({ samples: 40, with_image: 36, usable_face: 32, median_bbox_px: 120 })],
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(r.conclusion).toBe("a_event_embedded");
  });

  test("event weak, snapshot strong & aligned → b", () => {
    const r = decide({
      faceEvents: 40,
      metrics: [
        ev({ samples: 40, with_image: 2, usable_face: 1 }),
        sn({ samples: 40, with_image: 39, usable_face: 31, median_delta_ms: 800, median_bbox_px: 100 }),
      ],
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(r.conclusion).toBe("b_snapshot_cgi");
  });

  test("both weak but images exist w/o usable faces → d", () => {
    const r = decide({
      faceEvents: 40,
      metrics: [
        ev({ samples: 40, with_image: 38, usable_face: 1 }),
        sn({ samples: 40, with_image: 39, usable_face: 0, median_delta_ms: 800 }),
      ],
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(r.conclusion).toBe("d_infeasible");
  });

  test("both weak, no images at all → c (recommend rtsp)", () => {
    const r = decide({
      faceEvents: 40,
      metrics: [ev({ samples: 40, with_image: 0 }), sn({ samples: 40, with_image: 0 })],
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(r.conclusion).toBe("c_recommend_rtsp_followup");
  });

  test("thresholds parametrizable", () => {
    const lax = { ...DEFAULT_THRESHOLDS, min_face_rate: 0.1 };
    const r = decide({
      faceEvents: 40,
      metrics: [ev({ samples: 40, with_image: 36, usable_face: 5, median_bbox_px: 90 })],
      thresholds: lax,
    });
    expect(r.conclusion).toBe("a_event_embedded");
  });
});
```

- [ ] **Step 2: Run, expect fail.** `cd packages/edge && bun test tests/unit/discovery/image-probe/decision.test.ts` → module not found.

- [ ] **Step 3: Implement `decision.ts`**

```typescript
import type { ImageSourceConclusion, ImageSourceProbeReport, SourceMetrics } from "@vipcam/shared";

export type Thresholds = ImageSourceProbeReport["thresholds"];

export const DEFAULT_THRESHOLDS: Thresholds = {
  min_event_image_rate: 0.7,
  min_face_rate: 0.8,
  min_det_score: 0.5,
  min_bbox_px: 80,
  min_snapshot_image_rate: 0.95,
  max_snapshot_delta_ms: 2000,
  min_samples: 30,
};

export interface DecideArgs {
  faceEvents: number;
  metrics: SourceMetrics[];
  thresholds: Thresholds;
}
export interface Decision {
  conclusion: ImageSourceConclusion;
  evidence: string[];
  failover_b_recommendation: string;
}

const rate = (num: number, den: number) => (den > 0 ? num / den : 0);

export function decide(a: DecideArgs): Decision {
  const t = a.thresholds;
  const ev = a.metrics.find((m) => m.source === "event");
  const sn = a.metrics.find((m) => m.source === "snapshot");
  const evidence: string[] = [];

  if (a.faceEvents < t.min_samples) {
    return {
      conclusion: "inconclusive",
      evidence: [`Apenas ${a.faceEvents} eventos de face (< ${t.min_samples}). Repetir em horário de movimento.`],
      failover_b_recommendation: "Inconclusivo — re-rodar o probe com janela maior / horário de pico antes de decidir.",
    };
  }

  // (a) event-embedded
  const evImgRate = ev ? rate(ev.with_image, ev.samples) : 0;
  const evFaceRate = ev ? rate(ev.usable_face, ev.with_image) : 0;
  evidence.push(`event: img_rate=${evImgRate.toFixed(2)} face_rate=${evFaceRate.toFixed(2)} bbox=${ev?.median_bbox_px ?? "—"}px`);
  const aOk = evImgRate >= t.min_event_image_rate && evFaceRate >= t.min_face_rate;

  // (b) snapshot.cgi
  const snImgRate = sn ? rate(sn.with_image, sn.samples) : 0;
  const snFaceRate = sn ? rate(sn.usable_face, sn.with_image) : 0;
  const snAligned = sn?.median_delta_ms != null && sn.median_delta_ms <= t.max_snapshot_delta_ms;
  evidence.push(`snapshot: img_rate=${snImgRate.toFixed(2)} face_rate=${snFaceRate.toFixed(2)} Δ=${sn?.median_delta_ms ?? "—"}ms`);
  const bOk = snImgRate >= t.min_snapshot_image_rate && snFaceRate >= t.min_face_rate && !!snAligned;

  if (aOk) {
    return { conclusion: "a_event_embedded", evidence,
      failover_b_recommendation: "Failover B: extrair a parte image/* do evento eventManager.cgi por detecção (fonte síncrona, sem round-trip extra)." };
  }
  if (bOk) {
    return { conclusion: "b_snapshot_cgi", evidence,
      failover_b_recommendation: "Failover B: disparar snapshot.cgi no evento de face (alinhamento temporal aceitável); embutir no pipeline pós-detecção." };
  }

  // neither viable: distinguish (d) images exist w/o usable faces vs (c) no images
  const anyImages = (ev?.with_image ?? 0) > 0 || (sn?.with_image ?? 0) > 0;
  if (anyImages) {
    return { conclusion: "d_infeasible", evidence,
      failover_b_recommendation: "Failover B INVIÁVEL neste hardware: a câmera entrega imagens mas sem rosto utilizável (score/resolução). Reavaliar estratégia (câmera diferente / ângulo / outra abordagem de re-id)." };
  }
  return { conclusion: "c_recommend_rtsp_followup", evidence,
    failover_b_recommendation: "Nenhuma imagem via evento ou snapshot.cgi. Onda follow-up: probe de RTSP frame-grab no instante da detecção (não construída aqui)." };
}
```

- [ ] **Step 4: Run, expect PASS** (6/6). **Step 5: typecheck 3/3 + commit.**

```bash
git add packages/edge/src/discovery/image-probe/decision.ts packages/edge/tests/unit/discovery/image-probe/decision.test.ts
git commit -m "feat(edge): Onda 6 — pure a/b/c/d decision module

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3.3: reid client + validation aggregator

**Files:**
- Create: `packages/edge/src/discovery/image-probe/reid-client.ts`
- Create: `packages/edge/src/discovery/image-probe/validate.ts`
- Test: `packages/edge/tests/unit/discovery/image-probe/validate.test.ts`

`reid-client.ts`: `detect(reidBaseUrl, imageBytes, contentType): Promise<DetectResult>` — POST multipart to `${reidBaseUrl}/detect`, per-call timeout, throws typed error on failure. `validate.ts`: `validateSamples({sampleDir, reidBaseUrl, thresholds})` — read all `*.json` sidecars + their images, call reid per image (count failures; tolerate reid down), aggregate `SourceMetrics[]` (with_image, usable_face by score/bbox px, medians) + `faceEvents` count.

- [ ] **Step 1: Failing test for aggregation (reid mocked)**

Create `packages/edge/tests/unit/discovery/image-probe/validate.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate } from "../../../../src/discovery/image-probe/validate.js";
import type { DetectResult, ProbeSampleMeta } from "@vipcam/shared";
import { DEFAULT_THRESHOLDS } from "../../../../src/discovery/image-probe/decision.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "val-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function meta(m: Partial<ProbeSampleMeta>): ProbeSampleMeta {
  return { source: "event", seq: 0, event_idx: null, event_code: "FaceDetection",
    event_ts: null, captured_ts: "t", delta_ms: null, content_type: "image/jpeg",
    http_status: null, byte_len: 1, file: "0.jpg", ...m };
}

describe("aggregate", () => {
  test("computes per-source rates + medians from detect results", () => {
    // 2 event samples: one usable face, one no face
    const samples = [
      { meta: meta({ seq: 0, source: "event" }), detect: { faces: [{ bbox: [0,0,120,120], det_score: 0.9 }], width: 640, height: 480, infer_ms: 50 } as DetectResult },
      { meta: meta({ seq: 1, source: "event" }), detect: { faces: [], width: 640, height: 480, infer_ms: 40 } as DetectResult },
    ];
    const { metrics } = aggregate(samples, 35, DEFAULT_THRESHOLDS);
    const e = metrics.find((m) => m.source === "event")!;
    expect(e.samples).toBe(2);
    expect(e.with_image).toBe(2);
    expect(e.usable_face).toBe(1);
    expect(e.median_infer_ms).toBe(45);
  });
});
```

(The fs-reading wrapper `validateSamples` is integration-tested operationally; `aggregate` is the pure core unit-tested here.)

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement** `reid-client.ts` (fetch multipart POST, `AbortSignal.timeout`, typed error) and `validate.ts` exporting pure `aggregate(samples, faceEvents, thresholds): {metrics: SourceMetrics[]}` + `validateSamples(...)` that reads the dir, calls `reid-client`, tolerates per-image failures (counts them, continues), then calls `aggregate`. Median = middle of sorted; `usable_face` = ≥1 face with `det_score≥min_det_score` and `min(w,h)≥min_bbox_px`. `with_image` for event = sample exists (it was an image part); for snapshot = `http_status` is 2xx and content_type image/*.

- [ ] **Step 4: Run PASS. Step 5: typecheck 3/3 + commit.**

```bash
git add packages/edge/src/discovery/image-probe/reid-client.ts packages/edge/src/discovery/image-probe/validate.ts packages/edge/tests/unit/discovery/image-probe/validate.test.ts
git commit -m "feat(edge): Onda 6 — reid client + sample validation aggregator

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3.4: Report builder + markdown decision doc

**Files:**
- Create: `packages/edge/src/discovery/image-probe/report.ts`
- Test: `packages/edge/tests/unit/discovery/image-probe/report.test.ts`

`buildImageSourceReport({runId, faceEvents, metrics, thresholds})` → `ImageSourceProbeReport` (calls `decide`). `renderDecisionMarkdown(report)` → markdown styled like `discovery/report.ts` (header, thresholds table, per-source metrics table, conclusion, evidence bullets, Failover B recommendation, mandatory sample-cleanup note).

- [ ] **Step 1: Failing test:** assert `buildImageSourceReport` sets `conclusion` from `decide` and `renderDecisionMarkdown` contains the conclusion + "Failover B" + each evidence line + the cleanup note. **Step 2:** fail. **Step 3:** implement. **Step 4:** PASS. **Step 5:** typecheck + commit.

```bash
git add packages/edge/src/discovery/image-probe/report.ts packages/edge/tests/unit/discovery/image-probe/report.test.ts
git commit -m "feat(edge): Onda 6 — image-source probe report + markdown

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3.5: API routes + server wiring

**Files:**
- Create: `packages/edge/src/api/routes/image-probe.ts`
- Modify: `packages/edge/src/api/server.ts`
- Test: `packages/edge/tests/unit/api/routes/image-probe.test.ts`

`createImageProbeRoutes(deps)` (Hono), mounted at `/api/discovery/image-probe`:
- `POST /start` body `{window_minutes?, max_samples?, thresholds?}` (Zod, clamp window ≤60) → `startImageProbe`, returns status + note "ativa no próximo ciclo de reconexão do listener (≤ alguns segundos)".
- `POST /stop` → `stopImageProbe`, returns status.
- `GET /status` → `imageProbeStatus()`.
- `POST /validate` body `{run_id?, reid_base_url?}` → `validateSamples` over the run's sample dir + `buildImageSourceReport`, writes `report.json` + decision `.md` under the sample dir, returns report.

Wire in `server.ts`: import + `app.use("/api/discovery/image-probe/*", requireKey)` is already covered by the existing `app.use("/api/discovery/*", requireKey)` (grep to confirm) — just `app.route("/api/discovery/image-probe", createImageProbeRoutes({...}))`. Provide deps: state fns + `validateSamples` + `buildImageSourceReport` + config (sample base dir = `process.env.PROBE_SAMPLES_DIR ?? "/var/lib/vipcam/probe-samples"`, reid base url = `process.env.REID_BASE_URL ?? "http://127.0.0.1:5005"`).

- [ ] **Step 1: Failing route test** (DI mocks; assert start clamps window, status shape, stop, validate calls deps). **Step 2:** fail. **Step 3:** implement route. **Step 4:** PASS. **Step 5:** wire server.ts; grep-confirm `/api/discovery/*` requireKey covers it; typecheck 3/3; full edge unit suite green. **Step 6:** commit.

```bash
git add packages/edge/src/api/routes/image-probe.ts packages/edge/src/api/server.ts packages/edge/tests/unit/api/routes/image-probe.test.ts
git commit -m "feat(edge): Onda 6 — /api/discovery/image-probe routes + wiring

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3.6: Final verification + branch finish

- [ ] **Step 1:** `bun run typecheck` → 3/3.
- [ ] **Step 2:** `bun run lint` → no NEW errors vs baseline (1 pre-existing warning in `listener-stream.test.ts`); if biome flags new Onda-6 files, `bunx biome check --write` them + re-verify + `style(...)` commit.
- [ ] **Step 3:** `cd packages/edge && bun test tests/unit` → all pass. `cd packages/reid && python -m py_compile src/main.py` → OK. (reid pytest + camera capture + InsightFace are VPS-operational, deferred.)
- [ ] **Step 4:** Use **superpowers:finishing-a-development-branch**. Summary must list: offline gates passed (typecheck 3/3, edge unit suites, pure decision/parser/tap tests, py_compile) vs operational-deferred (reid `/detect` runtime, camera capture run, the a/b/c/d report — produced by running the probe on the VPS in business hours per spec §8).

---

## Operational follow-up (NOT code — the onda's actual artifact, on VPS)

1. Provision reid: `cd /opt/vipcamv2/packages/reid && uv sync`; pre-download `buffalo_s` into `INSIGHTFACE_HOME=/var/lib/vipcam/.insightface`; install `vipcam-reid.service` (from the corrected example) + `systemctl enable --now vipcam-reid`; `curl 127.0.0.1:5005/health`.
2. Start probe in business hours: `POST /api/discovery/image-probe/start {window_minutes:60,max_samples:300}` (X-API-Key). Let it capture ≥30 face events.
3. `POST /api/discovery/image-probe/validate` → produces `report.json` + decision `.md`.
4. Read the decision doc; record a/b/c/d. Run the sample-cleanup command (operational/disk).
5. Feed the decision into the **Failover B** spec (next onda) — or strategy reassessment if `d`.
