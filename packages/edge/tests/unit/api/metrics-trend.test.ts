import { describe, expect, test } from "bun:test";
import { computeTrend } from "../../../src/api/metrics.trend.js";

describe("computeTrend", () => {
  test("rising series → up, positive slope", () => {
    const t = computeTrend([1, 2, 3, 4, 5]);
    expect(t.slope).toBeGreaterThan(0);
    expect(t.direction).toBe("up");
  });
  test("falling series → down", () => {
    expect(computeTrend([5, 4, 3, 2, 1]).direction).toBe("down");
  });
  test("flat series → flat, slope 0", () => {
    const t = computeTrend([3, 3, 3, 3]);
    expect(t.slope).toBe(0);
    expect(t.direction).toBe("flat");
  });
  test("near-flat within deadband → flat", () => {
    expect(computeTrend([10, 10, 10, 10, 10.1]).direction).toBe("flat");
  });
  test("empty / single point → flat slope 0 (no throw)", () => {
    expect(computeTrend([])).toEqual({ slope: 0, direction: "flat" });
    expect(computeTrend([7])).toEqual({ slope: 0, direction: "flat" });
  });
});
