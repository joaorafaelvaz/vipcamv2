import { describe, expect, test } from "bun:test";
import { personMergeAudit } from "../../../src/persistence/schema/person-merge-audit.js";

describe("person_merge_audit schema (Onda 7)", () => {
  test("has required columns", () => {
    type Cols = keyof typeof personMergeAudit;
    const required: Cols[] = [
      "id",
      "src_id",
      "dst_id",
      "merged_at",
      "merged_by",
      "src_snapshot",
    ] as Cols[];
    for (const col of required) expect(personMergeAudit[col]).toBeDefined();
  });
});
