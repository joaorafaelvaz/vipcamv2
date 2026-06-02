/**
 * Onda 9-D — backfill da fila do /matches.
 *
 * Re-avalia os checkins que têm match_attempts AMBÍGUOS pendentes (decided_by=
 * 'system') aplicando a lógica nova (colapsar + excluir staff + auto-resolver).
 *
 * Uso (na VPS, com DATABASE_URL no env):
 *   bun scripts/backfill-rematch.ts            # DRY-RUN (default): só reporta
 *   bun scripts/backfill-rematch.ts --apply    # aplica (merges + colapso)
 *
 * DRY-RUN: recomputa a decisão por checkin (read-only) e agrega contadores.
 * APPLY: por checkin, em ordem — reseta processed_at=NULL + apaga os ambíguos
 * antigos (decided_by='system') e re-roda processCheckin (REUSA toda a lógica de
 * escrita; sem duplicação). Idempotente; um checkin que falha não derruba os outros.
 */
import { sql } from "drizzle-orm";
import { getEnv } from "../src/config/env.js";
import { decideCheckinMatch } from "../src/match-temp/candidates.js";
import { processCheckin } from "../src/match-temp/orchestrator.js";
import { computeWindow } from "../src/match-temp/window.js";
import { logger } from "../src/obs/logger.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import { detectionsRepo, erpRepo, personsRepo } from "../src/persistence/repositories/index.js";

const APPLY = process.argv.includes("--apply");

interface Tally {
  checkins: number;
  auto_merge_anon: number;
  auto_link_null: number;
  ambiguous: number;
  convergent: number;
  rejected: number;
  errors: number;
}

async function pendingCheckinIds(): Promise<string[]> {
  const rows = await getDb().execute<{ erp_checkin_id: string }>(sql`
    SELECT DISTINCT erp_checkin_id
    FROM match_attempts
    WHERE decision = 'ambiguous' AND decided_by = 'system' AND erp_checkin_id IS NOT NULL
  `);
  return rows.map((r) => r.erp_checkin_id);
}

async function computeDecisionKind(checkinId: string): Promise<string> {
  const env = getEnv();
  const checkin = await erpRepo.findCheckinByErpId(checkinId);
  if (!checkin) return "missing_checkin";
  const window = computeWindow(checkin.occurred_at, env.MATCH_WINDOW_SECONDS);
  const all = await detectionsRepo.findInWindow(window.start, window.end);
  const candidate = await personsRepo.findByErpClientId(checkin.erp_client_id);

  const anonIds = [
    ...new Set(
      all
        .filter((d) => d.person_type === "anonymous" && d.person_id !== null)
        .map((d) => d.person_id as string),
    ),
  ];
  const staffPersonIds = new Set<string>();
  for (const pid of anonIds) {
    if (await personsRepo.isStaffLike(pid, env.STAFF_LOOKBACK_DAYS, env.STAFF_MIN_ACTIVE_HOURS)) {
      staffPersonIds.add(pid);
    }
  }

  const decision = decideCheckinMatch({
    candidatePersonId: candidate?.id ?? "",
    detections: all.map((d) => ({
      id: d.id,
      person_id: d.person_id,
      person_type: d.person_type,
      session_id: d.session_id,
    })),
    staffPersonIds,
  });
  return decision.kind;
}

/** APPLY: limpa os ambíguos antigos + reseta processed_at, depois re-roda processCheckin. */
async function reprocess(checkinId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM match_attempts
      WHERE erp_checkin_id = ${checkinId} AND decision = 'ambiguous' AND decided_by = 'system'
    `);
    await tx.execute(sql`
      UPDATE erp_checkins SET processed_at = NULL WHERE erp_id = ${checkinId}
    `);
  });
  const checkin = await erpRepo.findCheckinByErpId(checkinId);
  if (checkin) await processCheckin(checkin);
}

async function main(): Promise<void> {
  const ids = await pendingCheckinIds();
  const tally: Tally = {
    checkins: ids.length,
    auto_merge_anon: 0,
    auto_link_null: 0,
    ambiguous: 0,
    convergent: 0,
    rejected: 0,
    errors: 0,
  };

  logger.info(
    { mode: APPLY ? "APPLY" : "DRY-RUN", checkins: ids.length },
    "backfill-rematch start",
  );

  for (const id of ids) {
    try {
      const kind = await computeDecisionKind(id);
      switch (kind) {
        case "auto_merge_anon":
          tally.auto_merge_anon += 1;
          break;
        case "auto_link_null":
          tally.auto_link_null += 1;
          break;
        case "ambiguous":
          tally.ambiguous += 1;
          break;
        case "convergent":
          tally.convergent += 1;
          break;
        case "rejected":
          tally.rejected += 1;
          break;
        // missing_checkin / outros → não contabiliza
      }
      if (APPLY) await reprocess(id);
    } catch (err) {
      tally.errors += 1;
      logger.error({ err, checkin_id: id }, "backfill: checkin falhou");
    }
  }

  // Relatório agregado (stdout — fácil de colar/revisar).
  console.log(JSON.stringify({ mode: APPLY ? "APPLY" : "DRY-RUN", tally }, null, 2));
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error({ err }, "backfill-rematch fatal");
    await closeDb();
    process.exit(1);
  });
