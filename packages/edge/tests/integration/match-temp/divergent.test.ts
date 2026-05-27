import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { processCheckin } from "../../../src/match-temp/orchestrator.js";
import { getDb } from "../../../src/persistence/db.js";
import { detectionsRepo } from "../../../src/persistence/repositories/detections.repo.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";
import { sessionsRepo } from "../../../src/persistence/repositories/sessions.repo.js";

let cameraId: string;
let clientY_personId: string;
let anonX_personId: string;
let clientW_personId: string;
let checkinErpId: string;

beforeEach(async () => {
  const db = getDb();
  const [cam] = await db.execute<{ id: string }>(sql`
    INSERT INTO cameras (id, name) VALUES (gen_random_uuid(), 'test-cam-div')
    RETURNING id
  `);
  if (!cam) throw new Error("camera insert returned no row");
  cameraId = cam.id;

  // Cliente do ERP (Y) com person já cadastrado
  await db.execute(sql`
    INSERT INTO erp_clients (erp_id, name, is_active)
    VALUES ('cli-y', 'Maria', true)
    ON CONFLICT (erp_id) DO UPDATE SET name = EXCLUDED.name
  `);
  const y = await personsRepo.create({
    display_name: "Maria",
    person_type: "client",
    erp_client_id: "cli-y",
  });
  clientY_personId = y.id;

  // Anônima X (reid criou)
  const x = await personsRepo.create({
    display_name: null,
    person_type: "anonymous",
  });
  anonX_personId = x.id;

  // Cliente W (reid auto-matched errado — diferente do checkin)
  await db.execute(sql`
    INSERT INTO erp_clients (erp_id, name, is_active)
    VALUES ('cli-w', 'Wagner', true)
    ON CONFLICT (erp_id) DO UPDATE SET name = EXCLUDED.name
  `);
  const w = await personsRepo.create({
    display_name: "Wagner",
    person_type: "client",
    erp_client_id: "cli-w",
  });
  clientW_personId = w.id;

  // Checkin: cliente Y no horário T
  checkinErpId = `chk-${Date.now()}`;
  await db.execute(sql`
    INSERT INTO erp_checkins (erp_id, erp_client_id, event_type, occurred_at, metadata)
    VALUES (${checkinErpId}, 'cli-y', 'in', ${new Date("2026-05-26T14:00:00Z")}, '{}')
  `);
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`DELETE FROM match_attempts WHERE erp_checkin_id = ${checkinErpId}`);
  await db.execute(sql`DELETE FROM detections WHERE camera_id = ${cameraId}`);
  await db.execute(sql`DELETE FROM sessions WHERE camera_id = ${cameraId}`);
  await db.execute(
    sql`DELETE FROM persons WHERE id IN (${clientY_personId}, ${anonX_personId}, ${clientW_personId})`,
  );
  await db.execute(sql`DELETE FROM erp_clients WHERE erp_id IN ('cli-y', 'cli-w')`);
  await db.execute(sql`DELETE FROM erp_checkins WHERE erp_id = ${checkinErpId}`);
  await db.execute(sql`DELETE FROM cameras WHERE id = ${cameraId}`);
});

async function makeDetection(personId: string | null, detectedAt: Date) {
  return detectionsRepo.create({
    camera_id: cameraId,
    person_id: personId,
    session_id: null,
    face_attrs: {},
    detected_at: detectedAt,
    raw_event: {},
  });
}

async function loadCheckin() {
  const db = getDb();
  const [r] = await db.execute<{
    erp_id: string;
    erp_client_id: string;
    event_type: string;
    occurred_at: Date;
    metadata: Record<string, unknown>;
    processed_at: Date | null;
  }>(sql`SELECT * FROM erp_checkins WHERE erp_id = ${checkinErpId}`);
  if (!r) throw new Error("checkin not found");
  return r;
}

async function getMatchAttempts() {
  const db = getDb();
  return db.execute<{
    detection_id: string | null;
    decision: string;
    previous_person_id: string | null;
  }>(
    sql`SELECT detection_id, decision, previous_person_id FROM match_attempts WHERE erp_checkin_id = ${checkinErpId}`,
  );
}

describe("processCheckin divergent (Onda 9-A §5.1)", () => {
  test("Row 3: detection já == cliente Y do checkin → NO-OP (zero match_attempts)", async () => {
    await makeDetection(clientY_personId, new Date("2026-05-26T14:00:30Z"));
    await processCheckin(await loadCheckin());
    const attempts = await getMatchAttempts();
    expect(attempts.length).toBe(0);
  });

  test("Row 4: detection anonymous X + checkin sugere Y → ambiguous com previous_person_id=X", async () => {
    const det = await makeDetection(anonX_personId, new Date("2026-05-26T14:00:30Z"));
    await processCheckin(await loadCheckin());
    const attempts = await getMatchAttempts();
    expect(attempts.length).toBe(1);
    expect(attempts[0]?.decision).toBe("ambiguous");
    expect(attempts[0]?.previous_person_id).toBe(anonX_personId);
    expect(attempts[0]?.detection_id).toBe(det.id);
  });

  test("Row 5: detection cliente W + checkin sugere cliente Y → ambiguous com previous_person_id=W", async () => {
    await makeDetection(clientW_personId, new Date("2026-05-26T14:00:30Z"));
    await processCheckin(await loadCheckin());
    const attempts = await getMatchAttempts();
    expect(attempts.length).toBe(1);
    expect(attempts[0]?.decision).toBe("ambiguous");
    expect(attempts[0]?.previous_person_id).toBe(clientW_personId);
  });

  test("Row 1: 1 detection NULL na janela → auto-match clássico (não toca caminho novo)", async () => {
    const det = await makeDetection(null, new Date("2026-05-26T14:00:30Z"));
    await processCheckin(await loadCheckin());
    const attempts = await getMatchAttempts();
    expect(attempts.length).toBe(1);
    expect(attempts[0]?.decision).toBe("auto_matched");
    expect(attempts[0]?.previous_person_id).toBeNull();
    const updated = await detectionsRepo.findById(det.id);
    expect(updated?.person_id).toBe(clientY_personId);
  });
});

// Silence unused import warning — sessionsRepo is imported per plan spec but not
// used by the current scenarios (kept for symmetry with Task 2 pattern).
void sessionsRepo;
