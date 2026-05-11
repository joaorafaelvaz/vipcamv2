import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const personType = pgEnum("person_type", ["client", "employee", "anonymous"]);

export const persons = pgTable(
  "persons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    display_name: text("display_name"),
    person_type: personType("person_type").notNull().default("anonymous"),
    erp_client_id: text("erp_client_id"),
    erp_employee_id: text("erp_employee_id"),
    first_seen_at: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    last_seen_at: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    total_visits: integer("total_visits").notNull().default(1),
    avg_satisfaction: real("avg_satisfaction"),
    estimated_age: integer("estimated_age"),
    estimated_gender: text("estimated_gender"),
    thumbnail_path: text("thumbnail_path"),
    notes: text("notes"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    erp_client_idx: index("persons_erp_client_idx").on(t.erp_client_id),
    erp_employee_idx: index("persons_erp_employee_idx").on(t.erp_employee_id),
    last_seen_idx: index("persons_last_seen_idx").on(t.last_seen_at),
  }),
);

export type Person = typeof persons.$inferSelect;
export type NewPerson = typeof persons.$inferInsert;
