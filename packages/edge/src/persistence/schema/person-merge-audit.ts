import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Audit trail de merges executados em personsRepo.mergeInto.
 *
 * src_id e dst_id NÃO têm FK pra persons porque src some imediatamente após
 * o INSERT deste row. Mantemos os UUIDs como referência histórica;
 * src_snapshot tem o estado completo de src antes do delete (rehidratação
 * manual via SQL se necessário). dst_id também sem FK pra simetria — se um
 * merge subsequente eliminar Y, o audit anterior permanece legível.
 */
export const personMergeAudit = pgTable("person_merge_audit", {
  id: uuid("id").primaryKey().defaultRandom(),
  src_id: uuid("src_id").notNull(),
  dst_id: uuid("dst_id").notNull(),
  merged_at: timestamp("merged_at", { withTimezone: true }).notNull().defaultNow(),
  // UUID do operador (NextAuth) OU "system" enquanto auth real não chega.
  merged_by: text("merged_by").notNull(),
  src_snapshot: jsonb("src_snapshot").$type<Record<string, unknown>>().notNull(),
});

export type PersonMergeAuditRow = typeof personMergeAudit.$inferSelect;
export type NewPersonMergeAuditRow = typeof personMergeAudit.$inferInsert;
