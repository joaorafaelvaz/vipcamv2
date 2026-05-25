import { describe, expect, test } from "bun:test";
import {
  classifyDistance,
  type MatchDecision,
} from "../../../../src/api/reid/match-policy.js";

describe("classifyDistance — pure decision tree", () => {
  const strict = 0.35;
  const loose = 0.55;

  test("dist=0 → strict", () => {
    expect(classifyDistance(0, strict, loose)).toBe("strict");
  });
  test("dist=0.35 → strict (boundary inclusive)", () => {
    expect(classifyDistance(0.35, strict, loose)).toBe("strict");
  });
  test("dist=0.36 → borderline", () => {
    expect(classifyDistance(0.36, strict, loose)).toBe("borderline");
  });
  test("dist=0.55 → borderline (boundary inclusive)", () => {
    expect(classifyDistance(0.55, strict, loose)).toBe("borderline");
  });
  test("dist=0.56 → new_person", () => {
    expect(classifyDistance(0.56, strict, loose)).toBe("new_person");
  });
  test("dist=2.0 (max cosine) → new_person", () => {
    expect(classifyDistance(2.0, strict, loose)).toBe("new_person");
  });

  test("returns MatchDecision union", () => {
    const _: MatchDecision = classifyDistance(0.5, strict, loose);
    void _;
  });
});
