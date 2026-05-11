import { describe, expect, test } from "bun:test";
import { shouldStartNewSession } from "../../../src/ingest/session-tracker.js";

const T0 = new Date("2026-05-01T12:00:00Z");
const after = (ms: number) => new Date(T0.getTime() + ms);

describe("shouldStartNewSession", () => {
  test("retorna true se não há sessão aberta", () => {
    expect(shouldStartNewSession(null, T0, 30_000)).toBe(true);
  });

  test("retorna false se gap < gapSeconds", () => {
    const lastSeen = after(0);
    expect(shouldStartNewSession(lastSeen, after(20_000), 30_000)).toBe(false);
  });

  test("retorna true se gap >= gapSeconds", () => {
    const lastSeen = after(0);
    expect(shouldStartNewSession(lastSeen, after(31_000), 30_000)).toBe(true);
  });

  test("retorna true se sessão fechou no passado (lastSeen > now é impossível)", () => {
    expect(shouldStartNewSession(after(60_000), T0, 30_000)).toBe(true);
  });
});
