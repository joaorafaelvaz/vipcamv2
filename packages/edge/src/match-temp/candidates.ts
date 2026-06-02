/**
 * Onda 9-D — decisão pura do match-temporal por checkin.
 *
 * Classifica os detections da janela ±N seg em torno do checkin do cliente Y e
 * decide a ação. Pura (sem DB) — o caller (orchestrator) resolve person_type via
 * JOIN e calcula staffPersonIds antes de chamar. Veja spec 9-D §4 Part B.
 *
 * Classificação:
 *  - detection ligada a Y               → convergente (match já existe).
 *  - person_type employee               → excluído (funcionário ≠ quem deu checkin).
 *  - person_type client e != Y          → excluído (outro cliente).
 *  - anônimo em staffPersonIds          → excluído (onipresente/staff).
 *  - anônimo (resto)                    → candidato (agrupado por person_id).
 *  - person_id NULL                     → candidato "não-ligado".
 *
 * Decisão (conservadora — auto-merge só com exatamente 1 candidato específico):
 *  - 0 candidatos                       → rejected.
 *  - 1 anônimo distinto, 0 null         → auto_merge_anon (mergeInto anon→Y).
 *  - 0 anônimo, 1 null                  → auto_link_null (link clássico).
 *  - ≥2 candidatos (qualquer mix)       → ambiguous (1 attempt por anônimo + nulls).
 */
export type PersonType = "client" | "employee" | "anonymous";

export interface WindowDetection {
  id: string;
  person_id: string | null;
  /** null sse person_id null (LEFT JOIN persons no findInWindow). */
  person_type: PersonType | null;
  session_id: string | null;
}

export interface DecideInput {
  candidatePersonId: string;
  detections: WindowDetection[];
  staffPersonIds: ReadonlySet<string>;
}

export type CheckinDecision =
  | { kind: "convergent" }
  | { kind: "rejected" }
  | { kind: "auto_merge_anon"; anonPersonId: string; representativeDetectionId: string }
  | { kind: "auto_link_null"; detectionId: string; sessionId: string | null }
  | {
      kind: "ambiguous";
      anonCandidates: Array<{ personId: string; detectionId: string }>;
      nullDetectionCount: number;
    };

export function decideCheckinMatch(input: DecideInput): CheckinDecision {
  const { candidatePersonId, detections, staffPersonIds } = input;

  // Convergente: qualquer detection já ligada a Y satisfaz o checkin.
  if (detections.some((d) => d.person_id === candidatePersonId)) {
    return { kind: "convergent" };
  }

  // Agrupa anônimos NÃO-staff por person_id (preserva a 1ª detection como
  // representante — caller ordena por detected_at asc). Conta nulls.
  const anonByPerson = new Map<string, string>(); // personId -> representativeDetectionId
  let nullDetectionCount = 0;
  let firstNull: { id: string; sessionId: string | null } | null = null;

  for (const d of detections) {
    if (d.person_id === null) {
      nullDetectionCount += 1;
      if (firstNull === null) firstNull = { id: d.id, sessionId: d.session_id };
      continue;
    }
    if (d.person_type === "employee") continue; // funcionário
    if (d.person_type === "client") continue; // outro cliente (Y já tratado acima)
    if (staffPersonIds.has(d.person_id)) continue; // onipresente/staff
    if (!anonByPerson.has(d.person_id)) anonByPerson.set(d.person_id, d.id);
  }

  const anonCount = anonByPerson.size;

  if (anonCount === 0 && nullDetectionCount === 0) {
    return { kind: "rejected" };
  }

  if (anonCount === 1 && nullDetectionCount === 0) {
    const entry = [...anonByPerson.entries()][0];
    // entry sempre existe (anonCount === 1), mas o narrow satisfaz o TS.
    if (entry) {
      return {
        kind: "auto_merge_anon",
        anonPersonId: entry[0],
        representativeDetectionId: entry[1],
      };
    }
  }

  if (anonCount === 0 && nullDetectionCount === 1 && firstNull) {
    return { kind: "auto_link_null", detectionId: firstNull.id, sessionId: firstNull.sessionId };
  }

  return {
    kind: "ambiguous",
    anonCandidates: [...anonByPerson.entries()].map(([personId, detectionId]) => ({
      personId,
      detectionId,
    })),
    nullDetectionCount,
  };
}
