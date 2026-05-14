import { and, between, eq, isNull, sql } from "drizzle-orm";
import { getEnv } from "../config/env.js";
import { logger } from "../obs/logger.js";
import { getDb } from "../persistence/db.js";
import { detections } from "../persistence/schema/detections.js";
import { erpCheckins } from "../persistence/schema/erp-cache.js";
import { matchAttempts } from "../persistence/schema/match-attempts.js";
import { persons } from "../persistence/schema/persons.js";
import { sessions } from "../persistence/schema/sessions.js";
import { computeWindow } from "./window.js";

/**
 * Códigos de erro tipados para a UI traduzir em HTTP status:
 * - not_found (404): match_attempt não existe
 * - already_resolved (409): match já tem decision != 'ambiguous' (resolvido por system ou outro user)
 * - detection_outside_window (400): chosen_detection_id não está dentro de ±MATCH_WINDOW_SECONDS do checkin
 * - person_client_mismatch (400): person.erp_client_id existe e é ≠ checkin.erp_client_id
 *   (impede vincular Person de OUTRO cliente ao checkin atual)
 * - checkin_not_found (500): match_attempt referencia erp_checkin_id que sumiu (data corruption)
 */
export type ResolveErrorCode =
  | "not_found"
  | "already_resolved"
  | "detection_outside_window"
  | "person_client_mismatch"
  | "checkin_not_found";

export class ResolveError extends Error {
  constructor(
    public readonly code: ResolveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ResolveError";
  }
}

/**
 * Revisão manual de match_attempt ambíguo: vincula a detection escolhida pelo
 * operador à Person escolhida (criando os links em match_attempts, detections,
 * sessions atomicamente).
 *
 * **C2 (review 2026-05-13):** todos os WRITES dentro de db.transaction
 * (rollback se qualquer um falhar — antes ficavam soltos no server.ts).
 *
 * Validações semânticas (C2):
 *  1. match_attempt existe (else 404)
 *  2. decision === 'ambiguous' (else 409 — não permite re-resolve de já decidido)
 *  3. chosen_detection_id está em findAnonymousInWindow do checkin (else 400)
 *  4. chosen_person.erp_client_id (se setado) === checkin.erp_client_id (else 400)
 *
 * Sem essas validações, frontend buggy/malicioso podia vincular qualquer
 * detection a qualquer Person, corrompendo o histórico de visitas.
 */
export async function resolveAmbiguous(
  matchAttemptId: string,
  chosenDetectionId: string,
  chosenPersonId: string,
): Promise<void> {
  const db = getDb();

  // Reads de validação (fora da transaction — não há requisito de isolamento entre read e write)
  const [attempt] = await db
    .select()
    .from(matchAttempts)
    .where(eq(matchAttempts.id, matchAttemptId))
    .limit(1);
  if (!attempt) {
    throw new ResolveError("not_found", `match_attempt ${matchAttemptId} not found`);
  }
  if (attempt.decision !== "ambiguous") {
    throw new ResolveError(
      "already_resolved",
      `match_attempt ${matchAttemptId} has decision=${attempt.decision} (only ambiguous can be resolved)`,
    );
  }
  if (!attempt.erp_checkin_id) {
    throw new ResolveError(
      "checkin_not_found",
      `match_attempt ${matchAttemptId} has null erp_checkin_id (data corruption)`,
    );
  }

  const [checkin] = await db
    .select()
    .from(erpCheckins)
    .where(eq(erpCheckins.erp_id, attempt.erp_checkin_id))
    .limit(1);
  if (!checkin) {
    throw new ResolveError(
      "checkin_not_found",
      `match_attempt ${matchAttemptId} references missing checkin ${attempt.erp_checkin_id}`,
    );
  }

  // Validação 3: detection deve estar na window temporal do checkin
  const env = getEnv();
  const window = computeWindow(checkin.occurred_at, env.MATCH_WINDOW_SECONDS);
  const inWindow = await db
    .select({ id: detections.id, session_id: detections.session_id })
    .from(detections)
    .where(
      and(
        eq(detections.id, chosenDetectionId),
        between(detections.detected_at, window.start, window.end),
      ),
    )
    .limit(1);
  const det = inWindow[0];
  if (!det) {
    // Pode ser: detection não existe OU detected_at fora da window. Mensagem genérica.
    throw new ResolveError(
      "detection_outside_window",
      `detection ${chosenDetectionId} not found within ±${env.MATCH_WINDOW_SECONDS}s of checkin ${checkin.erp_id}`,
    );
  }

  // Validação 4: person.erp_client_id (se já vinculado) deve match checkin.erp_client_id
  // Aceita Person sem erp_client_id (anonymous virando named) ou Person já do mesmo cliente.
  const [person] = await db.select().from(persons).where(eq(persons.id, chosenPersonId)).limit(1);
  if (!person) {
    // Se person não existe, FK na linkToPerson vai falhar com 500. Reportamos antes.
    throw new ResolveError("not_found", `person ${chosenPersonId} not found`);
  }
  if (person.erp_client_id && person.erp_client_id !== checkin.erp_client_id) {
    throw new ResolveError(
      "person_client_mismatch",
      `person ${chosenPersonId} belongs to erp_client ${person.erp_client_id}, but checkin is for ${checkin.erp_client_id}`,
    );
  }

  // Apply: writes atômicos
  await db.transaction(async (tx) => {
    await tx
      .update(matchAttempts)
      .set({
        decision: "auto_matched",
        detection_id: chosenDetectionId,
        decided_by: "user",
        decided_at: sql`now()`,
      })
      .where(eq(matchAttempts.id, matchAttemptId));

    await tx
      .update(detections)
      .set({ person_id: chosenPersonId })
      .where(eq(detections.id, chosenDetectionId));

    if (det.session_id) {
      await tx
        .update(sessions)
        .set({ person_id: chosenPersonId, linked_erp_checkin_id: checkin.erp_id })
        .where(eq(sessions.id, det.session_id));
    }

    // Se person ainda não tinha erp_client_id (era 'anonymous'), promover agora
    if (!person.erp_client_id) {
      await tx
        .update(persons)
        .set({ erp_client_id: checkin.erp_client_id, person_type: "client" })
        .where(and(eq(persons.id, chosenPersonId), isNull(persons.erp_client_id)));
    }
  });

  logger.info(
    {
      match_attempt_id: matchAttemptId,
      detection_id: chosenDetectionId,
      person_id: chosenPersonId,
      checkin_id: checkin.erp_id,
    },
    "manual match resolution applied",
  );
}
