import { sql } from "drizzle-orm";
import { logger } from "../obs/logger.js";
import { getDb } from "../persistence/db.js";
import { erpRepo } from "../persistence/repositories/index.js";
import { erpCheckins } from "../persistence/schema/erp-cache.js";
import { fetchErpCheckinsSince } from "./queries.js";

/**
 * Cursor in-memory: maior occurred_at já visto. Reconciliado no boot via
 * MAX(occurred_at) do cache local — sobrevive a restart do edge.
 *
 * INVARIANTE CRÍTICA: cursor avança SEMPRE durante o poll (mesmo pra checkins
 * já vistos). Sem isso, query 'since cursor' devolveria os mesmos rows
 * indefinidamente, causando re-fetch eterno e loop quente.
 */
let cursor: Date | null = null;

async function getInitialCursor(): Promise<Date> {
  const rows = await getDb()
    .select({ max: sql<Date | null>`MAX(${erpCheckins.occurred_at})` })
    .from(erpCheckins);
  const stored = rows[0]?.max;
  if (stored) return new Date(stored);
  // Sem checkins ainda: começa 1h atrás (evita inundar com histórico antigo)
  return new Date(Date.now() - 3600_000);
}

export async function pollCheckins(): Promise<{ fetched: number; new_: number }> {
  if (!cursor) cursor = await getInitialCursor();
  const rows = await fetchErpCheckinsSince(cursor);
  let new_ = 0;

  for (const row of rows) {
    const erpId = String(row.id);
    const occurredAt = new Date(row.occurred_at);

    // Cursor avança ANTES de checar duplicata — protege contra re-fetch eterno
    // se a query devolver um row que já vimos (mesmo erp_id).
    if (!cursor || occurredAt > cursor) cursor = occurredAt;

    const existing = await erpRepo.findCheckinByErpId(erpId);
    if (existing) continue;

    await erpRepo.upsertCheckin({
      erp_id: erpId,
      erp_client_id: String(row.client_id),
      event_type: row.event_type,
      occurred_at: occurredAt,
      metadata: row.metadata ? safeJsonParse(row.metadata) : {},
    });
    new_ += 1;
  }

  logger.info({ fetched: rows.length, new_ }, "checkins poll complete");
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
