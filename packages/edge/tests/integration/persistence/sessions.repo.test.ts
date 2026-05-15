import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb } from "../../../src/persistence/db.js";
import { camerasRepo } from "../../../src/persistence/repositories/cameras.repo.js";
import { detectionsRepo } from "../../../src/persistence/repositories/detections.repo.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";
import { sessionsRepo } from "../../../src/persistence/repositories/sessions.repo.js";
import { truncateAll } from "./_helpers.js";

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
});

describe("sessionsRepo", () => {
  test("findOpenForTrack reusa sessão dentro do gap, ignora fora do gap", async () => {
    const cam = await camerasRepo.create({ name: "S", ip_address: "1.1.1.1" });

    const now = new Date();
    const fiveSecondsAgo = new Date(now.getTime() - 5_000);

    const recent = await sessionsRepo.create({
      camera_id: cam.id,
      current_track_id: "track-A",
      started_at: fiveSecondsAgo,
      last_seen_at: fiveSecondsAgo,
    });

    // Gap 30s a partir de now: sessão de 5s atrás está dentro -> reusa
    const inside = await sessionsRepo.findOpenForTrack(cam.id, "track-A", now, 30_000);
    expect(inside?.id).toBe(recent.id);

    // Gap 1s a partir de now: sessão de 5s atrás está fora -> null
    const outside = await sessionsRepo.findOpenForTrack(cam.id, "track-A", now, 1_000);
    expect(outside).toBeNull();
  });

  test("findOpenForTrack ignora sessões fechadas (ended_at NOT NULL)", async () => {
    const cam = await camerasRepo.create({ name: "S2", ip_address: "1.1.1.2" });
    const now = new Date();
    const s = await sessionsRepo.create({
      camera_id: cam.id,
      current_track_id: "track-B",
      started_at: now,
      last_seen_at: now,
    });
    await sessionsRepo.close(s.id, new Date());

    const found = await sessionsRepo.findOpenForTrack(cam.id, "track-B", now, 60_000);
    expect(found).toBeNull();
  });

  test("appendDetection incrementa contador e atualiza last_seen_at", async () => {
    const cam = await camerasRepo.create({ name: "S3", ip_address: "1.1.1.3" });
    const now = new Date();
    const s = await sessionsRepo.create({
      camera_id: cam.id,
      current_track_id: "t",
      started_at: now,
      last_seen_at: now,
    });

    const later = new Date(now.getTime() + 5_000);
    await sessionsRepo.appendDetection(s.id, later);
    await sessionsRepo.appendDetection(s.id, later);

    const refetched = await sessionsRepo.findOpenForTrack(cam.id, "t", later, 60_000);
    expect(refetched?.detection_count).toBe(2);
    expect(refetched?.last_seen_at.getTime()).toBe(later.getTime());
  });

  describe("listByPerson", () => {
    test("retorna sessions ordenadas desc + detections embedded (limit 20 por session)", async () => {
      const cam = await camerasRepo.create({ name: "c", ip_address: "10.0.0.60" });
      const person = await personsRepo.create({ person_type: "client", display_name: "Test" });

      // 2 sessões da mesma pessoa
      const s1 = await sessionsRepo.create({
        camera_id: cam.id,
        person_id: person.id,
        started_at: new Date("2026-05-01T10:00:00Z"),
        last_seen_at: new Date("2026-05-01T10:10:00Z"),
        detection_count: 1,
      });
      await detectionsRepo.create({
        camera_id: cam.id,
        session_id: s1.id,
        person_id: person.id,
        detected_at: new Date("2026-05-01T10:01:00Z"),
        raw_event: {},
        face_attrs: { age: 30 },
        dominant_emotion: "happy",
        snapshot_path: "/var/lib/vipcam/snapshots/abc.jpg",
      });

      const s2 = await sessionsRepo.create({
        camera_id: cam.id,
        person_id: person.id,
        started_at: new Date("2026-05-02T11:00:00Z"),
        last_seen_at: new Date("2026-05-02T11:05:00Z"),
        detection_count: 1,
      });

      const result = await sessionsRepo.listByPerson(person.id, 10);
      expect(result).toHaveLength(2);
      // Mais recente primeiro
      expect(result[0]?.id).toBe(s2.id);
      expect(result[1]?.id).toBe(s1.id);
      // Detections embedded
      expect(result[1]?.detections).toHaveLength(1);
      expect(result[1]?.detections[0]?.dominant_emotion).toBe("happy");
      expect(result[1]?.detections[0]?.face_attrs).toEqual({ age: 30 });
    });

    test("retorna [] quando pessoa não tem sessions", async () => {
      const lonely = await personsRepo.create({ person_type: "client", display_name: "Sozinho" });
      const result = await sessionsRepo.listByPerson(lonely.id, 10);
      expect(result).toEqual([]);
    });

    test("cap 20 detections por session no payload (mas detection_count preservado)", async () => {
      const cam = await camerasRepo.create({ name: "c", ip_address: "10.0.0.61" });
      const person = await personsRepo.create({ person_type: "client", display_name: "Many" });
      const sess = await sessionsRepo.create({
        camera_id: cam.id,
        person_id: person.id,
        started_at: new Date("2026-05-01T10:00:00Z"),
        last_seen_at: new Date("2026-05-01T11:00:00Z"),
        detection_count: 25,
      });
      for (let i = 0; i < 25; i++) {
        await detectionsRepo.create({
          camera_id: cam.id,
          session_id: sess.id,
          person_id: person.id,
          detected_at: new Date(Date.parse("2026-05-01T10:00:00Z") + i * 60_000),
          raw_event: {},
          face_attrs: {},
        });
      }

      const result = await sessionsRepo.listByPerson(person.id, 10);
      expect(result).toHaveLength(1);
      expect(result[0]?.detections).toHaveLength(20); // cap 20
      expect(result[0]?.detection_count).toBe(25); // counter preservado
    });
  });
});
