import { describe, expect, test } from "bun:test";
import { computeWindow } from "../../../src/match-temp/window.js";

describe("computeWindow", () => {
  test("retorna [T-N, T+N] em segundos", () => {
    const t = new Date("2026-05-01T14:00:00Z");
    const w = computeWindow(t, 300);
    expect(w.start.toISOString()).toBe("2026-05-01T13:55:00.000Z");
    expect(w.end.toISOString()).toBe("2026-05-01T14:05:00.000Z");
  });

  test("janela 0 = ponto único (start == end == center)", () => {
    const t = new Date("2026-01-01T00:00:00Z");
    const w = computeWindow(t, 0);
    expect(w.start.getTime()).toBe(t.getTime());
    expect(w.end.getTime()).toBe(t.getTime());
  });
});
