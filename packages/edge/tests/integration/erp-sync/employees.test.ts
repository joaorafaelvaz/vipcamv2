import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { syncEmployees } from "../../../src/erp-sync/employees.js";
import * as queries from "../../../src/erp-sync/queries.js";
import { closeDb } from "../../../src/persistence/db.js";
import { erpRepo, personsRepo } from "../../../src/persistence/repositories/index.js";
import { truncateAll } from "../persistence/_helpers.js";

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
});

describe("syncEmployees", () => {
  test("cria Person + erp_employee para cada funcionário novo", async () => {
    mock.module("../../../src/erp-sync/queries.js", () => ({
      ...queries,
      fetchErpEmployees: async () => [
        { id: 1, name: "Barbeiro 1", role: "barber", is_active: 1 } as never,
        { id: 2, name: "Barbeiro 2", role: "barber", is_active: 1 } as never,
      ],
    }));
    const result = await syncEmployees();
    expect(result.created).toBe(2);
    expect(result.fetched).toBe(2);
    expect(await personsRepo.findByErpEmployeeId("1")).not.toBeNull();
    expect(await erpRepo.findEmployeeByErpId("2")).not.toBeNull();
  });

  test("idempotência: rodar duas vezes não cria duplicatas", async () => {
    mock.module("../../../src/erp-sync/queries.js", () => ({
      ...queries,
      fetchErpEmployees: async () => [{ id: 1, name: "X", is_active: 1 } as never],
    }));
    await syncEmployees();
    const result2 = await syncEmployees();
    expect(result2.created).toBe(0);
    expect(result2.skipped).toBe(1);
  });

  test("update detecta mudança de name + atualiza Person.display_name", async () => {
    mock.module("../../../src/erp-sync/queries.js", () => ({
      ...queries,
      fetchErpEmployees: async () => [{ id: 1, name: "Antigo", is_active: 1 } as never],
    }));
    await syncEmployees();

    mock.module("../../../src/erp-sync/queries.js", () => ({
      ...queries,
      fetchErpEmployees: async () => [{ id: 1, name: "Novo", is_active: 1 } as never],
    }));
    const result = await syncEmployees();
    expect(result.updated).toBe(1);
    const person = await personsRepo.findByErpEmployeeId("1");
    expect(person?.display_name).toBe("Novo");
  });
});
