import { eq, sql } from "drizzle-orm";
import { getEnv } from "../config/env.js";
import { logger } from "../obs/logger.js";
import { getDb } from "../persistence/db.js";
import { detectionsRepo, erpRepo, personsRepo } from "../persistence/repositories/index.js";
import { detections } from "../persistence/schema/detections.js";
import { type ErpCheckin, erpCheckins, erpClients } from "../persistence/schema/erp-cache.js";
import { matchAttempts } from "../persistence/schema/match-attempts.js";
import { type Person, persons } from "../persistence/schema/persons.js";
import { sessions } from "../persistence/schema/sessions.js";
import { type CheckinDecision, decideCheckinMatch } from "./candidates.js";
import { computeWindow } from "./window.js";

/**
 * Onda 9-D — resolução do match-temporal por checkin (substitui o laço
 * Pass-2-por-detecção da Onda 9-A). Uma DECISÃO ÚNICA por checkin, sobre os
 * candidatos distintos na janela ±N seg (vide candidates.ts):
 *
 * - **B1 (colapsar):** no máximo 1 attempt por (checkin, candidate person) —
 *   agrupa detecções por person_id (≠ 1 por detecção, que inflava a fila).
 * - **B2 (excluir staff/outros):** funcionários, outros clientes, e anônimos
 *   "onipresentes" (isStaffLike) são removidos do conjunto de candidatos.
 * - **B3 (auto-resolver):** exatamente 1 candidato específico → auto-resolve
 *   (anônimo → mergeInto em Y; ou NULL → link clássico). ≥2 → ambíguos
 *   colapsados (revisão manual). 0 → rejected.
 *
 * Idempotente: skip se já tem processed_at; re-process após merge cai em
 * convergente (detecção já pertence a Y) → no-op.
 *
 * NOTA `mergeInto`: abre a própria transação (FOR UPDATE), então o caso
 * auto_merge_anon roda FORA da tx de attempts (espelha resolveDivergent).
 */
