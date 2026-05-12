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
});
