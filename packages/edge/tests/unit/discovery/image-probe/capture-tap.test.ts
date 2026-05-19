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
});
