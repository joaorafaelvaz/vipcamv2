import { beforeEach, describe, expect, mock, test } from "bun:test";

// NOTA bun:test mock.module process-wide leakage — installMocks re-registra
// em beforeEach pra defender contra ordem de execução do suite.
let attemptReturn: Record<string, unknown> | null = null;
let prevPersonReturn: Record<string, unknown> | null = null;
let mergeIntoCalls: Array<[string, string, string]> = [];
let mergeIntoThrow: Error | null = null;
let resolveAmbigCalls: Array<[string, string, string | undefined]> = [];

const installMocks = () => {
  mock.module("../../../src/persistence/repositories/match-attempts.repo.js", () => ({
    matchAttemptsRepo: {
      resolveAmbiguous: async (id: string, detId: string, notes?: string) => {
        resolveAmbigCalls.push([id, detId, notes]);
      },
      rejectAmbiguous: async () => undefined,
    },
  }));
  mock.module("../../../src/persistence/repositories/persons.repo.js", () => ({
    personsRepo: {
      findById: async () => prevPersonReturn,
      mergeInto: async (src: string, dst: string, user: string) => {
        mergeIntoCalls.push([src, dst, user]);
        if (mergeIntoThrow) throw mergeIntoThrow;
      },
    },
  }));
  mock.module("../../../src/persistence/db.js", () => ({
    getDb: () => ({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (attemptReturn ? [attemptReturn] : []),
          }),
        }),
      }),
    }),
  }));
};
installMocks();

import { ResolveError, resolveAmbiguous } from "../../../src/match-temp/review.js";

beforeEach(() => {
  attemptReturn = null;
  prevPersonReturn = null;
  mergeIntoCalls = [];
  mergeIntoThrow = null;
  resolveAmbigCalls = [];
  installMocks();
});

describe("resolveAmbiguous divergent bifurcation (Onda 9-A)", () => {
  test("previous_person_id != null + W ≠ Y → calls mergeInto + resolveAmbiguous", async () => {
    attemptReturn = {
      id: "att-1",
      decision: "ambiguous",
      detection_id: "det-1",
      erp_checkin_id: "chk-1",
      previous_person_id: "p-W",
    };
    prevPersonReturn = { id: "p-W", display_name: "W" };
    await resolveAmbiguous("att-1", "det-1", "p-Y");
    expect(mergeIntoCalls).toEqual([["p-W", "p-Y", "system"]]);
    expect(resolveAmbigCalls.length).toBe(1);
    expect(resolveAmbigCalls[0]?.[0]).toBe("att-1");
  });

  test("previous_person_id == chosenPersonId (stale W==Y) → no mergeInto, marks resolved", async () => {
    attemptReturn = {
      id: "att-2",
      decision: "ambiguous",
      detection_id: "det-2",
      previous_person_id: "p-Y",  // ← já é Y
    };
    await resolveAmbiguous("att-2", "det-2", "p-Y");
    expect(mergeIntoCalls.length).toBe(0);
    expect(resolveAmbigCalls.length).toBe(1);
  });

  test("previous_person_id != null + W not found → ResolveError 'previous_person_gone'", async () => {
    attemptReturn = {
      id: "att-3",
      decision: "ambiguous",
      previous_person_id: "p-W-deleted",
    };
    prevPersonReturn = null;  // W foi deletada
    await expect(resolveAmbiguous("att-3", "det-3", "p-Y")).rejects.toThrow(ResolveError);
    expect(mergeIntoCalls.length).toBe(0);
  });

  test("mergeInto throws 'not found' → ResolveError 'concurrent_merge'", async () => {
    attemptReturn = {
      id: "att-4",
      decision: "ambiguous",
      previous_person_id: "p-W",
    };
    prevPersonReturn = { id: "p-W" };
    mergeIntoThrow = new Error("mergeInto: person not found (p-W or p-Y)");
    await expect(resolveAmbiguous("att-4", "det-4", "p-Y")).rejects.toMatchObject({
      code: "concurrent_merge",
    });
  });

  test("decision != ambiguous → already_resolved", async () => {
    attemptReturn = { id: "att-5", decision: "auto_matched" };
    await expect(resolveAmbiguous("att-5", "det-5", "p-Y")).rejects.toMatchObject({
      code: "already_resolved",
    });
  });
});
