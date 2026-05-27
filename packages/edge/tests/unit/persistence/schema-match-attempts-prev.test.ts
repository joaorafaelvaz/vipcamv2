import { describe, expect, test } from "bun:test";
import { matchAttempts } from "../../../src/persistence/schema/match-attempts.js";

describe("match_attempts schema Onda 9-A", () => {
  test("has previous_person_id (nullable FK)", () => {
    expect((matchAttempts as unknown as Record<string, unknown>).previous_person_id).toBeDefined();
  });

  test("has previous_person_snapshot (jsonb nullable)", () => {
    expect((matchAttempts as unknown as Record<string, unknown>).previous_person_snapshot).toBeDefined();
  });

  test("previous_person_id is NOT notNull (must be nullable)", () => {
    const col = (matchAttempts as unknown as { previous_person_id: { notNull?: boolean } }).previous_person_id;
    expect(col.notNull).not.toBe(true);
  });
});
