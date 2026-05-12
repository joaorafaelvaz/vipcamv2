import { describe, expect, test } from "bun:test";
import { decideMatch } from "../../../src/match-temp/matcher.js";

describe("decideMatch", () => {
  test("0 candidatas → rejected", () => {
    expect(decideMatch([])).toEqual({ decision: "rejected", chosen_detection_id: null });
  });

  test("1 candidata → auto_matched", () => {
    expect(decideMatch(["det-1"])).toEqual({
      decision: "auto_matched",
      chosen_detection_id: "det-1",
    });
  });

  test(">1 candidatas → ambiguous, sem escolha", () => {
    expect(decideMatch(["det-1", "det-2", "det-3"])).toEqual({
      decision: "ambiguous",
      chosen_detection_id: null,
    });
  });
});
