import { sql } from "drizzle-orm";
import { index, pgEnum, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { detections } from "./detections.js";
import { faceRecords } from "./face-records.js";
import { persons } from "./persons.js";

export const reidDecision = pgEnum("reid_decision", [
  "ambiguous",
  "matched_to_candidate",
  "rejected_new_person",
]);
export const reidDecidedBy = pgEnum("reid_decided_by", ["system", "user"]);

/**
 * Borderline reid matches (distance entre REID_DIST_STRICT e REID_DIST_LOOSE)
 * — humano decide via /matches UI se a detection é o mesmo person do
 * candidato (merge) ou pessoa nova (reject).
 *
 * Separada de match_attempts (temporal/ERP) porque o dado é diferente:
 * temporal aponta pra checkin, aqui aponta pra face_record candidato.
 */
export const reidMatchAttempts = pgTable(
  "reid_match_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    detection_id: uuid("detection_id")
      .notNull()
      .references(() => detections.id, { onDelete: "cascade" }),
    candidate_face_record_id: uuid("candidate_face_record_id")
      .notNull()
      .references(() => faceRecords.id, { onDelete: "cascade" }),
    candidate_person_id: uuid("candidate_person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    distance: real("distance").notNull(),
    decision: reidDecision("decision").notNull().default("ambiguous"),
    decided_by: reidDecidedBy("decided_by").notNull().default("system"),
    decided_at: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    notes: text("notes"),
  },
  (t) => ({
    detection_idx: index("reid_match_attempts_detection_idx").on(t.detection_id),
    pending_idx: index("reid_match_attempts_pending_idx")
      .on(t.decided_at)
      .where(sql`${t.decision} = 'ambiguous'`),
  }),
);

export type ReidMatchAttempt = typeof reidMatchAttempts.$inferSelect;
export type NewReidMatchAttempt = typeof reidMatchAttempts.$inferInsert;
