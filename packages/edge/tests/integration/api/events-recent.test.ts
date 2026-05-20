import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { recentDetections } from "../../../src/api/events.queries.js";
import { closeDb, getDb } from "../../../src/persistence/db.js";
import {
  camerasRepo,
  detectionsRepo,
  personsRepo,
  sessionsRepo,
} from "../../../src/persistence/repositories/index.js";
import { persons } from "../../../src/persistence/schema/persons.js";
import { truncateAll } from "../persistence/_helpers.js";

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await closeDb();
});

describe("recentDetections (Onda 8)", () => {
  test("empty DB → []", async () => {
    expect(await recentDetections(50)).toEqual([]);
  });

  test("returns LiveDetectionEvent envelope per row, DESC by detected_at", async () => {
    const cam = await camerasRepo.create({ name: "c", ip_address: "10.0.0.1" });
    const sess = await sessionsRepo.create({
      camera_id: cam.id,
      started_at: new Date("2026-05-20T14:00:00Z"),
      last_seen_at: new Date("2026-05-20T14:00:00Z"),
      detection_count: 1,
    });
    // Older anônima
    await detectionsRepo.create({
      camera_id: cam.id,
      session_id: sess.id,
      detected_at: new Date("2026-05-20T14:00:00Z"),
      raw_event: {},
      face_attrs: { age: 30 },
    });
    // Newer com cliente identificado
    const person = await personsRepo.create({
      display_name: "Cliente A",
      person_type: "client",
      erp_client_id: "cli-A",
    });
    const dNew = await detectionsRepo.create({
      camera_id: cam.id,
      session_id: sess.id,
      detected_at: new Date("2026-05-20T15:00:00Z"),
      raw_event: {},
      face_attrs: { age: 40 },
    });
    await detectionsRepo.linkToPerson(dNew.id, person.id);

    const out = await recentDetections(50);
    expect(out).toHaveLength(2);
    expect(out[0]!.type).toBe("detection");
    expect(out[0]!.detection).toBeDefined();
    expect(new Date(out[0]!.detection.detected_at).getTime()).toBeGreaterThan(
      new Date(out[1]!.detection.detected_at).getTime(),
    );
    expect(out[0]!.person).not.toBeNull();
    expect(out[0]!.person?.display_name).toBe("Cliente A");
    expect(out[0]!.person?.person_type).toBe("client");
    expect(out[1]!.person).toBeNull();
  });

  test("limit honored (cap responsibility lives in the route; query honors what is passed)", async () => {
    const cam = await camerasRepo.create({ name: "c2", ip_address: "10.0.0.2" });
    const sess = await sessionsRepo.create({
      camera_id: cam.id,
      started_at: new Date("2026-05-20T13:00:00Z"),
      last_seen_at: new Date("2026-05-20T13:00:00Z"),
      detection_count: 1,
    });
    for (let i = 0; i < 5; i++) {
      await detectionsRepo.create({
        camera_id: cam.id,
        session_id: sess.id,
        detected_at: new Date(`2026-05-20T13:0${i}:00Z`),
        raw_event: {},
        face_attrs: {},
      });
    }
    const out = await recentDetections(3);
    expect(out).toHaveLength(3);
  });

  test("person deleted (ON DELETE SET NULL) → person:null in response", async () => {
    const cam = await camerasRepo.create({ name: "c3", ip_address: "10.0.0.3" });
    const sess = await sessionsRepo.create({
      camera_id: cam.id,
      started_at: new Date("2026-05-20T12:00:00Z"),
      last_seen_at: new Date("2026-05-20T12:00:00Z"),
      detection_count: 1,
    });
    const person = await personsRepo.create({
      display_name: "Temp",
      person_type: "client",
      erp_client_id: "cli-T",
    });
    const det = await detectionsRepo.create({
      camera_id: cam.id,
      session_id: sess.id,
      detected_at: new Date("2026-05-20T12:00:00Z"),
      raw_event: {},
      face_attrs: {},
    });
    await detectionsRepo.linkToPerson(det.id, person.id);
    // personsRepo.delete não existe — Drizzle direto. ON DELETE SET NULL no schema.
    await getDb().delete(persons).where(eq(persons.id, person.id));
    const out = await recentDetections(10);
    expect(out).toHaveLength(1);
    expect(out[0]!.person).toBeNull();
  });
});
