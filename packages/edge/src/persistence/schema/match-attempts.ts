import { sql } from "drizzle-orm";
import { index, pgEnum, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { detections } from "./detections.js";
import { erpCheckins } from "./erp-cache.js";

export const matchDecision = pgEnum("match_decision", ["auto_matched", "ambiguous", "rejected"]);
export const matchDecidedBy = pgEnum("match_decided_by", ["system", "user"]);

export const matchAttempts = pgTable(
  "match_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    detection_id: uuid("detection_id").references(() => detections.id, {
      onDelete: "cascade",
    }),
    erp_checkin_id: text("erp_checkin_id").references(() => erpCheckins.erp_id, {
      onDelete: "cascade",
    }),
    confidence_score: real("confidence_score"),
    decision: matchDecision("decision").notNull(),
    decided_at: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    decided_by: matchDecidedBy("decided_by").notNull().default("system"),
    notes: text("notes"),
  },
  (t) => ({
    decision_idx: index("match_attempts_decision_idx").on(t.decision),
    detection_idx: index("match_attempts_detection_idx").on(t.detection_id),
    checkin_idx: index("match_attempts_checkin_idx").on(t.erp_checkin_id),
    // Query crítica da UI: ambíguos pendentes de revisão
    pending_idx: index("match_attempts_pending_idx")
      .on(t.decided_at)
      .where(sql`${t.decision} = 'ambiguous'`),
  }),
);

export type MatchAttempt = typeof matchAttempts.$inferSelect;
export type NewMatchAttempt = typeof matchAttempts.$inferInsert;
