import { sql } from "drizzle-orm";
import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const cameras = pgTable(
  "cameras",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    ip_address: text("ip_address").notNull(),
    // env var name que guarda usuário/senha (ex: "CAMERA_USER" / "CAMERA_PASS").
    // Não armazenamos credentials em DB.
    credentials_ref: text("credentials_ref").notNull().default("CAMERA"),
    face_db_capacity: integer("face_db_capacity").notNull().default(10000),
    face_db_used: integer("face_db_used").notNull().default(0),
    is_active: boolean("is_active").notNull().default(true),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // 1 câmera ATIVA por IP. Index parcial permite soft-delete + recadastro
    // (cameras inativas com mesmo IP não bloqueiam novo INSERT ativo) e
    // preserva histórico de detections/sessions ligadas a cameras antigas.
    //
    // Previne erro humano observado em produção (Onda 2 first deploy):
    // INSERT executado 2x criou 2 cameras idênticas ativas, listener subiu
    // 2 conexões attach contra a mesma URL.
    active_ip_uniq: uniqueIndex("cameras_active_ip_uniq")
      .on(t.ip_address)
      .where(sql`${t.is_active} = true`),
  }),
);

export type Camera = typeof cameras.$inferSelect;
export type NewCamera = typeof cameras.$inferInsert;
