import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb } from "../../../src/persistence/db.js";
import { erpRepo } from "../../../src/persistence/repositories/erp.repo.js";
import { truncateAll } from "./_helpers.js";

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
});

describe("erpRepo", () => {
  test("upsertClient é idempotente — rodar 2x não duplica", async () => {
    await erpRepo.upsertClient({
      erp_id: "client-1",
      name: "Maria",
      phone: "+5511999999999",
    });
    // Segunda chamada com novo nome — deve UPDATE, não INSERT
    const updated = await erpRepo.upsertClient({
      erp_id: "client-1",
      name: "Maria Atualizada",
      phone: "+5511888888888",
    });

    expect(updated.erp_id).toBe("client-1");
    expect(updated.name).toBe("Maria Atualizada");

    const found = await erpRepo.findClientByErpId("client-1");
    expect(found?.name).toBe("Maria Atualizada");
    expect(found?.phone).toBe("+5511888888888");
  });

  test("findUnprocessedCheckinsBefore filtra processados e por data", async () => {
    await erpRepo.upsertClient({ erp_id: "c1", name: "C1" });

    const t1 = new Date("2026-05-11T09:00:00Z");
    const t2 = new Date("2026-05-11T10:00:00Z");
    const t3 = new Date("2026-05-11T11:00:00Z");

    await erpRepo.upsertCheckin({
      erp_id: "ck-1",
      erp_client_id: "c1",
      event_type: "appointment_confirmed",
      occurred_at: t1,
    });
    await erpRepo.upsertCheckin({
      erp_id: "ck-2",
      erp_client_id: "c1",
      event_type: "appointment_confirmed",
      occurred_at: t2,
    });
    // ck-3 ainda no futuro — não deve aparecer
    await erpRepo.upsertCheckin({
      erp_id: "ck-3",
      erp_client_id: "c1",
      event_type: "appointment_confirmed",
      occurred_at: t3,
    });

    // Marca ck-1 como processado — não deve aparecer
    await erpRepo.markCheckinProcessed("ck-1");

    const cutoff = new Date("2026-05-11T10:30:00Z");
    const result = await erpRepo.findUnprocessedCheckinsBefore(cutoff, 10);

    expect(result).toHaveLength(1);
    expect(result[0]?.erp_id).toBe("ck-2");
  });
});
