import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { listPendingEnriched } from "../../../src/api/match-pending.js";
import { processCheckin } from "../../../src/match-temp/orchestrator.js";
import { closeDb } from "../../../src/persistence/db.js";
import {
  camerasRepo,
  detectionsRepo,
  erpRepo,
  sessionsRepo,
} from "../../../src/persistence/repositories/index.js";
import { truncateAll } from "../persistence/_helpers.js";

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
});

// Seeds an ambiguous match_attempt for `erpClientId` whose checkin is centered
// at `center`, with `candidateCount` anonymous detections at `center` (all
// inside the ±MATCH_WINDOW window) so processCheckin records it as ambiguous.
async function seedAmbiguous(opts: {
  cameraName: string;
  ipSuffix: number;
  erpClientId: string;
  clientName: string;
  checkinErpId: string;
  center: Date;
  candidateCount: number;
}): Promise<void> {
  const cam = await camerasRepo.create({
    name: opts.cameraName,
    ip_address: `10.0.0.${opts.ipSuffix}`,
  });
  await erpRepo.upsertClient({
    erp_id: opts.erpClientId,
    name: opts.clientName,
    is_active: true,
  });
  for (let i = 0; i < opts.candidateCount; i++) {
    const sess = await sessionsRepo.create({
      camera_id: cam.id,
      current_track_id: `${opts.checkinErpId}-t${i}`,
      started_at: opts.center,
      last_seen_at: opts.center,
      detection_count: 1,
    });
    await detectionsRepo.create({
      camera_id: cam.id,
      session_id: sess.id,
      detected_at: opts.center,
      raw_event: {},
      face_attrs: {},
    });
  }
  const checkin = await erpRepo.upsertCheckin({
    erp_id: opts.checkinErpId,
    erp_client_id: opts.erpClientId,
    event_type: "appointment_confirmed",
    occurred_at: new Date(opts.center.getTime() + 30_000),
  });
  await processCheckin(checkin);
}

describe("listPendingEnriched (D1 — single-query candidate assignment)", () => {
  test("each pending match gets only the candidates inside its own window", async () => {
    const centerA = new Date("2026-05-01T14:00:00Z");
    const centerB = new Date("2026-05-01T15:00:00Z"); // 1h apart → windows disjoint

    await seedAmbiguous({
      cameraName: "camA",
      ipSuffix: 1,
      erpClientId: "cli-A",
      clientName: "Cliente A",
      checkinErpId: "chk-A",
      center: centerA,
      candidateCount: 2,
    });
    await seedAmbiguous({
      cameraName: "camB",
      ipSuffix: 2,
      erpClientId: "cli-B",
      clientName: "Cliente B",
      checkinErpId: "chk-B",
      center: centerB,
      candidateCount: 3,
    });

    // A detection far outside BOTH windows must never be returned.
    const camC = await camerasRepo.create({ name: "camC", ip_address: "10.0.0.9" });
    const sessC = await sessionsRepo.create({
      camera_id: camC.id,
      current_track_id: "noise",
      started_at: new Date("2026-05-01T20:00:00Z"),
      last_seen_at: new Date("2026-05-01T20:00:00Z"),
      detection_count: 1,
    });
    await detectionsRepo.create({
      camera_id: camC.id,
      session_id: sessC.id,
      detected_at: new Date("2026-05-01T20:00:00Z"),
      raw_event: {},
      face_attrs: {},
    });

    const result = await listPendingEnriched(50);

    expect(result).toHaveLength(2);
    const byCheckin = new Map(result.map((r) => [r.checkin.erp_id, r]));

    const a = byCheckin.get("chk-A");
    const b = byCheckin.get("chk-B");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a?.candidates).toHaveLength(2);
    expect(b?.candidates).toHaveLength(3);

    const aTimes = a?.candidates.map((c) => new Date(c.detected_at).getTime()) ?? [];
    const bTimes = b?.candidates.map((c) => new Date(c.detected_at).getTime()) ?? [];
    for (const t of aTimes) expect(Math.abs(t - centerA.getTime())).toBeLessThan(310_000);
    for (const t of bTimes) expect(Math.abs(t - centerB.getTime())).toBeLessThan(310_000);
  });

  test("zero pending matches → [] with no further queries (early return preserved)", async () => {
    const result = await listPendingEnriched(50);
    expect(result).toEqual([]);
  });
});