export async function processCheckin(checkin: ErpCheckin): Promise<void> {
  if (checkin.processed_at) return;
  const env = getEnv();
  const window = computeWindow(checkin.occurred_at, env.MATCH_WINDOW_SECONDS);

  const all = await detectionsRepo.findInWindow(window.start, window.end);

  // Bootstrap do cliente Y (find-or-create). Sequencial no scheduler (for-loop),
  // sem concorrência → sem tx aqui; precisa estar committed antes do mergeInto.
  const candidatePerson = await getOrCreateClientPerson(checkin);

  // B2: identifica anônimos "staff-like" (onipresentes) entre os candidatos.
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
    candidatePersonId: candidatePerson.id,
    detections: all.map((d) => ({
      id: d.id,
      person_id: d.person_id,
      person_type: d.person_type,
      session_id: d.session_id,
    })),
    staffPersonIds,
  });

  // B3 auto_merge_anon: mergeInto gerencia a própria transação (FOR UPDATE) — não
  // aninhar. Faz o merge, depois registra o attempt + processed_at numa tx curta.
  if (decision.kind === "auto_merge_anon") {
    try {
      await personsRepo.mergeInto(decision.anonPersonId, candidatePerson.id, "system");
    } catch (err) {
      // Race: anônimo já foi merged/deletado entre o read e agora. Não seta
      // processed_at → próxima rodada reprocessa (cairá em convergente, no-op).
      if (err instanceof Error && /not found/i.test(err.message)) {
        logger.warn(
          { checkin: checkin.erp_id, anon: decision.anonPersonId, err: err.message },
          "auto_merge_anon race — reprocessará no próximo poll",
        );
        return;
      }
      throw err;
    }
    await getDb().transaction(async (tx) => {
      // previous_person_id NULL: o anônimo foi absorvido em Y (deletado pelo
      // mergeInto) — gravar o id daria FK dangling. O person_merge_audit já tem
      // o detalhe; o id do anônimo vai nas notes p/ auditoria.
      await tx.insert(matchAttempts).values({
        detection_id: decision.representativeDetectionId,
        erp_checkin_id: checkin.erp_id,
        decision: "auto_matched",
        decided_by: "system",
        notes: `auto-merged anon ${decision.anonPersonId} → ${candidatePerson.id}`,
      });
      await markProcessed(tx, checkin.erp_id);
    });
    logDecision(checkin, decision, all.length);
    return;
  }

  await getDb().transaction(async (tx) => {
    switch (decision.kind) {
      case "convergent":
      case "rejected":
        break; // no-op (só marca processed)
      case "auto_link_null": {
        await tx.insert(matchAttempts).values({
          detection_id: decision.detectionId,
          erp_checkin_id: checkin.erp_id,
          decision: "auto_matched",
          decided_by: "system",
        });
        await tx
          .update(detections)
          .set({ person_id: candidatePerson.id })
          .where(eq(detections.id, decision.detectionId));
        if (decision.sessionId) {
          await tx
            .update(sessions)
            .set({ person_id: candidatePerson.id, linked_erp_checkin_id: checkin.erp_id })
            .where(eq(sessions.id, decision.sessionId));
        }
        break;
      }
      case "ambiguous": {
        // 1 attempt divergente por anônimo distinto (colapsado — não por detecção).
        for (const c of decision.anonCandidates) {
          const [prev] = await tx.select().from(persons).where(eq(persons.id, c.personId)).limit(1);
          if (!prev) {
            logger.warn(
              {
                detection_id: c.detectionId,
                dangling_person_id: c.personId,
                checkin_id: checkin.erp_id,
              },
              "candidate person sumiu entre read e write — pulando attempt",
            );
            continue;
          }
          await tx.insert(matchAttempts).values({
            detection_id: c.detectionId,
            erp_checkin_id: checkin.erp_id,
            decision: "ambiguous",
            decided_by: "system",
            previous_person_id: c.personId,
            previous_person_snapshot: prev as unknown as Record<string, unknown>,
          });
        }
        // Detections NULL na janela (clássico): 1 attempt agregado, sem detection
        // fixa (UI escolhe na revisão).
        if (decision.nullDetectionCount > 0) {
          await tx.insert(matchAttempts).values({
            erp_checkin_id: checkin.erp_id,
            decision: "ambiguous",
            decided_by: "system",
            notes: `${decision.nullDetectionCount} null candidates`,
          });
        }
        break;
      }
    }
    await markProcessed(tx, checkin.erp_id);
  });
  logDecision(checkin, decision, all.length);
}

/** Find-or-create da Person do cliente Y (person_type=client, erp_client_id). */
async function getOrCreateClientPerson(checkin: ErpCheckin): Promise<Person> {
  const existing = await personsRepo.findByErpClientId(checkin.erp_client_id);
  if (existing) return existing;
  const [erpClient] = await getDb()
    .select()
    .from(erpClients)
    .where(eq(erpClients.erp_id, checkin.erp_client_id))
    .limit(1);
  return personsRepo.create({
    person_type: "client",
    display_name: erpClient?.name ?? "Cliente",
    erp_client_id: checkin.erp_client_id,
  });
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

async function markProcessed(tx: Tx, erpId: string): Promise<void> {
  await tx
    .update(erpCheckins)
    .set({ processed_at: sql`now()` })
    .where(eq(erpCheckins.erp_id, erpId));
}

function logDecision(checkin: ErpCheckin, decision: CheckinDecision, inWindow: number): void {
  logger.info(
    { checkin: checkin.erp_id, decision: decision.kind, in_window: inWindow },
    "match temporal decision (9-D)",
  );
}

/**
 * Loop: pega N checkins não-processados (ordenados por occurred_at) e
 * processa cada um. Falha em 1 não bloqueia os outros.
 */
export async function processAllPendingCheckins(limit = 100): Promise<number> {
  const pending = await erpRepo.findUnprocessedCheckinsBefore(new Date(), limit);
  for (const c of pending) {
    try {
      await processCheckin(c);
    } catch (err) {
      logger.error({ err, checkin_id: c.erp_id }, "checkin processing failed");
    }
  }
  return pending.length;
}
