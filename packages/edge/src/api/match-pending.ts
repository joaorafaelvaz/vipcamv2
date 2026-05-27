import type { MatchPendingEnriched } from "@vipcam/shared";
import { and, asc, between, eq, inArray, isNull } from "drizzle-orm";
import { getEnv } from "../config/env.js";
import { computeWindow } from "../match-temp/window.js";
import { getDb } from "../persistence/db.js";
import { matchAttemptsRepo } from "../persistence/repositories/index.js";
import { detections } from "../persistence/schema/detections.js";
import { erpCheckins, erpClients } from "../persistence/schema/erp-cache.js";
import { persons } from "../persistence/schema/persons.js";

type PersonType = "client" | "employee" | "anonymous";
const VALID_PERSON_TYPES = new Set<PersonType>(["client", "employee", "anonymous"]);

/**
 * Onda 9-A: valida snapshot.person_type contra o enum conhecido. Snapshot é
 * JSONB livre — typeof === "string" não basta (deixa passar valores futuros
 * como "manager" ou lixo corrompido). Retorna null se inválido para o caller
 * cair no default "anonymous".
 */
function snapshotPersonType(snap: Record<string, unknown> | null): PersonType | null {
  if (snap && typeof snap.person_type === "string" && VALID_PERSON_TYPES.has(snap.person_type as PersonType)) {
    return snap.person_type as PersonType;
  }
  return null;
}

// Onda 9-A: alias do campo do shared type p/ usar na construção do mapper.
// `NonNullable` descarta o `| null` da union opcional (queremos o shape
// concreto pra montar; o "null" é representado pela ausência via spread
// condicional embaixo).
type PreviousPerson = NonNullable<MatchPendingEnriched["previous_person"]>;

/**
 * Lista match_attempts ambíguos enriquecidos com info do checkin + candidatas.
 *
 * D1 (Onda 4): antes este código emitia UMA query de detections POR match
 * (N+1). Agora faz UMA query única no range-união de todas as janelas e
 * atribui candidatas a cada match em memória filtrando pela janela específica
 * daquele checkin. Mesmo padrão de sessionsRepo.listByPerson (1 query +
 * agrupamento em memória). Interface pública MatchPendingEnriched inalterada.
 */
