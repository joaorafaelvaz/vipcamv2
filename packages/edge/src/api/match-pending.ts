import type { MatchPendingEnriched } from "@vipcam/shared";
import { and, asc, between, eq, inArray, isNull } from "drizzle-orm";
import { getEnv } from "../config/env.js";
import { computeWindow } from "../match-temp/window.js";
import { getDb } from "../persistence/db.js";
import { matchAttemptsRepo } from "../persistence/repositories/index.js";
import { detections } from "../persistence/schema/detections.js";
import { erpCheckins, erpClients } from "../persistence/schema/erp-cache.js";
import { persons } from "../persistence/schema/persons.js";

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

  const checkinIds = attempts
    .map((a) => a.erp_checkin_id)
    .filter((x): x is string => x !== null);
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

  let unionStart = resolved[0]!.window.start;
  let unionEnd = resolved[0]!.window.end;
  for (const r of resolved) {
    if (r.window.start < unionStart) unionStart = r.window.start;
    if (r.window.end > unionEnd) unionEnd = r.window.end;
  }

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
    .where(
      and(
        isNull(detections.person_id),
        between(detections.detected_at, unionStart, unionEnd),
      ),
    )
    .orderBy(asc(detections.detected_at));

  return resolved.map(({ attempt: a, checkin, window }) => {
    const candidatesDet = allDet.filter(
      (d) => d.detected_at >= window.start && d.detected_at <= window.end,
    );
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
    };
  });
}
