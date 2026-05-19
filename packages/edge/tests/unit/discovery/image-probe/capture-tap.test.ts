import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
    Buffer.from(`\r\n${B}\r\nContent-Type: image/jpeg\r\n\r\n`),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from(`\r\n${B}`),
  ]);
}

describe("capture tap", () => {
  test("persists image part as sample + sidecar when probe active", async () => {
    startImageProbe({ windowMinutes: 5, maxSamples: 10, sampleDir: dir });
    const tap = makeCaptureTap();
    tap(imgPart(), B);
    await new Promise((r) => setTimeout(r, 50));
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

  test("resets pending buffer when it exceeds the cap (no unbounded growth)", async () => {
    startImageProbe({ windowMinutes: 5, maxSamples: 10, sampleDir: dir });
    const tap = makeCaptureTap();
    // Leading boundary + opening header but NO closing boundary, > 8MB.
    const bigChunk = Buffer.concat([
      Buffer.from(`\r\n${B}\r\nContent-Type: image/jpeg\r\n\r\n`),
      Buffer.alloc(9 * 1024 * 1024, 0x41),
    ]);
    expect(() => tap(bigChunk, B)).not.toThrow();
    // Tap must have recovered (pending reset, not stuck): a subsequent
    // complete image part still produces a clean sample. Without the cap,
    // the un-closed 9MB garbage stays in `pending` and gets emitted as an
    // oversized image part once a later boundary arrives.
    tap(imgPart(), B);
    await new Promise((r) => setTimeout(r, 50));
    const files = readdirSync(dir);
    expect(files.some((f) => f.endsWith(".jpg") || f.endsWith(".bin"))).toBe(true);
    const metas = files
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { byte_len: number });
    expect(metas.length).toBeGreaterThan(0);
    // No persisted sample carries the multi-MB garbage body (proves the
    // cap fired and reset `pending` instead of accumulating it).
    expect(metas.every((m) => m.byte_len < 1024 * 1024)).toBe(true);
  });
});
