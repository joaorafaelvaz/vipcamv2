/**
 * Decisão pura do match temporal:
 *
 * Política conservadora — nunca atribui detection a checkin sob ambiguidade.
 * Quando há múltiplas candidatas, requer revisão manual via UI (Onda 3).
 *
 * - 0 candidatas: rejected → log + métrica (talvez janela curta demais?)
 * - 1 candidata: auto_matched (única detection anônima na janela)
 * - >1 candidatas: ambiguous (várias pessoas chegaram juntas, não dá pra
 *   inferir qual é o checkin sem mais contexto)
 *
 * Função pura — não toca DB. Caller (orchestrator) buscou as candidatas.
 */
export type MatchDecisionType = "auto_matched" | "ambiguous" | "rejected";

export interface MatchDecision {
  decision: MatchDecisionType;
  chosen_detection_id: string | null;
}

export function decideMatch(anonymousDetectionIds: readonly string[]): MatchDecision {
  if (anonymousDetectionIds.length === 0) {
    return { decision: "rejected", chosen_detection_id: null };
  }
  if (anonymousDetectionIds.length === 1) {
    const chosen = anonymousDetectionIds[0];
    if (!chosen) {
      // Defensivo — TS sabe que length === 1 implica index 0 existe, mas
      // exactOptionalPropertyTypes complains. Nunca deveria executar.
      return { decision: "rejected", chosen_detection_id: null };
    }
    return { decision: "auto_matched", chosen_detection_id: chosen };
  }
  return { decision: "ambiguous", chosen_detection_id: null };
}
