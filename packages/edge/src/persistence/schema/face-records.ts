import { sql } from "drizzle-orm";
import { boolean, customType, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { persons } from "./persons.js";

// pgvector custom type — vetor de 512 dimensões usado pelo failover B (InsightFace buffalo_s).
// Permanece NULL na Onda 2 (Re-id A não viável neste hardware — Face DB câmera não existe);
// será populado em Onda 3 quando InsightFace local rodar (sidecar Python + match local).
const vector512 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(512)";
  },
  toDriver(value: number[]) {
    return `[${value.join(",")}]`;
  },
});

export const faceRecords = pgTable(
  "face_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    person_id: uuid("person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    // ID retornado pelo Face DB embarcado da câmera (NULL nesta Onda 2 — câmera
    // DH-IPC-HFW5442T-ASE não tem Face DB CGI; ver discovery report 2026-05-11)
    camera_face_id: text("camera_face_id"),
    embedding: vector512("embedding"),
    snapshot_path: text("snapshot_path").notNull(),
    is_primary: boolean("is_primary").notNull().default(false),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    person_idx: index("face_records_person_idx").on(t.person_id),
    camera_face_idx: index("face_records_camera_face_idx").on(t.camera_face_id),
    // HNSW index para failover B — m=16, ef_construction=64 são defaults sãos.
    // Índice criado mesmo com tabela vazia, evita migration mid-project (advisory da spec §4.1).
    embedding_hnsw_idx: index("face_records_embedding_hnsw_idx")
      .using("hnsw", sql`embedding vector_cosine_ops`)
      .with({ m: 16, ef_construction: 64 }),
  }),
);

export type FaceRecord = typeof faceRecords.$inferSelect;
export type NewFaceRecord = typeof faceRecords.$inferInsert;