export async function listPendingEnriched(limit: number): Promise<MatchPendingEnriched[]> {
  const db = getDb();
  const env = getEnv();
  const attempts = await matchAttemptsRepo.findPending(limit);
  if (attempts.length === 0) return [];

  const checkinIds = attempts.map((a) => a.erp_checkin_id).filter((x): x is string => x !== null);
  const checkinRows =
    checkinIds.length > 0
      ? await db
          .select({
            erp_id: erpCheckins.erp_id,
            erp_client_id: erpCheckins.erp_client_id,
            occurred_at: erpCheckins.occurred_at,
            event_type: erpCheckins.event_type,
            client_name: erpClients.name,
            client_phone: erpClients.phone,
            person_id: persons.id,
          })
          .from(erpCheckins)
          .leftJoin(erpClients, eq(erpCheckins.erp_client_id, erpClients.erp_id))
          .leftJoin(persons, eq(persons.erp_client_id, erpCheckins.erp_client_id))
          .where(inArray(erpCheckins.erp_id, checkinIds))
      : [];
  const checkinsById = new Map(checkinRows.map((c) => [c.erp_id, c]));

  // Onda 9-A: lookup paralelo de prev_persons (W LIVE) pros attempts divergent
  // ambiguous (previous_person_id != null). Approach: query separada em vez de
  // aliasedTable+JOIN no checkin query — preserva pattern Onda 4 D1
  // (1 query por entidade, agrupamento em memória) e evita restructurar joins.
  // Fallback pra snapshot quando LIVE row missing (W já deletado/hard-merged).
  const prevIds = attempts.map((a) => a.previous_person_id).filter((x): x is string => x !== null);
  const prevPersonRows =
    prevIds.length > 0
      ? await db
          .select({
            id: persons.id,
            display_name: persons.display_name,
            person_type: persons.person_type,
            thumbnail_path: persons.thumbnail_path,
          })
          .from(persons)
          .where(inArray(persons.id, prevIds))
      : [];
  const prevPersonsById = new Map(prevPersonRows.map((p) => [p.id, p]));

  type Resolved = {
    attempt: (typeof attempts)[number];
    checkin: NonNullable<ReturnType<typeof checkinsById.get>>;
    window: { start: Date; end: Date };
  };
  const resolved: Resolved[] = [];
  for (const a of attempts) {
    if (!a.erp_checkin_id) continue;
    const checkin = checkinsById.get(a.erp_checkin_id);
    if (!checkin) continue;
    const window = computeWindow(checkin.occurred_at, env.MATCH_WINDOW_SECONDS);
    resolved.push({ attempt: a, checkin, window });
  }
  if (resolved.length === 0) return [];

  // Range-união de todas as janelas (resolved é não-vazio — guard acima).
  const unionStart = new Date(Math.min(...resolved.map((r) => r.window.start.getTime())));
  const unionEnd = new Date(Math.max(...resolved.map((r) => r.window.end.getTime())));

  const allDet = await db
    .select({
      id: detections.id,
      detected_at: detections.detected_at,
      snapshot_path: detections.snapshot_path,
      face_attrs: detections.face_attrs,
      dominant_emotion: detections.dominant_emotion,
      emotion_confidence: detections.emotion_confidence,
      session_id: detections.session_id,
      camera_id: detections.camera_id,
    })
    .from(detections)
    .where(and(isNull(detections.person_id), between(detections.detected_at, unionStart, unionEnd)))
    .orderBy(asc(detections.detected_at));

  return resolved.map(({ attempt: a, checkin, window }) => {
    const candidatesDet = allDet.filter(
      (d) => d.detected_at >= window.start && d.detected_at <= window.end,
    );
    // Onda 9-A: previous_person populado em divergent ambiguous. Prefere LIVE
    // (prevPersonsById) sobre snapshot (previous_person_snapshot) — snapshot só
    // entra em cena se W já não existe (hard-merge pós-creation do attempt).
    let previousPerson: PreviousPerson | undefined;
    if (a.previous_person_id !== null) {
      const live = prevPersonsById.get(a.previous_person_id);
      const snap = a.previous_person_snapshot as Record<string, unknown> | null;
      previousPerson = {
        id: a.previous_person_id,
        display_name:
          live?.display_name ?? (typeof snap?.display_name === "string" ? snap.display_name : null),
        person_type: live?.person_type ?? snapshotPersonType(snap) ?? "anonymous",
        thumbnail_path:
          live?.thumbnail_path ??
          (typeof snap?.thumbnail_path === "string" ? snap.thumbnail_path : null),
      };
    }
    return {
      match_attempt_id: a.id,
      decided_at: a.decided_at.toISOString(),
      notes: a.notes,
      checkin: {
        erp_id: checkin.erp_id,
        client_name: checkin.client_name,
        client_phone: checkin.client_phone,
        erp_client_id: checkin.erp_client_id,
        person_id: checkin.person_id,
        occurred_at: checkin.occurred_at.toISOString(),
        event_type: checkin.event_type,
      },
      candidates: candidatesDet.map((d) => ({
        id: d.id,
        detected_at: d.detected_at.toISOString(),
        snapshot_path: d.snapshot_path,
        face_attrs: d.face_attrs as Record<string, unknown>,
        dominant_emotion: d.dominant_emotion,
        emotion_confidence: d.emotion_confidence,
        session_id: d.session_id,
        camera_id: d.camera_id,
      })),
      ...(previousPerson !== undefined ? { previous_person: previousPerson } : {}),
    };
  });
}
