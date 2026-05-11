import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb } from "../../../src/persistence/db.js";
import { camerasRepo } from "../../../src/persistence/repositories/cameras.repo.js";
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
});
