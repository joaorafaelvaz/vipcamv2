import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb } from "../../../src/persistence/db.js";
import { erpRepo } from "../../../src/persistence/repositories/erp.repo.js";
import { matchAttemptsRepo } from "../../../src/persistence/repositories/match-attempts.repo.js";
import { truncateAll } from "./_helpers.js";

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
});

describe("matchAttemptsRepo", () => {
  test("findPending só retorna decision='ambiguous'", async () => {
    await erpRepo.upsertClient({ erp_id: "c1", name: "C1" });
    await erpRepo.upsertCheckin({
      erp_id: "ck-amb",
      erp_client_id: "c1",
      event_type: "appointment_confirmed",
      occurred_at: new Date(),
    });
    await erpRepo.upsertCheckin({
      erp_id: "ck-auto",
      erp_client_id: "c1",
      event_type: "appointment_confirmed",
      occurred_at: new Date(),
    });

    const ambiguous = await matchAttemptsRepo.create({
      erp_checkin_id: "ck-amb",
      decision: "ambiguous",
      confidence_score: 0.6,
    });
    await matchAttemptsRepo.create({
      erp_checkin_id: "ck-auto",
      decision: "auto_matched",
      confidence_score: 0.95,
    });

    const pending = await matchAttemptsRepo.findPending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(ambiguous.id);
    expect(pending[0]?.decision).toBe("ambiguous");
  });

  test("findByCheckin retorna histórico ordenado por decided_at desc", async () => {
    await erpRepo.upsertClient({ erp_id: "c1", name: "C1" });
    await erpRepo.upsertCheckin({
      erp_id: "ck-x",
      erp_client_id: "c1",
      event_type: "appointment_confirmed",
      occurred_at: new Date(),
    });

    const a = await matchAttemptsRepo.create({
      erp_checkin_id: "ck-x",
      decision: "ambiguous",
      confidence_score: 0.5,
    });
    await new Promise((r) => setTimeout(r, 10));
    const b = await matchAttemptsRepo.create({
      erp_checkin_id: "ck-x",
      decision: "rejected",
      confidence_score: 0.3,
    });

    const history = await matchAttemptsRepo.findByCheckin("ck-x");
    expect(history).toHaveLength(2);
    // mais recente primeiro
    expect(history[0]?.id).toBe(b.id);
    expect(history[1]?.id).toBe(a.id);
  });
});
