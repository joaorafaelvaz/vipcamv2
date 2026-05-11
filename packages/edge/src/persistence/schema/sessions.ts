import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { cameras } from "./cameras.js";
import { persons } from "./persons.js";

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    person_id: uuid("person_id").references(() => persons.id, { onDelete: "set null" }),
    camera_id: uuid("camera_id")
      .notNull()
      .references(() => cameras.id, { onDelete: "cascade" }),
    // Track ID atual da câmera (estável durante a sessão, descartado quando fecha).
    // Permite findOpenForTrack reusar sessão sem JOIN em detections.
    current_track_id: text("current_track_id"),
    started_at: timestamp("started_at", { withTimezone: true }).notNull(),
    // Atualizado a cada nova detection — usado pelo gap-based session tracker.
    last_seen_at: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    ended_at: timestamp("ended_at", { withTimezone: true }),
    detection_count: integer("detection_count").notNull().default(0),
    dominant_emotion: text("dominant_emotion"),
    avg_emotion_scores: jsonb("avg_emotion_scores")
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'`),
    linked_erp_checkin_id: text("linked_erp_checkin_id"),
  },
  (t) => ({
    person_idx: index("sessions_person_idx").on(t.person_id),
    camera_idx: index("sessions_camera_idx").on(t.camera_id),
    started_idx: index("sessions_started_idx").on(t.started_at),
    // sessões "abertas" (ended_at IS NULL) são consultadas com frequência
    open_idx: index("sessions_open_idx").on(t.camera_id, t.started_at),
    // Lookup crítico do session-tracker: sessão aberta para (camera, track)
    open_track_idx: index("sessions_open_track_idx")
      .on(t.camera_id, t.current_track_id)
      .where(sql`${t.ended_at} IS NULL`),
  }),
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
