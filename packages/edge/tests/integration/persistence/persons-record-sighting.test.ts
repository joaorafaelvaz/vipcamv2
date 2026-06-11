import { afterEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getDb } from "../../../src/persistence/db.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";

const created: string[] = [];
afterEach(async () => {
  for (const id of created) {
    await getDb().execute(sql`DELETE FROM persons WHERE id = ${id}`);
  }
  created.length = 0;
});

async function person(lastSeen: Date) {
  const p = await personsRepo.create({ person_type: "anonymous", last_seen_at: lastSeen });
  created.push(p.id);
  return p;
}

const H = 3_600_000;
const T0 = new Date("2026-06-10T12:00:00Z");

describe("personsRepo.recordSighting (Onda 11 — dedup por gap)", () => {
  test("gap > gapHours → +1 visita e last_seen atualizado", async () => {
    const p = await person(T0);
    await personsRepo.recordSighting(p.id, new Date(T0.getTime() + 13 * H), 12);
    const r = await personsRepo.findById(p.id);
    expect(r?.total_visits).toBe(2); // default 1 + 1
    expect(r?.last_seen_at?.toISOString()).toBe(new Date(T0.getTime() + 13 * H).toISOString());
  });

  test("gap < gapHours → contador inalterado, last_seen atualizado (mesma visita)", async () => {
    const p = await person(T0);
    await personsRepo.recordSighting(p.id, new Date(T0.getTime() + 2 * H), 12);
    const r = await personsRepo.findById(p.id);
    expect(r?.total_visits).toBe(1);
    expect(r?.last_seen_at?.toISOString()).toBe(new Date(T0.getTime() + 2 * H).toISOString());
  });

  test("out-of-order (detectedAt < last_seen) → contador inalterado, last_seen preservado", async () => {
    const p = await person(T0);
    await personsRepo.recordSighting(p.id, new Date(T0.getTime() - 5 * H), 12);
    const r = await personsRepo.findById(p.id);
    expect(r?.total_visits).toBe(1);
    expect(r?.last_seen_at?.toISOString()).toBe(T0.toISOString()); // GREATEST preserva
  });

  test("gapHours custom (1h) respeitado", async () => {
    const p = await person(T0);
    await personsRepo.recordSighting(p.id, new Date(T0.getTime() + 2 * H), 1);
    const r = await personsRepo.findById(p.id);
    expect(r?.total_visits).toBe(2); // 2h > 1h
  });
});
