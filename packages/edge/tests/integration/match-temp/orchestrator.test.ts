import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { processCheckin } from "../../../src/match-temp/orchestrator.js";
import { closeDb } from "../../../src/persistence/db.js";
import {
  camerasRepo,
  detectionsRepo,
  erpRepo,
  matchAttemptsRepo,
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

describe("processCheckin (match temporal — Onda 9-D)", () => {
  test("auto-match: 1 detection NULL na janela → vincula à Person/erp_client", async () => {
    const cam = await camerasRepo.create({ name: "c", ip_address: "10.0.0.1" });
    await erpRepo.upsertClient({ erp_id: "cli-1", name: "Cliente Teste", is_active: true });

    const session = await sessionsRepo.create({
      camera_id: cam.id,
      started_at: new Date("2026-05-01T14:00:00Z"),
      last_seen_at: new Date("2026-05-01T14:00:00Z"),
      detection_count: 1,
    });
    const det = await detectionsRepo.create({
      camera_id: cam.id,
      session_id: session.id,
      detected_at: new Date("2026-05-01T14:01:00Z"),
      raw_event: {},
      face_attrs: {},
    });

    const checkin = await erpRepo.upsertCheckin({
      erp_id: "chk-1",
      erp_client_id: "cli-1",
      event_type: "appointment_confirmed",
      occurred_at: new Date("2026-05-01T14:00:30Z"),
    });

    await processCheckin(checkin);

    const updatedDet = await detectionsRepo.findById(det.id);
    expect(updatedDet?.person_id).not.toBeNull();

    const person = await personsRepo.findByErpClientId("cli-1");
    expect(person?.display_name).toBe("Cliente Teste");
    expect(person?.id).toBe(updatedDet?.person_id ?? "");

    const attempts = await matchAttemptsRepo.findByCheckin("chk-1");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.decision).toBe("auto_matched");
    expect(attempts[0]?.detection_id).toBe(det.id);
  });

  test("ambiguous: 2 detections NULL na janela → 1 attempt agregado, sem vincular", async () => {
    const cam = await camerasRepo.create({ name: "c2", ip_address: "10.0.0.2" });
    await erpRepo.upsertClient({ erp_id: "cli-2", name: "Cliente B", is_active: true });

    const baseTime = new Date("2026-05-01T15:00:00Z");
    for (const trackId of ["t-A", "t-B"]) {
      const sess = await sessionsRepo.create({
        camera_id: cam.id,
        current_track_id: trackId,
        started_at: baseTime,
        last_seen_at: baseTime,
        detection_count: 1,
      });
      await detectionsRepo.create({
        camera_id: cam.id,
        session_id: sess.id,
        detected_at: baseTime,
        raw_event: {},
        face_attrs: {},
      });
    }

    const checkin = await erpRepo.upsertCheckin({
      erp_id: "chk-2",
      erp_client_id: "cli-2",
      event_type: "appointment_confirmed",
      occurred_at: new Date(baseTime.getTime() + 30_000),
    });

    await processCheckin(checkin);

    const attempts = await matchAttemptsRepo.findByCheckin("chk-2");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.decision).toBe("ambiguous");
    expect(attempts[0]?.detection_id).toBeNull();
    expect(attempts[0]?.notes).toContain("null candidates");
  });

  test("rejected: 0 detections na janela → nenhum match_attempt criado", async () => {
    await erpRepo.upsertClient({ erp_id: "cli-3", name: "Cliente C", is_active: true });
    const checkin = await erpRepo.upsertCheckin({
      erp_id: "chk-3",
      erp_client_id: "cli-3",
      event_type: "appointment_confirmed",
      occurred_at: new Date("2026-05-01T20:00:00Z"),
    });

    await processCheckin(checkin);

    const attempts = await matchAttemptsRepo.findByCheckin("chk-3");
    expect(attempts).toHaveLength(0);
  });

  test("idempotência: re-process não cria match_attempt duplicado", async () => {
    const cam = await camerasRepo.create({ name: "c4", ip_address: "10.0.0.4" });
    await erpRepo.upsertClient({ erp_id: "cli-4", name: "C", is_active: true });
    await detectionsRepo.create({
      camera_id: cam.id,
      session_id: null,
      detected_at: new Date("2026-05-01T16:00:30Z"),
      raw_event: {},
      face_attrs: {},
    });
    const checkin = await erpRepo.upsertCheckin({
      erp_id: "chk-4",
      erp_client_id: "cli-4",
      event_type: "x",
      occurred_at: new Date("2026-05-01T16:00:00Z"),
    });
    await processCheckin(checkin); // 1 NULL → auto_matched (1 attempt)

    const updated = await erpRepo.findCheckinByErpId("chk-4");
    if (updated) await processCheckin(updated); // processed_at setado → no-op

    const attempts = await matchAttemptsRepo.findByCheckin("chk-4");
    expect(attempts).toHaveLength(1);
  });
});
