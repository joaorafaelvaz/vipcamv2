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
    expect(s.window_minutes).toBe(60);
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
    startImageProbe({ windowMinutes: 0.001, maxSamples: 10, sampleDir: "/tmp/x" });
    await new Promise((r) => setTimeout(r, 120));
    expect(isProbeActive()).toBe(false);
  });

  test("reaching maxSamples flips inactive via noteSample", () => {
    const { noteSample } = require("../../../../src/discovery/image-probe/state.js");
    startImageProbe({ windowMinutes: 5, maxSamples: 2, sampleDir: "/tmp/x" });
    noteSample();
    expect(isProbeActive()).toBe(true);
    noteSample();
    expect(isProbeActive()).toBe(false);
  });
});
