import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb } from "../../../src/persistence/db.js";
import { erpRepo } from "../../../src/persistence/repositories/index.js";
import { truncateAll } from "./_helpers.js";

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await closeDb();
});

function row(erpId: string) {
  return {
    erp_id: erpId,
    erp_client_id: "100",
    event_type: "appointment_confirmed",
    occurred_at: new Date("2026-05-30T23:30:00Z"),
    metadata: {},
  };
}

describe("erpRepo.insertCheckinsIgnore", () => {
  test("insere todos quando nenhum existe; retorna count", async () => {
    const n = await erpRepo.insertCheckinsIgnore([row("10"), row("11")]);
    expect(n).toBe(2);
    expect(await erpRepo.findCheckinByErpId("10")).not.toBeNull();
    expect(await erpRepo.findCheckinByErpId("11")).not.toBeNull();
  });

  test("pula erp_id já existente (ON CONFLICT DO NOTHING) e NÃO reseta processed_at", async () => {
    await erpRepo.insertCheckinsIgnore([row("10")]);
    await erpRepo.markCheckinProcessed("10");

    // segunda leva: '10' repetido + '12' novo
    const n = await erpRepo.insertCheckinsIgnore([row("10"), row("12")]);
    expect(n).toBe(1); // só o 12 é novo

    const c10 = await erpRepo.findCheckinByErpId("10");
    expect(c10?.processed_at).not.toBeNull(); // preservado, não clobrado
    expect(await erpRepo.findCheckinByErpId("12")).not.toBeNull();
  });

  test("lista vazia → 0, sem query", async () => {
    expect(await erpRepo.insertCheckinsIgnore([])).toBe(0);
  });
});
