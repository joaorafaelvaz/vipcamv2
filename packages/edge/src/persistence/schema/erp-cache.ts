import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const erpClients = pgTable(
  "erp_clients",
  {
    erp_id: text("erp_id").primaryKey(), // string porque ERP pode usar formatos variados
    name: text("name").notNull(),
    phone: text("phone"),
    photo_path: text("photo_path"),
    is_active: boolean("is_active").notNull().default(true),
    erp_updated_at: timestamp("erp_updated_at", { withTimezone: true }),
    synced_at: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    name_idx: index("erp_clients_name_idx").on(t.name),
  }),
);

export const erpEmployees = pgTable(
  "erp_employees",
  {
    erp_id: text("erp_id").primaryKey(),
    name: text("name").notNull(),
    role: text("role"),
    photo_path: text("photo_path"),
    photo_hash: text("photo_hash"), // SHA-256 da foto, usado pra detectar mudanças
    is_active: boolean("is_active").notNull().default(true),
    erp_updated_at: timestamp("erp_updated_at", { withTimezone: true }),
    synced_at: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    name_idx: index("erp_employees_name_idx").on(t.name),
  }),
);

export const erpCheckins = pgTable(
  "erp_checkins",
  {
    erp_id: text("erp_id").primaryKey(), // ID do checkin no ERP
    erp_client_id: text("erp_client_id").notNull(),
    event_type: text("event_type").notNull(), // "appointment_confirmed" | "service_started" | etc.
    occurred_at: timestamp("occurred_at", { withTimezone: true }).notNull(),
    processed_at: timestamp("processed_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
  },
  (t) => ({
    client_idx: index("erp_checkins_client_idx").on(t.erp_client_id),
    occurred_idx: index("erp_checkins_occurred_idx").on(t.occurred_at),
    // Query crítica: checkins não-processados ordenados por tempo
    unprocessed_idx: index("erp_checkins_unprocessed_idx")
      .on(t.occurred_at)
      .where(sql`${t.processed_at} IS NULL`),
  }),
);

export type ErpClient = typeof erpClients.$inferSelect;
export type NewErpClient = typeof erpClients.$inferInsert;
export type ErpEmployee = typeof erpEmployees.$inferSelect;
export type NewErpEmployee = typeof erpEmployees.$inferInsert;
export type ErpCheckin = typeof erpCheckins.$inferSelect;
export type NewErpCheckin = typeof erpCheckins.$inferInsert;
