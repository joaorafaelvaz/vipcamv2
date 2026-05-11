import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const cameras = pgTable("cameras", {
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
});

export type Camera = typeof cameras.$inferSelect;
export type NewCamera = typeof cameras.$inferInsert;
