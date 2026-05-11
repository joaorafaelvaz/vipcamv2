import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getDb } from "../../../src/persistence/db.js";

/**
 * Trunca todas as tabelas para isolamento de teste. Mais rápido que dropar/recriar.
 * Pré-requisito: schema já aplicado via `bun run db:migrate`.
 */
export async function truncateAll(db: PostgresJsDatabase = getDb()): Promise<void> {
  await db.execute(sql`
    TRUNCATE TABLE
      match_attempts,
      sentiment_records,
      detections,
      sessions,
      face_records,
      persons,
      cameras,
      erp_checkins,
      erp_employees,
      erp_clients
    RESTART IDENTITY CASCADE
  `);
}
