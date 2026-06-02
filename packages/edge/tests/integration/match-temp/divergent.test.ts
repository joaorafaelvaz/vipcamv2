import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { processCheckin } from "../../../src/match-temp/orchestrator.js";
import { getDb } from "../../../src/persistence/db.js";
import { detectionsRepo } from "../../../src/persistence/repositories/detections.repo.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";

// Onda 9-D: a resolução virou decisão única por checkin (candidates.ts). Os
// cenários antes "divergentes por-detecção" agora:
//  - 1 anônimo distinto  → AUTO-MERGE (anon → Y).
//  - outro cliente W     → EXCLUÍDO (rejected; não vira attempt).
//  - convergente (Y)     → no-op.
//  - 1 NULL              → auto-match clássico.
//  - ≥2 anônimos         → ambíguos colapsados (1 por pessoa).
//  - funcionário/staff   → excluídos.

let cameraId: string;
let clientY_personId: string;
let anonX_personId: string;
let clientW_personId: string;
let employeeE_personId: string;
let checkinErpId: string;
const HOUR = 3_600_000;

beforeEach(async () => {
  const db = getDb();
  const [cam] = await db.execute<{ id: string }>(sql`
    INSERT INTO cameras (id, name) VALUES (gen_random_uuid(), 'test-cam-div') RETURNING id
  `);
  if (!cam) throw new Error("camera insert returned no row");
  cameraId = cam.id;

  await db.execute(sql`
    INSERT INTO erp_clients (erp_id, name, is_active) VALUES ('cli-y', 'Maria', true)
    ON CONFLICT (erp_id) DO UPDATE SET name = EXCLUDED.name
  `);
  const y = await personsRepo.create({
    display_name: "Maria",
    person_type: "client",
    erp_client_id: "cli-y",
  });
  clientY_personId = y.id;

  const x = await personsRepo.create({ display_name: null, person_type: "anonymous" });
  anonX_personId = x.id;

  await db.execute(sql`
    INSERT INTO erp_clients (erp_id, name, is_active) VALUES ('cli-w', 'Wagner', true)
    ON CONFLICT (erp_id) DO UPDATE SET name = EXCLUDED.name
  `);
  const w = await personsRepo.create({
    display_name: "Wagner",
    person_type: "client",
    erp_client_id: "cli-w",
  });
  clientW_personId = w.id;

  const e = await personsRepo.create({ display_name: "Func", person_type: "employee" });
  employeeE_personId = e.id;

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
  // anonX pode ter sido deletado por mergeInto — DELETE é no-op nesse caso.
  await db.execute(
    sql`DELETE FROM persons WHERE id IN (${clientY_personId}, ${anonX_personId}, ${clientW_personId}, ${employeeE_personId})`,
  );
  await db.execute(sql`DELETE FROM person_merge_audit WHERE dst_id = ${clientY_personId}`);
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
  const [r] = await getDb().execute<{
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
  return getDb().execute<{
    detection_id: string | null;
    decision: string;
    previous_person_id: string | null;
  }>(
    sql`SELECT detection_id, decision, previous_person_id FROM match_attempts WHERE erp_checkin_id = ${checkinErpId}`,
  );
}

const W = new Date("2026-05-26T14:00:30Z"); // dentro da janela ±5min

describe("processCheckin (Onda 9-D — decisão única)", () => {
  test("convergente: detecção já == Y → no-op (0 attempts)", async () => {
    await makeDetection(clientY_personId, W);
    await processCheckin(await loadCheckin());
    expect((await getMatchAttempts()).length).toBe(0);
  });

  test("auto-merge: 1 anônimo X distinto na janela → mergeInto(X→Y) + auto_matched", async () => {
    const det = await makeDetection(anonX_personId, W);
    await processCheckin(await loadCheckin());

    // X foi absorvido em Y (deletado pelo merge); a detecção agora pertence a Y.
    expect(await personsRepo.findById(anonX_personId)).toBeNull();
    expect((await detectionsRepo.findById(det.id))?.person_id).toBe(clientY_personId);

    const attempts = await getMatchAttempts();
    expect(attempts.length).toBe(1);
    expect(attempts[0]?.decision).toBe("auto_matched");
    expect(attempts[0]?.previous_person_id).toBeNull(); // X deletado — id vai nas notes
    expect(attempts[0]?.detection_id).toBe(det.id);
  });

  test("outro cliente W (≠ Y) é excluído dos candidatos → rejected (0 attempts), W intacto", async () => {
    await makeDetection(clientW_personId, W);
    await processCheckin(await loadCheckin());
    expect((await getMatchAttempts()).length).toBe(0);
    expect(await personsRepo.findById(clientW_personId)).not.toBeNull();
  });

  test("funcionário é excluído dos candidatos → rejected (0 attempts)", async () => {
    await makeDetection(employeeE_personId, W);
    await processCheckin(await loadCheckin());
    expect((await getMatchAttempts()).length).toBe(0);
  });

  test("1 NULL na janela → auto-match clássico (linka detecção a Y)", async () => {
    const det = await makeDetection(null, W);
    await processCheckin(await loadCheckin());
    const attempts = await getMatchAttempts();
    expect(attempts.length).toBe(1);
    expect(attempts[0]?.decision).toBe("auto_matched");
    expect(attempts[0]?.previous_person_id).toBeNull();
    expect((await detectionsRepo.findById(det.id))?.person_id).toBe(clientY_personId);
  });

  test("≥2 anônimos distintos → colapsado: 1 attempt ambíguo por pessoa (não por detecção)", async () => {
    const x2 = await personsRepo.create({ display_name: null, person_type: "anonymous" });
    try {
      // X com 2 detecções, X2 com 1 — esperado: 2 attempts (1 por pessoa).
      await makeDetection(anonX_personId, W);
      await makeDetection(anonX_personId, new Date(W.getTime() + 10_000));
      await makeDetection(x2.id, new Date(W.getTime() + 20_000));

      await processCheckin(await loadCheckin());

      const attempts = await getMatchAttempts();
      const ambiguous = attempts.filter((a) => a.decision === "ambiguous");
      expect(ambiguous.length).toBe(2);
      const prevIds = new Set(ambiguous.map((a) => a.previous_person_id));
      expect(prevIds.has(anonX_personId)).toBe(true);
      expect(prevIds.has(x2.id)).toBe(true);
      // nenhum merge (ambíguo) → X ainda existe
      expect(await personsRepo.findById(anonX_personId)).not.toBeNull();
    } finally {
      await getDb().execute(sql`DELETE FROM match_attempts WHERE previous_person_id = ${x2.id}`);
      await getDb().execute(sql`DELETE FROM detections WHERE person_id = ${x2.id}`);
      await getDb().execute(sql`DELETE FROM persons WHERE id = ${x2.id}`);
    }
  });

  test("anônimo staff-like (onipresente) é excluído → rejected", async () => {
    // Gera presença em ≥ STAFF_MIN_ACTIVE_HOURS(20) slots de hora distintos
    // recentes (últimos 7 dias) pro anônimo X, + 1 detecção na janela do checkin.
    const base = Date.now();
    for (let h = 0; h < 22; h++) {
      await makeDetection(anonX_personId, new Date(base - h * HOUR));
    }
    await makeDetection(anonX_personId, W); // na janela do checkin

    await processCheckin(await loadCheckin());

    // X é staff-like → excluído; era o único candidato → rejected (0 attempts).
    expect((await getMatchAttempts()).length).toBe(0);
    // X NÃO foi merged (segue existindo).
    expect(await personsRepo.findById(anonX_personId)).not.toBeNull();
  });
});
