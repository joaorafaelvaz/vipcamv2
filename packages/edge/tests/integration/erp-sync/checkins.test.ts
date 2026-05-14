import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { _resetCursor, pollCheckins } from "../../../src/erp-sync/checkins.js";
import * as queries from "../../../src/erp-sync/queries.js";
import { closeDb } from "../../../src/persistence/db.js";
import { erpRepo } from "../../../src/persistence/repositories/index.js";
import { truncateAll } from "../persistence/_helpers.js";

beforeEach(async () => {
  await truncateAll();
  _resetCursor();
});

afterAll(async () => {
  await closeDb();
});

describe("pollCheckins", () => {
  test("primeiro poll insere todos os rows novos", async () => {
    const t = new Date("2026-05-12T15:00:00Z");
    mock.module("../../../src/erp-sync/queries.js", () => ({
      ...queries,
      fetchErpCheckinsSince: async () => [
        {
          id: 10,
          client_id: 100,
          event_type: "appointment_confirmed",
          occurred_at: new Date(t.getTime() + 1000),
          metadata: '{"service":"cut"}',
        } as never,
        {
          id: 11,
          client_id: 100,
          event_type: "service_started",
          occurred_at: new Date(t.getTime() + 60_000),
          metadata: null,
        } as never,
      ],
    }));

    const result = await pollCheckins();
    expect(result.fetched).toBe(2);
    expect(result.new_).toBe(2);

    const c = await erpRepo.findCheckinByErpId("10");
    expect(c?.event_type).toBe("appointment_confirmed");
    expect(c?.metadata).toEqual({ service: "cut" });
  });

  test("segundo poll com mesmos rows: cursor avança, nada inserido (idempotência)", async () => {
    mock.module("../../../src/erp-sync/queries.js", () => ({
      ...queries,
      fetchErpCheckinsSince: async () => [
        {
          id: 10,
          client_id: 100,
          event_type: "x",
          occurred_at: new Date("2026-05-12T15:00:00Z"),
          metadata: null,
        } as never,
      ],
    }));
    await pollCheckins();
    const result = await pollCheckins();
    // Re-poll devolve mesmo row (since cursor inclusivo do nosso lado),
    // mas erp_id duplicado é skipado.
    expect(result.new_).toBe(0);
  });

  test("metadata malformado vira {} sem crashar", async () => {
    mock.module("../../../src/erp-sync/queries.js", () => ({
      ...queries,
      fetchErpCheckinsSince: async () => [
        {
          id: 50,
          client_id: 1,
          event_type: "x",
          occurred_at: new Date(),
          metadata: "not-json{",
        } as never,
      ],
    }));
    const r = await pollCheckins();
    expect(r.new_).toBe(1);
    const c = await erpRepo.findCheckinByErpId("50");
    expect(c?.metadata).toEqual({});
  });

  // M5 (review 2026-05-13): assert explícito sobre metadata=null → {}
  test("metadata null vira {} no DB", async () => {
    mock.module("../../../src/erp-sync/queries.js", () => ({
      ...queries,
      fetchErpCheckinsSince: async () => [
        {
          id: 51,
          client_id: 1,
          event_type: "x",
          occurred_at: new Date(),
          metadata: null,
        } as never,
      ],
    }));
    await pollCheckins();
    const c = await erpRepo.findCheckinByErpId("51");
    expect(c?.metadata).toEqual({});
  });

  // I5 (review 2026-05-13): se upsertCheckin falhar, cursor NÃO avança e
  // próxima rodada re-tenta. Sem esse fix, cursor ultrapassava o row falho
  // e ele ficava perdido permanentemente.
  test("upsert falhando: cursor não avança, próxima rodada re-tenta", async () => {
    const t = new Date("2026-05-12T16:00:00Z");

    // 1ª tentativa: query devolve 1 row, upsertCheckin throws
    mock.module("../../../src/erp-sync/queries.js", () => ({
      ...queries,
      fetchErpCheckinsSince: async () => [
        {
          id: 99,
          client_id: 1,
          event_type: "x",
          occurred_at: t,
          metadata: null,
        } as never,
      ],
    }));
    const realUpsert = erpRepo.upsertCheckin.bind(erpRepo);
    let upsertCalls = 0;
    erpRepo.upsertCheckin = async (data) => {
      upsertCalls += 1;
      if (upsertCalls === 1) throw new Error("simulated transient DB failure");
      return realUpsert(data);
    };

    try {
      const r1 = await pollCheckins();
      expect(r1.new_).toBe(0); // upsert falhou, nada novo

      // 2ª rodada: queries.fetchErpCheckinsSince é chamado com o MESMO cursor
      // (não avançou) → devolve o mesmo row → upsert tenta de novo (sucesso)
      const r2 = await pollCheckins();
      expect(r2.new_).toBe(1); // upsert agora funciona

      const c = await erpRepo.findCheckinByErpId("99");
      expect(c).not.toBeNull();
    } finally {
      erpRepo.upsertCheckin = realUpsert;
    }
  });
});
