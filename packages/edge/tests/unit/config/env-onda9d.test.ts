import { describe, expect, test } from "bun:test";
import { parseEnv } from "../../../src/config/env.js";

const BASE = { API_KEY: "test-key" };

describe("Onda 9-D env defaults (staff-like heuristic)", () => {
  test("STAFF_LOOKBACK_DAYS default 7", () => {
    expect(parseEnv(BASE).STAFF_LOOKBACK_DAYS).toBe(7);
  });

  test("STAFF_MIN_ACTIVE_HOURS default 20", () => {
    expect(parseEnv(BASE).STAFF_MIN_ACTIVE_HOURS).toBe(20);
  });

  test("aceita override por env", () => {
    const e = parseEnv({ ...BASE, STAFF_LOOKBACK_DAYS: "14", STAFF_MIN_ACTIVE_HOURS: "30" });
    expect(e.STAFF_LOOKBACK_DAYS).toBe(14);
    expect(e.STAFF_MIN_ACTIVE_HOURS).toBe(30);
  });

  test("REID_DIST_STRICT(0.40) < REID_DIST_LOOSE(0.55) — refine continua válido", () => {
    const e = parseEnv(BASE);
    expect(e.REID_DIST_STRICT).toBeLessThan(e.REID_DIST_LOOSE);
  });

  test("VISIT_GAP_HOURS default 12 + override (Onda 11)", () => {
    expect(parseEnv(BASE).VISIT_GAP_HOURS).toBe(12);
    expect(parseEnv({ ...BASE, VISIT_GAP_HOURS: "14" }).VISIT_GAP_HOURS).toBe(14);
  });
});
