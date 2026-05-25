import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { detectionsRepo } from "../../../src/persistence/repositories/detections.repo.js";
import { faceRecordsRepo } from "../../../src/persistence/repositories/face-records.repo.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";
import { reidMatchAttemptsRepo } from "../../../src/persistence/repositories/reid-match-attempts.repo.js";
import { sessionsRepo } from "../../../src/persistence/repositories/sessions.repo.js";
import { getDb } from "../../../src/persistence/db.js";

function vec(s: number): number[] {
  return Array.from({ length: 512 }, (_, i) => (s * (i + 1)) / 1e6);
}

let cameraId: string;
let candidatePersonId: string;
let detectionId: string;
let frId: string;
let attemptId: string;

beforeEach(async () => {
  const db = getDb();
  const camRows = await db.execute<{ id: string }>(sql`
    INSERT INTO cameras (id, name) VALUES (gen_random_uuid(), 'test-cam')
    RETURNING id
  `);
  const cam = camRows[0];
  if (!cam) throw new Error("cameras insert returned no row");
  cameraId = cam.id;

  const candP = await personsRepo.create({
    display_name: "João Cliente",
    person_type: "client",
  });
  candidatePersonId = candP.id;

  const fr = await faceRecordsRepo.insertAndEvict({
    person_id: candidatePersonId,
    embedding: vec(1),
    snapshot_path: "2026-05-15/cand.jpg",
    det_score: 0.9,
    model_name: "buffalo_s",
    model_revision: "insightface-0.7.3",
  });
  frId = fr.id;

  const sess = await sessionsRepo.create({
    camera_id: cameraId,
    person_id: null,
    started_at: new Date("2026-05-20T14:00:00Z"),
    last_seen_at: new Date("2026-05-20T14:00:00Z"),
    detection_count: 1,
  });
  const det = await detectionsRepo.create({
    camera_id: cameraId,
    person_id: null,
    session_id: sess.id,
    face_attrs: { reid_status: "borderline", reid_distance: 0.45 },
    detected_at: new Date("2026-05-20T14:00:00Z"),
    raw_event: { test: true },
    snapshot_path: "2026-05-20/det-new.jpg",
  });
  detectionId = det.id;

  const att = await reidMatchAttemptsRepo.createAmbiguous({
    detection_id: detectionId,
    candidate_face_record_id: frId,
    candidate_person_id: candidatePersonId,
    distance: 0.45,
  });
  attemptId = att.id;
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`DELETE FROM reid_match_attempts WHERE detection_id = ${detectionId}`);
  await db.execute(sql`DELETE FROM detections WHERE id = ${detectionId}`);
  await db.execute(sql`DELETE FROM face_records WHERE id = ${frId}`);
  await db.execute(sql`DELETE FROM persons WHERE id = ${candidatePersonId}`);
  await db.execute(sql`DELETE FROM sessions WHERE camera_id = ${cameraId}`);
  await db.execute(sql`DELETE FROM cameras WHERE id = ${cameraId}`);
});

describe("reidMatchAttemptsRepo.findPendingEnriched", () => {
  test("retorna ambiguous joined com detection + face_record + person", async () => {
    const items = await reidMatchAttemptsRepo.findPendingEnriched(50);
    const ours = items.find((i) => i.id === attemptId);
    expect(ours).toBeDefined();
    expect(ours!.distance).toBe(0.45);
    expect(ours!.detection.id).toBe(detectionId);
    expect(ours!.detection.snapshot_path).toBe("2026-05-20/det-new.jpg");
    expect(ours!.candidate.face_record_id).toBe(frId);
    expect(ours!.candidate.person_id).toBe(candidatePersonId);
    expect(ours!.candidate.snapshot_path).toBe("2026-05-15/cand.jpg");
    expect(ours!.candidate.person_display_name).toBe("João Cliente");
    expect(ours!.candidate.person_type).toBe("client");
  });

  test("respeita limit + DESC order", async () => {
    for (let i = 0; i < 2; i++) {
      const det = await detectionsRepo.create({
        camera_id: cameraId,
        person_id: null,
        session_id: null,
        face_attrs: {},
        detected_at: new Date(`2026-05-20T15:0${i}:00Z`),
        raw_event: {},
      });
      await reidMatchAttemptsRepo.createAmbiguous({
        detection_id: det.id,
        candidate_face_record_id: frId,
        candidate_person_id: candidatePersonId,
        distance: 0.4 + i * 0.02,
      });
    }
    const limited = await reidMatchAttemptsRepo.findPendingEnriched(2);
    expect(limited.length).toBe(2);
    expect(new Date(limited[0]!.decided_at).getTime()).toBeGreaterThanOrEqual(
      new Date(limited[1]!.decided_at).getTime(),
    );
  });
});

describe("reidMatchAttemptsRepo.resolve", () => {
  test("matched_to_candidate: UPDATE detection.person_id (sem merge — det.person_id era null)", async () => {
    await reidMatchAttemptsRepo.resolve(attemptId, "matched_to_candidate", "user-1");
    const db = getDb();
    const detRows = await db.execute<{ pid: string }>(
      sql`SELECT person_id AS pid FROM detections WHERE id = ${detectionId}`,
    );
    expect(detRows[0]?.pid).toBe(candidatePersonId);
    const attRows = await db.execute<{ d: string; by: string }>(
      sql`SELECT decision AS d, decided_by AS by FROM reid_match_attempts WHERE id = ${attemptId}`,
    );
    expect(attRows[0]?.d).toBe("matched_to_candidate");
    expect(attRows[0]?.by).toBe("user");
  });

  test("rejected_new_person: cria anonymous nova + atribui detection a ela", async () => {
    await reidMatchAttemptsRepo.resolve(attemptId, "rejected_new_person", "user-2");
    const db = getDb();
    const detRows = await db.execute<{ pid: string | null }>(
      sql`SELECT person_id AS pid FROM detections WHERE id = ${detectionId}`,
    );
    const pid = detRows[0]?.pid;
    expect(pid).not.toBeNull();
    expect(pid).toBeDefined();
    expect(pid).not.toBe(candidatePersonId);
    const newP = await personsRepo.findById(pid!);
    expect(newP?.person_type).toBe("anonymous");
    await db.execute(sql`DELETE FROM persons WHERE id = ${pid}`);
  });
});
