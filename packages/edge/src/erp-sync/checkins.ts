import { sql } from "drizzle-orm";
import { getEnv } from "../config/env.js";
import { logger } from "../obs/logger.js";
import { getDb } from "../persistence/db.js";
import { erpRepo } from "../persistence/repositories/index.js";
import { erpCheckins } from "../persistence/schema/erp-cache.js";
import { fetchErpCheckinsSince } from "./queries.js";

/** Início da janela deslizante: now − lookbackHours. Pura (Onda 9-C). */
export function computeSince(now: Date, lookbackHours: number): Date {
  return new Date(now.getTime() - lookbackHours * 3_600_000);
}

/**
 * Cursor in-memory: maior occurred_at já visto. Reconciliado no boot via
 * MAX(occurred_at) do cache local — sobrevive a restart do edge.
 *
 * **I5 (review 2026-05-13):** cursor avança APENAS depois do upsert ter
 * sucesso (ou se o row já existe localmente). Antes do fix, cursor avançava
 * antes do upsert — se upsert falhasse, cursor ultrapassava e o row era
 * perdido permanentemente (próxima query 'since cursor' não pegava de novo).
 *
 * Trade-off: se upsert falha consistentemente (DB down), cursor congela e
 * loop quente warna a cada rodada. Aceito vs. perder dados — operador vê
 * WARN e age.
 */
let cursor: Date | null = null;

async function getInitialCursor(): Promise<Date> {
  const rows = await getDb()
    .select({ max: sql<Date | null>`MAX(${erpCheckins.occurred_at})` })
    .from(erpCheckins);
  const stored = rows[0]?.max;
  if (stored) return new Date(stored);
  // Sem checkins ainda: lookback configurável via env (default 24h).
  // I1 (review 2026-05-13): antes era hardcoded 1h, gap problemático em
  // greenfield deploy se ERP tem histórico recente que vale ingerir.
  const env = getEnv();
  const lookbackMs = env.ERP_CHECKINS_INITIAL_LOOKBACK_HOURS * 3600_000;
  const fallback = new Date(Date.now() - lookbackMs);
  logger.warn(
    {
      lookback_hours: env.ERP_CHECKINS_INITIAL_LOOKBACK_HOURS,
      fallback_cursor: fallback.toISOString(),
    },
    "erp_checkins cache vazio — usando lookback inicial (configurável via ERP_CHECKINS_INITIAL_LOOKBACK_HOURS)",
  );
  return fallback;
}

export async function pollCheckins(): Promise<{ fetched: number; new_: number }> {
  if (!cursor) cursor = await getInitialCursor();
  const rows = await fetchErpCheckinsSince(cursor);
  let new_ = 0;
  let upsertFailures = 0;

  for (const row of rows) {
    const erpId = String(row.id);
    const occurredAt = new Date(row.occurred_at);

    const existing = await erpRepo.findCheckinByErpId(erpId);
    if (!existing) {
      try {
        await erpRepo.upsertCheckin({
          erp_id: erpId,
          erp_client_id: String(row.client_id),
          event_type: row.event_type,
          occurred_at: occurredAt,
          metadata: row.metadata ? safeJsonParse(row.metadata) : {},
        });
        new_ += 1;
      } catch (err) {
        upsertFailures += 1;
        logger.warn(
          { err, erp_id: erpId, occurred_at: occurredAt.toISOString() },
          "checkin upsert failed — cursor não avança, próxima rodada tenta de novo",
        );
        // CRITICAL: NÃO avança cursor pra esse row. Próximo poll re-fetcha.
        continue;
      }
    }

    // Cursor avança SE: (a) row já existia (skipped — protege contra re-fetch
    // eterno) OR (b) upsert teve sucesso.
    if (!cursor || occurredAt > cursor) cursor = occurredAt;
  }

  if (upsertFailures > 0) {
    logger.warn(
      { upsert_failures: upsertFailures, fetched: rows.length },
      "poll completed with errors",
    );
  } else {
    logger.info({ fetched: rows.length, new_ }, "checkins poll complete");
  }
  return { fetched: rows.length, new_ };
}

function safeJsonParse(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Reset interno só para testes — usar em beforeEach. */
export function _resetCursor(): void {
  cursor = null;
}
