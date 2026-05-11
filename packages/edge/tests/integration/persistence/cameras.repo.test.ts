import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb } from "../../../src/persistence/db.js";
import { camerasRepo } from "../../../src/persistence/repositories/cameras.repo.js";
import { truncateAll } from "./_helpers.js";

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
});

describe("camerasRepo", () => {
  test("create + getDefault retorna a primeira câmera ativa", async () => {
    const first = await camerasRepo.create({
      name: "Cam Frente",
      ip_address: "192.168.1.10",
    });
    // pequena espera pra garantir created_at ascending diferente
    await new Promise((r) => setTimeout(r, 5));
    await camerasRepo.create({
      name: "Cam Fundo",
      ip_address: "192.168.1.11",
    });

    const def = await camerasRepo.getDefault();
    expect(def?.id).toBe(first.id);
    expect(def?.name).toBe("Cam Frente");
  });

  test("getDefault ignora câmeras inativas", async () => {
    const inactive = await camerasRepo.create({
      name: "Cam Off",
      ip_address: "192.168.1.20",
      is_active: false,
    });
    await new Promise((r) => setTimeout(r, 5));
    const active = await camerasRepo.create({
      name: "Cam On",
      ip_address: "192.168.1.21",
    });

    const def = await camerasRepo.getDefault();
    expect(def?.id).toBe(active.id);
    expect(def?.id).not.toBe(inactive.id);
  });

  test("listActive retorna apenas is_active=true", async () => {
    await camerasRepo.create({ name: "A", ip_address: "1.1.1.1" });
    await camerasRepo.create({ name: "B", ip_address: "1.1.1.2", is_active: false });
    await camerasRepo.create({ name: "C", ip_address: "1.1.1.3" });

    const all = await camerasRepo.listActive();
    expect(all).toHaveLength(2);
    expect(all.every((c) => c.is_active)).toBe(true);
  });
});
