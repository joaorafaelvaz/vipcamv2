import { describe, expect, test } from "bun:test";
import { computeSince } from "../../../src/erp-sync/checkins.js";

describe("computeSince", () => {
  test("subtrai lookbackHours do now", () => {
    const now = new Date("2026-05-31T14:00:00Z");
    const since = computeSince(now, 24);
    expect(since.toISOString()).toBe("2026-05-30T14:00:00.000Z");
  });

  test("lookback diferente (12h)", () => {
    const now = new Date("2026-05-31T14:00:00Z");
    expect(computeSince(now, 12).toISOString()).toBe("2026-05-31T02:00:00.000Z");
  });

  test("não muta o now recebido", () => {
    const now = new Date("2026-05-31T14:00:00Z");
    computeSince(now, 24);
    expect(now.toISOString()).toBe("2026-05-31T14:00:00.000Z");
  });
});
