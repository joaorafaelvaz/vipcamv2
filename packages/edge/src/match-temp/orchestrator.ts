import { getEnv } from "../config/env.js";
import { logger } from "../obs/logger.js";
import {
  detectionsRepo,
  erpRepo,
  matchAttemptsRepo,
  personsRepo,
  sessionsRepo,
} from "../persistence/repositories/index.js";
import type { ErpCheckin } from "../persistence/schema/erp-cache.js";
import type { NewMatchAttempt } from "../persistence/schema/match-attempts.js";
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
 */
export async function processCheckin(checkin: ErpCheckin): Promise<void> {
  if (checkin.processed_at) return;
  const env = getEnv();
  const window = computeWindow(checkin.occurred_at, env.MATCH_WINDOW_SECONDS);

  const anonymousDetections = await detectionsRepo.findAnonymousInWindow(window.start, window.end);
  const decision = decideMatch(anonymousDetections.map((d) => d.id));

  // Construct match_attempt respeitando exactOptionalPropertyTypes
  const attempt: NewMatchAttempt = {
    erp_checkin_id: checkin.erp_id,
    decision: decision.decision,
    decided_by: "system",
  };
  if (decision.chosen_detection_id) attempt.detection_id = decision.chosen_detection_id;
  if (decision.decision === "ambiguous") {
    attempt.notes = `${anonymousDetections.length} candidates`;
  }
  await matchAttemptsRepo.create(attempt);

  if (decision.decision === "auto_matched" && decision.chosen_detection_id) {
    const det = anonymousDetections.find((d) => d.id === decision.chosen_detection_id);
    if (!det) {
      // Defensivo — id veio da própria lista, mas TS não sabe
      logger.error({ checkin: checkin.erp_id }, "auto_matched but detection not in list");
    } else {
      // Vincula Person ↔ erp_client (cria se ainda não existe)
      let person = await personsRepo.findByErpClientId(checkin.erp_client_id);
      if (!person) {
        const erpClient = await erpRepo.findClientByErpId(checkin.erp_client_id);
        person = await personsRepo.create({
          person_type: "client",
          display_name: erpClient?.name ?? "Cliente",
          erp_client_id: checkin.erp_client_id,
        });
      }
      await detectionsRepo.linkToPerson(det.id, person.id);
      if (det.session_id) {
        await sessionsRepo.linkToPerson(det.session_id, person.id, checkin.erp_id);
      }
      logger.info(
        { person_id: person.id, detection_id: det.id, checkin_id: checkin.erp_id },
        "auto-matched anonymous detection to ERP client",
      );
    }
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

  await erpRepo.markCheckinProcessed(checkin.erp_id);
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
