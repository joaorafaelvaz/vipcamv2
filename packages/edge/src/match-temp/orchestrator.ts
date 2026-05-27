import { eq, sql } from "drizzle-orm";
import { getEnv } from "../config/env.js";
import { logger } from "../obs/logger.js";
import { getDb } from "../persistence/db.js";
import { detectionsRepo, erpRepo } from "../persistence/repositories/index.js";
import { detections } from "../persistence/schema/detections.js";
import { type ErpCheckin, erpCheckins, erpClients } from "../persistence/schema/erp-cache.js";
import { matchAttempts } from "../persistence/schema/match-attempts.js";
import { persons } from "../persistence/schema/persons.js";
import { sessions } from "../persistence/schema/sessions.js";
import { decideMatch } from "./matcher.js";
import { computeWindow } from "./window.js";

/**
 * Para um checkin não-processado, processa em DOIS PASSES sobre TODAS as
 * detections na janela ±N seg (não só anônimas):
 *
 * **Pass 1 (clássico — Onda 2/3):** decideMatch sobre detections com
 * person_id IS NULL (anônimas).
 * - rejected (0 anônimas): no-op de WRITE (Pass 2 ainda roda)
 * - ambiguous (>1 anônimas): registra match_attempt c/ count (sem
 *   detection_id, sem previous_person_id — sinal de "caso clássico")
 * - auto_matched (1 anônima):
 *   - cria/reusa Person (person_type=client) vinculada a erp_client_id
 *   - update na detection.person_id + session (com linked_erp_checkin_id)
 *   - registra match_attempt c/ detection_id, decision=auto_matched
 *
 * **Pass 2 (divergent — Onda 9-A novo, §5.1 rows 3-5):** loop sobre
 * detections com person_id != NULL (reid já identificou). Para cada uma:
 * - se person_id == candidatePerson.id (Y do checkin) → NO-OP (row 3,
 *   convergent — reid e ERP concordam)
 * - se person_id != candidatePerson.id (rows 4-5, X anônima ou W cliente
 *   diferente) → registra match_attempt c/ detection_id, decision=ambiguous,
 *   previous_person_id=det.person_id, previous_person_snapshot=row inteira
 *   da person W (denormaliza pra sobreviver a SET NULL caso W seja merged
 *   ou deletado depois). UI de revisão (Onda 9-A) bifurca em "manter X"
 *   vs "trocar pra Y" usando previous_person_id como sinal.
 *
 * Idempotente: skip se já tem processed_at.
 *
 * **C1 (review 2026-05-13):** TODOS os WRITES (Pass 1 + Pass 2 + bootstrap
 * de candidatePerson + processed_at update) ficam dentro de UMA `db.transaction`
 * pra garantir all-or-nothing. Sem isso, partial failure deixava match_attempt
 * órfão E checkin unprocessed → próxima rodada criava match_attempt duplicado.
 * `processed_at` é a ÚLTIMA write — se qualquer Pass falhar, transação
 * inteira reverte e o checkin volta pra fila do próximo poll.
 *
 * Reads (findInWindow) ficam fora — não há requisito de SERIALIZABLE
 * isolation entre read e write; vale aceitar que detection nova pode aparecer
 * entre read e write (bug benigno: pior caso é match_attempt c/ count desatualizado).
 */
export async function processCheckin(checkin: ErpCheckin): Promise<void> {
  if (checkin.processed_at) return;
  const env = getEnv();
  const window = computeWindow(checkin.occurred_at, env.MATCH_WINDOW_SECONDS);

  // Onda 9-A: pega TODAS as detections na window (não só anônimas)
  const allInWindow = await detectionsRepo.findInWindow(window.start, window.end);
  const anonymous = allInWindow.filter((d) => d.person_id === null);
  const identified = allInWindow.filter((d) => d.person_id !== null);

  // Pass 1 clássico (preserva semântica Onda 2/3): decideMatch sobre IDs anônimos
  const classic = decideMatch(anonymous.map((d) => d.id));

  await getDb().transaction(async (tx) => {
    // Bootstrap candidatePerson DENTRO da transaction (preserva atomicity do
    // INSERT persons + linkToPerson). Reusa lookup persons.erp_client_id; se
    // ausente, materializa de erp_clients (mesmo pattern do código pré-Onda 9-A).
    const [existing] = await tx
      .select()
      .from(persons)
      .where(eq(persons.erp_client_id, checkin.erp_client_id))
      .limit(1);

    let candidatePerson = existing ?? null;
    if (!candidatePerson) {
      const [erpClient] = await tx
        .select()
        .from(erpClients)
        .where(eq(erpClients.erp_id, checkin.erp_client_id))
        .limit(1);
      const [created] = await tx
        .insert(persons)
        .values({
          person_type: "client",
          display_name: erpClient?.name ?? "Cliente",
          erp_client_id: checkin.erp_client_id,
        })
        .returning();
      if (!created) throw new Error("persons insert returned no row");
      candidatePerson = created;
    }

    // Pass 1: clássico
    if (classic.decision === "auto_matched" && classic.chosen_detection_id) {
      const det = anonymous.find((d) => d.id === classic.chosen_detection_id);
      if (!det) {
        throw new Error(
          `auto_matched chose ${classic.chosen_detection_id} but detection not in anonymous list`,
        );
      }
      await tx.insert(matchAttempts).values({
        detection_id: classic.chosen_detection_id,
        erp_checkin_id: checkin.erp_id,
        decision: "auto_matched",
        decided_by: "system",
      });
      await tx
        .update(detections)
        .set({ person_id: candidatePerson.id })
        .where(eq(detections.id, classic.chosen_detection_id));
      if (det.session_id) {
        await tx
          .update(sessions)
          .set({ person_id: candidatePerson.id, linked_erp_checkin_id: checkin.erp_id })
          .where(eq(sessions.id, det.session_id));
      }
    } else if (classic.decision === "ambiguous") {
      await tx.insert(matchAttempts).values({
        // ambiguous clássico não fixa detection (UI escolhe na revisão)
        erp_checkin_id: checkin.erp_id,
        decision: "ambiguous",
        decided_by: "system",
        notes: `${anonymous.length} candidates`,
        // previous_person_id default NULL = signal de "caso clássico"
      });
    }
    // 'rejected' clássico (0 anônimas) = no-op de WRITE; Pass 2 abaixo ainda roda.

    // Pass 2: divergent (Onda 9-A novo) — uma linha por detection identificada ≠ Y
    for (const det of identified) {
      if (det.person_id === candidatePerson.id) continue; // Row 3: NO-OP convergent
      // Rows 4-5: ambiguous divergente. Snapshot denormaliza W p/ sobreviver
      // a futuro SET NULL caso W seja merged/deletado depois.
      const [prevPerson] = await tx
        .select()
        .from(persons)
        .where(eq(persons.id, det.person_id as string))
        .limit(1);
      await tx.insert(matchAttempts).values({
        detection_id: det.id,
        erp_checkin_id: checkin.erp_id,
        decision: "ambiguous",
        decided_by: "system",
        previous_person_id: det.person_id,
        previous_person_snapshot: prevPerson as unknown as Record<string, unknown>,
      });
    }

    // Marca checkin processed (ÚLTIMA write — se falhar, transação inteira reverte)
    await tx
      .update(erpCheckins)
      .set({ processed_at: sql`now()` })
      .where(eq(erpCheckins.erp_id, checkin.erp_id));
  });

  logger.info(
    {
      checkin: checkin.erp_id,
      classic_decision: classic.decision,
      anonymous: anonymous.length,
      identified: identified.length,
    },
    "match temporal decision (2-pass)",
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
