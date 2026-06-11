import type { ReidMatchPendingEnriched, ReidResolveDecision } from "@vipcam/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { getEnv } from "../../config/env.js";
import { getDb } from "../db.js";
import { detections } from "../schema/detections.js";
import { faceRecords } from "../schema/face-records.js";
import { persons } from "../schema/persons.js";
import {
  type NewReidMatchAttempt,
  type ReidMatchAttempt,
  reidMatchAttempts,
} from "../schema/reid-match-attempts.js";
import { personsRepo } from "./persons.repo.js";

export const reidMatchAttemptsRepo = {
  async createAmbiguous(
    data: Omit<NewReidMatchAttempt, "id" | "decision" | "decided_by" | "decided_at">,
  ): Promise<ReidMatchAttempt> {
    const [row] = await getDb()
      .insert(reidMatchAttempts)
      .values({ ...data, decision: "ambiguous", decided_by: "system" })
      .returning();
    if (!row) throw new Error("reid_match_attempts insert returned no row");
    return row;
  },

  /**
   * Lista reid_match_attempts ambiguous enriquecidos com detection + face_record +
   * candidate person, em DESC por decided_at. Cap em `limit` (UI default 50).
   */
  async findPendingEnriched(limit: number): Promise<ReidMatchPendingEnriched[]> {
    const rows = await getDb()
      .select({
        id: reidMatchAttempts.id,
        distance: reidMatchAttempts.distance,
        decided_at: reidMatchAttempts.decided_at,
        det_id: detections.id,
        det_detected_at: detections.detected_at,
        det_snapshot_path: detections.snapshot_path,
        det_camera_id: detections.camera_id,
        fr_id: faceRecords.id,
        fr_person_id: faceRecords.person_id,
        fr_snapshot_path: faceRecords.snapshot_path,
        p_display_name: persons.display_name,
        p_person_type: persons.person_type,
      })
      .from(reidMatchAttempts)
      .innerJoin(detections, eq(detections.id, reidMatchAttempts.detection_id))
      .innerJoin(faceRecords, eq(faceRecords.id, reidMatchAttempts.candidate_face_record_id))
      .innerJoin(persons, eq(persons.id, reidMatchAttempts.candidate_person_id))
      .where(eq(reidMatchAttempts.decision, "ambiguous"))
      .orderBy(desc(reidMatchAttempts.decided_at))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      distance: r.distance,
      decided_at: r.decided_at.toISOString(),
      detection: {
        id: r.det_id,
        detected_at: r.det_detected_at.toISOString(),
        snapshot_path: r.det_snapshot_path,
        camera_id: r.det_camera_id,
      },
      candidate: {
        face_record_id: r.fr_id,
        person_id: r.fr_person_id,
        snapshot_path: r.fr_snapshot_path,
        person_display_name: r.p_display_name,
        person_type: r.p_person_type,
      },
    }));
  },

  /**
   * Resolve um reid_match_attempt ambiguous.
   *
   * - `matched_to_candidate`: detection nova pertence ao candidate person.
   *   Se detection.person_id já existe (cenário raro pós-borderline com
   *   inheritance), chamamos mergeInto(detection.person_id, candidate.person_id).
   *   Senão UPDATE detection.person_id = candidate.person_id.
   *
   * - `rejected_new_person`: cria person anonymous nova, UPDATE detection.
   */
  async resolve(attemptId: string, decision: ReidResolveDecision, userId: string): Promise<void> {
    const db = getDb();
    const [att] = await db
      .select({
        detection_id: reidMatchAttempts.detection_id,
        candidate_person_id: reidMatchAttempts.candidate_person_id,
        det_current_person_id: detections.person_id,
        det_detected_at: detections.detected_at,
      })
      .from(reidMatchAttempts)
      .innerJoin(detections, eq(detections.id, reidMatchAttempts.detection_id))
      .where(and(eq(reidMatchAttempts.id, attemptId), eq(reidMatchAttempts.decision, "ambiguous")))
      .limit(1);

    if (!att) {
      throw new Error(`reid_match_attempt ${attemptId} not found or not ambiguous`);
    }

    if (decision === "matched_to_candidate") {
      if (att.det_current_person_id && att.det_current_person_id !== att.candidate_person_id) {
        await personsRepo.mergeInto(att.det_current_person_id, att.candidate_person_id, userId);
      } else {
        await db.execute(sql`
          UPDATE detections SET person_id = ${att.candidate_person_id}
          WHERE id = ${att.detection_id}
        `);
        // Onda 11: visita nova só se gap > VISIT_GAP_HOURS (dedup de avistamentos).
        await personsRepo.recordSighting(
          att.candidate_person_id,
          att.det_detected_at,
          getEnv().VISIT_GAP_HOURS,
        );
      }
    } else {
      const newPerson = await personsRepo.create({
        person_type: "anonymous",
        first_seen_at: att.det_detected_at,
        last_seen_at: att.det_detected_at,
      });
      await db.execute(sql`
        UPDATE detections SET person_id = ${newPerson.id}
        WHERE id = ${att.detection_id}
      `);
    }

    await db.execute(sql`
      UPDATE reid_match_attempts
      SET decision = ${decision}, decided_by = 'user', decided_at = now()
      WHERE id = ${attemptId}
    `);
  },
};
