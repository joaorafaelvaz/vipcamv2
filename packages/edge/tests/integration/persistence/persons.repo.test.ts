import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb } from "../../../src/persistence/db.js";
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
});
