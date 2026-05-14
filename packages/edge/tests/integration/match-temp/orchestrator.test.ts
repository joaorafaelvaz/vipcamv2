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

describe("processCheckin (match temporal)", () => {
  test("auto_match: 1 detection anônima na janela → vinculação a Person/erp_client", async () => {
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

    // Checkin 30s depois da detection — dentro da janela ±5min default
    const checkin = await erpRepo.upsertCheckin({
      erp_id: "chk-1",
      erp_client_id: "cli-1",
      event_type: "appointment_confirmed",
      occurred_at: new Date("2026-05-01T14:00:30Z"),
    });

    await processCheckin(checkin);

    // Detection foi vinculada à Person criada pra cli-1
    const updatedDet = await detectionsRepo.findById(det.id);
    expect(updatedDet?.person_id).toBeDefined();
    expect(updatedDet?.person_id).not.toBeNull();

    const person = await personsRepo.findByErpClientId("cli-1");
    expect(person?.display_name).toBe("Cliente Teste");
    expect(person?.id).toBe(updatedDet?.person_id ?? "");

    // Match attempt registrado como auto_matched
    const attempts = await matchAttemptsRepo.findByCheckin("chk-1");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.decision).toBe("auto_matched");
    expect(attempts[0]?.detection_id).toBe(det.id);
  });

  test("ambiguous: 2 detections anônimas na janela → match_attempt sem vincular", async () => {
    const cam = await camerasRepo.create({ name: "c2", ip_address: "10.0.0.2" });
    await erpRepo.upsertClient({ erp_id: "cli-2", name: "Cliente B", is_active: true });

    // 2 detections anônimas dentro da janela (≠ track_ids = pessoas distintas)
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

    // Match attempt = ambiguous, nenhuma detection foi vinculada
    const attempts = await matchAttemptsRepo.findByCheckin("chk-2");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.decision).toBe("ambiguous");
    expect(attempts[0]?.detection_id).toBeNull();
    expect(attempts[0]?.notes).toContain("2 candidates");

    // Person para cli-2 NÃO foi criada (não houve match)
    const person = await personsRepo.findByErpClientId("cli-2");
    expect(person).toBeNull();
  });

  test("rejected: 0 detections na janela → match_attempt com decision=rejected", async () => {
    await erpRepo.upsertClient({ erp_id: "cli-3", name: "Cliente C", is_active: true });
    const checkin = await erpRepo.upsertCheckin({
      erp_id: "chk-3",
      erp_client_id: "cli-3",
      event_type: "appointment_confirmed",
      occurred_at: new Date("2026-05-01T20:00:00Z"),
    });

    await processCheckin(checkin);

    const attempts = await matchAttemptsRepo.findByCheckin("chk-3");
    expect(attempts[0]?.decision).toBe("rejected");
  });

  test("idempotência: re-process não cria match_attempt duplicado", async () => {
    await erpRepo.upsertClient({ erp_id: "cli-4", name: "C", is_active: true });
    const checkin = await erpRepo.upsertCheckin({
      erp_id: "chk-4",
      erp_client_id: "cli-4",
      event_type: "x",
      occurred_at: new Date(),
    });
    await processCheckin(checkin);

    // 2nd run — checkin já tem processed_at, deve ser no-op
    const updated = await erpRepo.findCheckinByErpId("chk-4");
    if (updated) await processCheckin(updated);

    const attempts = await matchAttemptsRepo.findByCheckin("chk-4");
    expect(attempts).toHaveLength(1);
  });
});
