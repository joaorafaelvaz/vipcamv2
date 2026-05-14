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
 * Para um checkin não-processado, busca face anônimas dentro da janela ±N seg
 * e tenta vincular via decideMatch (matcher puro).
 *
 * Outcomes:
 * - rejected (0 candidatas): registra match_attempt, marca processed_at
 * - ambiguous (>1 candidatas): registra match_attempt c/ count, marca processed
 *   (UI de revisão manual em Onda 3)
 * - auto_matched (1 candidata):
 *   - cria/reusa Person (person_type=client) vinculada a erp_client_id
 *   - linkToPerson na detection + session (com linked_erp_checkin_id)
 *   - registra match_attempt c/ chosen_detection_id, marca processed
 *
 * Idempotente: skip se já tem processed_at.
 *
 * **C1 (review 2026-05-13):** todos os WRITES estão dentro de `db.transaction`
 * pra garantir all-or-nothing. Sem isso, partial failure (ex: linkToPerson
 * de session falha após criar match_attempt) deixava match_attempt órfão E
 * checkin unprocessed → próxima rodada criava match_attempt duplicado.
 *
 * Reads (findAnonymousInWindow) ficam fora — não há requisito de SERIALIZABLE
 * isolation entre read e write; vale aceitar que detection nova pode aparecer
 * entre read e write (bug benigno: pior caso é match_attempt c/ count desatualizado).
 */
export async function processCheckin(checkin: ErpCheckin): Promise<void> {
  if (checkin.processed_at) return;
  const env = getEnv();
  const window = computeWindow(checkin.occurred_at, env.MATCH_WINDOW_SECONDS);

  const anonymousDetections = await detectionsRepo.findAnonymousInWindow(window.start, window.end);
  const decision = decideMatch(anonymousDetections.map((d) => d.id));

  await getDb().transaction(async (tx) => {
    // 1. Registra match_attempt
    const attemptValues: typeof matchAttempts.$inferInsert = {
      erp_checkin_id: checkin.erp_id,
      decision: decision.decision,
      decided_by: "system",
    };
    if (decision.chosen_detection_id) attemptValues.detection_id = decision.chosen_detection_id;
    if (decision.decision === "ambiguous") {
      attemptValues.notes = `${anonymousDetections.length} candidates`;
    }
    await tx.insert(matchAttempts).values(attemptValues);

    // 2. Auto-match: cria/reusa Person + linka detection/session
    if (decision.decision === "auto_matched" && decision.chosen_detection_id) {
      const det = anonymousDetections.find((d) => d.id === decision.chosen_detection_id);
      if (!det) {
        // Inalcançável: id veio da própria lista. Throw aborta a transação.
        throw new Error(
          `auto_matched chose ${decision.chosen_detection_id} but detection not in list`,
        );
      }

      const personRows = await tx
        .select()
        .from(persons)
        .where(eq(persons.erp_client_id, checkin.erp_client_id))
        .limit(1);
      let person = personRows[0];

      if (!person) {
        const clientRows = await tx
          .select()
          .from(erpClients)
          .where(eq(erpClients.erp_id, checkin.erp_client_id))
          .limit(1);
        const erpClient = clientRows[0];
        const [created] = await tx
          .insert(persons)
          .values({
            person_type: "client",
            display_name: erpClient?.name ?? "Cliente",
            erp_client_id: checkin.erp_client_id,
          })
          .returning();
        if (!created) throw new Error("persons insert returned no row");
        person = created;
      }

      await tx.update(detections).set({ person_id: person.id }).where(eq(detections.id, det.id));
      if (det.session_id) {
        await tx
          .update(sessions)
          .set({ person_id: person.id, linked_erp_checkin_id: checkin.erp_id })
          .where(eq(sessions.id, det.session_id));
      }
      logger.info(
        { person_id: person.id, detection_id: det.id, checkin_id: checkin.erp_id },
        "auto-matched anonymous detection to ERP client",
      );
    } else {
      logger.info(
        {
          decision: decision.decision,
          candidates: anonymousDetections.length,
          checkin: checkin.erp_id,
        },
        "match temporal decision",
      );
    }

    // 3. Marca checkin processed (ÚLTIMA write — se falhar, transação inteira reverte)
    await tx
      .update(erpCheckins)
      .set({ processed_at: sql`now()` })
      .where(eq(erpCheckins.erp_id, checkin.erp_id));
  });
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
