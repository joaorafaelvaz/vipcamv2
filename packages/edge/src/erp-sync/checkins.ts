import { getEnv } from "../config/env.js";
import { logger } from "../obs/logger.js";
import { erpRepo } from "../persistence/repositories/index.js";
import type { NewErpCheckin } from "../persistence/schema/erp-cache.js";
import { fetchErpCheckinsSince } from "./queries.js";

/** Início da janela deslizante: now − lookbackHours. Pura (Onda 9-C). */
export function computeSince(now: Date, lookbackHours: number): Date {
  return new Date(now.getTime() - lookbackHours * 3_600_000);
}

export interface PollCheckinsOptions {
  /** Clock injetável (testes). Default: () => new Date(). */
  now?: () => Date;
}

/**
 * Onda 9-C — janela deslizante (substitui o cursor monotônico).
 *
 * `agendas.data` (horário do slot, usado como occurred_at) NÃO é monotônico com o
 * instante em que `checkin` vira 1 (atrasados dão check-in p/ slot passado;
 * adiantados, p/ slot futuro). Um cursor high-water-mark perderia esses
 * permanentemente. Em vez disso, cada poll re-escaneia `data >= now − LOOKBACK`
 * e deduplica por `erp_id` (insert batch ON CONFLICT DO NOTHING). Restart-safe
 * por construção; forward-only (só olha ~1 dia pra trás).
 *
 * Dedup é a fonte de verdade da idempotência — sem estado in-memory entre polls.
 */
export async function pollCheckins(
  opts: PollCheckinsOptions = {},
): Promise<{ fetched: number; new_: number }> {
  const env = getEnv();
  const now = (opts.now ?? (() => new Date()))();
  const since = computeSince(now, env.ERP_CHECKINS_LOOKBACK_HOURS);

  const rows = await fetchErpCheckinsSince(since);

  const toInsert: NewErpCheckin[] = [];
  let skippedNullClient = 0;
  for (const row of rows) {
    // Defensivo: erp_client_id é NOT NULL no cache; um row sem cliente derrubaria
    // o INSERT batch inteiro (atômico). A query já filtra `cliente IS NOT NULL`,
    // mas guardamos aqui também. (checkin=1 sempre tem cliente em operação normal.)
    if (row.client_id === null || row.client_id === undefined) {
      skippedNullClient += 1;
      continue;
    }
    toInsert.push({
      erp_id: String(row.id),
      erp_client_id: String(row.client_id),
      event_type: row.event_type,
      occurred_at: new Date(row.occurred_at),
      metadata: row.metadata ? safeJsonParse(row.metadata) : {},
    });
  }

  let new_ = 0;
  try {
    new_ = await erpRepo.insertCheckinsIgnore(toInsert);
  } catch (err) {
    // Batch é atômico — se 1 row viola constraint, nada entra nesta rodada.
    // Próximo poll re-escaneia a mesma janela e re-tenta (sem perda permanente).
    logger.warn(
      { err, fetched: rows.length, to_insert: toInsert.length },
      "checkins insert batch failed — próxima rodada re-tenta (janela ainda cobre)",
    );
    return { fetched: rows.length, new_: 0 };
  }

  if (skippedNullClient > 0) {
    logger.warn(
      { skipped_null_client: skippedNullClient, fetched: rows.length },
      "checkins poll: rows sem cliente puladas",
    );
  }
  logger.info({ fetched: rows.length, new_, since: since.toISOString() }, "checkins poll complete");
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
