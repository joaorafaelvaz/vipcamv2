import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb } from "../../../src/persistence/db.js";
import { camerasRepo } from "../../../src/persistence/repositories/cameras.repo.js";
import { erpRepo } from "../../../src/persistence/repositories/erp.repo.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";
import { sessionsRepo } from "../../../src/persistence/repositories/sessions.repo.js";
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

  describe("findByIdWithStats", () => {
    test("agrega first_seen_at + avg_dominant_emotion + avg_visit_duration_min", async () => {
      const cam = await camerasRepo.create({ name: "c", ip_address: "10.0.0.50" });
      await erpRepo.upsertClient({ erp_id: "300", name: "Carla", phone: "11777", is_active: true });
      const person = await personsRepo.create({
        person_type: "client",
        display_name: "Carla",
        erp_client_id: "300",
      });

      // 2 sessões: uma de 10min com happy, outra de 20min com neutral
      const s1 = await sessionsRepo.create({
        camera_id: cam.id,
        person_id: person.id,
        started_at: new Date("2026-05-01T10:00:00Z"),
        last_seen_at: new Date("2026-05-01T10:10:00Z"),
        detection_count: 5,
        dominant_emotion: "happy",
      });
      await sessionsRepo.close(s1.id, new Date("2026-05-01T10:10:00Z"));
      const s2 = await sessionsRepo.create({
        camera_id: cam.id,
        person_id: person.id,
        started_at: new Date("2026-05-02T15:00:00Z"),
        last_seen_at: new Date("2026-05-02T15:20:00Z"),
        detection_count: 8,
        dominant_emotion: "neutral",
      });
      await sessionsRepo.close(s2.id, new Date("2026-05-02T15:20:00Z"));

      const stats = await personsRepo.findByIdWithStats(person.id);
      expect(stats?.id).toBe(person.id);
      expect(stats?.first_seen_at).toBeTruthy();
      expect(["happy", "neutral"]).toContain(stats?.avg_dominant_emotion ?? "");
      expect(stats?.avg_visit_duration_min ?? 0).toBeGreaterThan(9);
      expect(stats?.avg_visit_duration_min ?? 0).toBeLessThan(21);
      expect(stats?.phone).toBe("11777");
    });

    test("retorna null quando id não existe", async () => {
      const result = await personsRepo.findByIdWithStats("00000000-0000-0000-0000-000000000000");
      expect(result).toBeNull();
    });
  });
});
