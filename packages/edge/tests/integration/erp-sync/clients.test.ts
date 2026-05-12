import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { syncClients } from "../../../src/erp-sync/clients.js";
import * as queries from "../../../src/erp-sync/queries.js";
import { closeDb } from "../../../src/persistence/db.js";
import { erpRepo } from "../../../src/persistence/repositories/index.js";
import { truncateAll } from "../persistence/_helpers.js";

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
});

describe("syncClients", () => {
  test("cria erp_client para cada cliente novo + idempotência em re-run", async () => {
    mock.module("../../../src/erp-sync/queries.js", () => ({
      ...queries,
      fetchErpClients: async () => [
        { id: 100, name: "Maria Silva", phone: "11999", is_active: 1 } as never,
        { id: 200, name: "João Santos", is_active: 1 } as never,
      ],
    }));

    const first = await syncClients();
    expect(first.created).toBe(2);
    expect(first.fetched).toBe(2);

    const cli = await erpRepo.findClientByErpId("100");
    expect(cli?.name).toBe("Maria Silva");
    expect(cli?.phone).toBe("11999");

    // Re-run: idempotente
    const second = await syncClients();
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(2);
  });
});
