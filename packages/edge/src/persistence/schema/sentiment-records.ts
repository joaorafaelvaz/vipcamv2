import { index, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { detections } from "./detections.js";
import { persons } from "./persons.js";
import { sessions } from "./sessions.js";

export const sentimentRecords = pgTable(
  "sentiment_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Granular: 1 por detection durante 30 dias; agregado depois (consolidado em sessions.avg_emotion_scores)
    detection_id: uuid("detection_id").references(() => detections.id, { onDelete: "cascade" }),
    session_id: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    person_id: uuid("person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    emotion: text("emotion").notNull(),
    confidence: real("confidence").notNull(),
    recorded_at: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    person_recorded_idx: index("sentiment_person_recorded_idx").on(t.person_id, t.recorded_at),
    session_idx: index("sentiment_session_idx").on(t.session_id),
  }),
);

export type SentimentRecord = typeof sentimentRecords.$inferSelect;
export type NewSentimentRecord = typeof sentimentRecords.$inferInsert;
