import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb } from "../../../src/persistence/db.js";
import { erpRepo } from "../../../src/persistence/repositories/erp.repo.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";
import { truncateAll } from "./_helpers.js";

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
});

describe("personsRepo", () => {
  test("create + findById round-trip", async () => {
    const created = await personsRepo.create({ display_name: "Test" });
    expect(created.id).toBeDefined();
    expect(created.person_type).toBe("anonymous");

    const found = await personsRepo.findById(created.id);
    expect(found?.display_name).toBe("Test");
  });

  test("findByErpEmployeeId retorna funcionário cadastrado", async () => {
    await personsRepo.create({
      display_name: "Funcionário X",
      person_type: "employee",
      erp_employee_id: "emp-123",
    });
    const found = await personsRepo.findByErpEmployeeId("emp-123");
    expect(found?.display_name).toBe("Funcionário X");
  });

  test("update incrementa updated_at e total_visits", async () => {
    const p = await personsRepo.create({ display_name: "Cliente" });
    await new Promise((r) => setTimeout(r, 10));
    const updated = await personsRepo.update(p.id, {
      total_visits: 5,
      last_seen_at: new Date(),
    });
    expect(updated?.total_visits).toBe(5);
    expect(updated?.updated_at.getTime()).toBeGreaterThan(p.updated_at.getTime());
  });

  describe("listWithFilters", () => {
    test("retorna paginação por type=client com phone vindo do erp_clients JOIN", async () => {
      await erpRepo.upsertClient({ erp_id: "100", name: "Ana", phone: "11999", is_active: true });
      await personsRepo.create({
        person_type: "client",
        display_name: "Ana",
        erp_client_id: "100",
      });
      await personsRepo.create({ person_type: "employee", display_name: "Funcionário X" });

      const result = await personsRepo.listWithFilters({ type: "client", limit: 10, offset: 0 });

      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.display_name).toBe("Ana");
      expect(result.items[0]?.phone).toBe("11999");
      expect(result.items[0]?.person_type).toBe("client");
    });

    test("search filtra por display_name (case-insensitive) ou phone", async () => {
      await erpRepo.upsertClient({ erp_id: "200", name: "Maria", phone: "11888", is_active: true });
      await personsRepo.create({
        person_type: "client",
        display_name: "Maria",
        erp_client_id: "200",
      });
      await personsRepo.create({ person_type: "client", display_name: "Bruno" });

      const byName = await personsRepo.listWithFilters({ search: "mar", limit: 10, offset: 0 });
      expect(byName.total).toBe(1);
      expect(byName.items[0]?.display_name).toBe("Maria");

      const byPhone = await personsRepo.listWithFilters({ search: "11888", limit: 10, offset: 0 });
      expect(byPhone.total).toBe(1);
      expect(byPhone.items[0]?.display_name).toBe("Maria");
    });

    test("ordena por last_seen_at desc (NULLs por último)", async () => {
      await personsRepo.create({ person_type: "client", display_name: "Antiga" });
      const recent = await personsRepo.create({
        person_type: "client",
        display_name: "Recente",
      });
      await personsRepo.incrementVisitCount(recent.id, new Date());

      const result = await personsRepo.listWithFilters({ limit: 10, offset: 0 });
      expect(result.items[0]?.display_name).toBe("Recente");
    });
  });
});
