import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getDb } from "../../../src/persistence/db.js";

/**
 * Hard guard: integration tests destroem dados (TRUNCATE CASCADE em todas as
 * tabelas). NUNCA podem rodar contra DB de produção. Aceita apenas DBs cujo
 * nome contém 'test' OU que rode num host explicitamente whitelist
 * (localhost padrão para dev local).
 *
 * Em produção (Onda 2 first deploy) tests integration apagaram cameras +
 * detections reais. Este guard previne reincidência: se DATABASE_URL aponta
 * pra DB chamada 'vipcam' rodando em qualquer host, dispara erro.
 */
function assertSafeTestDb(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL not set — cannot run integration tests");

  // Extrai nome do DB (parte após o último '/'). Ex: postgres://u:p@h:5432/vipcam → 'vipcam'
  const match = url.match(/\/([^/?]+)(?:\?|$)/);
  const dbName = match?.[1] ?? "";

  // Heurística: nome contém 'test' OU env explicitamente autoriza
  const looksLikeTestDb = dbName.includes("test") || dbName.includes("Test");
  const explicitOptIn = process.env.VIPCAM_TEST_DB_OK === "yes-i-know-what-im-doing";

  if (!looksLikeTestDb && !explicitOptIn) {
    throw new Error(
      [
        `REFUSING TO TRUNCATE: DATABASE_URL aponta para '${dbName}' — não parece DB de teste.`,
        "Para tests integration use um DB com 'test' no nome (ex: 'vipcam_test'),",
        "ou exporte VIPCAM_TEST_DB_OK=yes-i-know-what-im-doing se está intencional.",
      ].join("\n"),
    );
  }
}

/**
 * Trunca todas as tabelas para isolamento de teste. Mais rápido que dropar/recriar.
 * Pré-requisito: schema já aplicado via `bun run db:migrate`.
 *
 * SAFETY: assertSafeTestDb() previne uso contra DB de produção (lições do
 * first deploy da Onda 2 — TRUNCATE em DB 'vipcam' apagou dados reais).
 */
export async function truncateAll(db: PostgresJsDatabase = getDb()): Promise<void> {
  assertSafeTestDb();
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
