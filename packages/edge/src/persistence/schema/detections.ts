import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { cameras } from "./cameras.js";
import { persons } from "./persons.js";
import { sessions } from "./sessions.js";

export const detections = pgTable(
  "detections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    camera_id: uuid("camera_id")
      .notNull()
      .references(() => cameras.id, { onDelete: "cascade" }),
    person_id: uuid("person_id").references(() => persons.id, { onDelete: "set null" }),
    session_id: uuid("session_id").references(() => sessions.id, { onDelete: "cascade" }),
    // ID de tracking dentro da sessão da câmera (não estável entre sessões)
    track_id: text("track_id"),
    bbox: jsonb("bbox").$type<{ x: number; y: number; w: number; h: number }>(),
    face_attrs: jsonb("face_attrs").$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
    dominant_emotion: text("dominant_emotion"),
    emotion_confidence: real("emotion_confidence"),
    snapshot_path: text("snapshot_path"),
    detected_at: timestamp("detected_at", { withTimezone: true }).notNull(),
    // Payload original Dahua para auditoria; truncado pelo retention job após 30d
    raw_event: jsonb("raw_event").notNull(),
  },
  (t) => ({
    camera_idx: index("detections_camera_idx").on(t.camera_id),
    person_idx: index("detections_person_idx").on(t.person_id),
    session_idx: index("detections_session_idx").on(t.session_id),
    detected_idx: index("detections_detected_idx").on(t.detected_at),
    // Query crítica do match temporal: anônimas em janela de tempo
    anonymous_window_idx: index("detections_anonymous_window_idx")
      .on(t.detected_at)
      .where(sql`${t.person_id} IS NULL`),
  }),
);

export type Detection = typeof detections.$inferSelect;
export type NewDetection = typeof detections.$inferInsert;
