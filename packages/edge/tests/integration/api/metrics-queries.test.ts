import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { overviewMetrics } from "../../../src/api/metrics.queries.js";
import { closeDb } from "../../../src/persistence/db.js";
import {
  camerasRepo,
  personsRepo,
  sessionsRepo,
} from "../../../src/persistence/repositories/index.js";
import { truncateAll } from "../persistence/_helpers.js";

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await closeDb();
});

async function mkSession(
  cameraId: string,
  startedAt: Date,
  opts?: { personId?: string; emotion?: string | null },
) {
  const s = await sessionsRepo.create({
    camera_id: cameraId,
    started_at: startedAt,
    last_seen_at: startedAt,
    detection_count: 1,
    dominant_emotion: opts?.emotion ?? null,
  });
  if (opts?.personId) {
    // API real confirmada: sessionsRepo.linkToPerson(sessionId, personId,
    // erpCheckinId: string|null) — sessions.repo.ts:104. Usar como está.
    await sessionsRepo.linkToPerson(s.id, opts.personId, null);
  }
  return s;
}

describe("overviewMetrics (Onda 5)", () => {
  test("período vazio → estrutura vazia tipada, sem throw", async () => {
    const o = await overviewMetrics(7);
    expect(o.days).toBe(7);
    expect(o.visits.points).toEqual([]);
    expect(o.visits.trend).toEqual({ slope: 0, direction: "flat" });
    expect(o.peak.cells).toEqual([]);
    expect(o.recurrence).toEqual({
      new_count: 0,
      returning_count: 0,
      identified_visits: 0,
      total_visits: 0,
    });
    expect(o.sentiment.buckets).toEqual([]);
  });

  test("funcionário é excluído de TODAS as métricas; anônimo entra; n/d bucket", async () => {
    const cam = await camerasRepo.create({ name: "c", ip_address: "10.0.0.1" });
    const emp = await personsRepo.create({
      display_name: "Func",
      person_type: "employee",
      erp_employee_id: "e1",
    });
    const now = new Date();
    const within = new Date(now.getTime() - 2 * 24 * 3600 * 1000);

    await mkSession(cam.id, within, { emotion: "happy" });
    await mkSession(cam.id, within, { emotion: null });
    await mkSession(cam.id, within, { personId: emp.id, emotion: "sad" });

    const o = await overviewMetrics(7);
    const totalVisits = o.visits.points.reduce((a, p) => a + p.count, 0);
    expect(totalVisits).toBe(2);
    expect(o.recurrence.total_visits).toBe(2);
    const nd = o.sentiment.buckets.find((b) => b.emotion === "n/d");
    expect(nd?.count).toBe(1);
    expect(o.sentiment.buckets.find((b) => b.emotion === "sad")).toBeUndefined();
  });

  test("recorrência: novo (1ª visita na janela) vs recorrente (visita anterior)", async () => {
    const cam = await camerasRepo.create({ name: "c2", ip_address: "10.0.0.2" });
    const now = new Date();
    const inWin = new Date(now.getTime() - 1 * 24 * 3600 * 1000);
    const beforeWin = new Date(now.getTime() - 20 * 24 * 3600 * 1000);

    const novo = await personsRepo.create({ display_name: "Novo", person_type: "client" });
    const recorrente = await personsRepo.create({ display_name: "Volta", person_type: "client" });

    await mkSession(cam.id, inWin, { personId: novo.id, emotion: "happy" });
    await mkSession(cam.id, beforeWin, { personId: recorrente.id, emotion: "happy" });
    await mkSession(cam.id, inWin, { personId: recorrente.id, emotion: "happy" });

    const o = await overviewMetrics(7);
    expect(o.recurrence.new_count).toBe(1);
    expect(o.recurrence.returning_count).toBe(1);
    expect(o.recurrence.identified_visits).toBe(2);
  });

  test("timezone: sessão perto da meia-noite UTC cai no dia LOCAL correto", async () => {
    process.env.METRICS_TZ = "America/Sao_Paulo";
    const cam = await camerasRepo.create({ name: "c3", ip_address: "10.0.0.3" });
    const now = new Date();
    const localMidnightish = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 2, 0, 0),
    );
    await mkSession(cam.id, localMidnightish, { emotion: "happy" });
    const o = await overviewMetrics(30);
    const expectedLocalDate = new Date(localMidnightish.getTime() - 3 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    expect(o.visits.points.some((p) => p.date === expectedLocalDate)).toBe(true);
  });
});
