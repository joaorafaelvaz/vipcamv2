import type { LiveDetectionEvent } from "@vipcam/shared";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../persistence/db.js";
import { detections } from "../persistence/schema/detections.js";
import { erpClients } from "../persistence/schema/erp-cache.js";
import { persons } from "../persistence/schema/persons.js";

/**
 * Últimas N detecções enriquecidas com a Person correspondente (LEFT JOIN —
 * detecções anônimas vêm com person: null). Substitui o stream SSE do /live
 * por polling autoritativo do DB. (Onda 8.)
 *
 * Espelha o padrão de dashboard.queries.ts (getDb dentro) + listWithFilters
 * do persons.repo.ts (LEFT JOIN persons+erp_clients para sourcing de
 * photo_path/phone). Sem filtros por tipo (inclui anônimos + funcionários +
 * clientes — paridade com SSE). Cap de `limit` é responsabilidade da rota.
 */
export async function recentDetections(limit: number): Promise<LiveDetectionEvent[]> {
  const db = getDb();
  const rows = await db
    .select({
      d_id: detections.id,
      d_detected_at: detections.detected_at,
      d_snapshot_path: detections.snapshot_path,
      d_face_attrs: detections.face_attrs,
      d_dominant_emotion: detections.dominant_emotion,
      d_emotion_confidence: detections.emotion_confidence,
      d_session_id: detections.session_id,
      d_camera_id: detections.camera_id,
      p_id: persons.id,
      p_display_name: persons.display_name,
      p_person_type: persons.person_type,
      // PersonSummary.photo_path = persons.thumbnail_path (apelido — coluna
      // real chama thumbnail_path; ver persons.repo.ts:88-99 listWithFilters)
      p_photo_path: persons.thumbnail_path,
      p_last_seen_at: persons.last_seen_at,
      p_total_visits: persons.total_visits,
      p_erp_client_id: persons.erp_client_id,
      p_erp_employee_id: persons.erp_employee_id,
      // PersonSummary.phone vem de erp_clients (persons não tem phone);
      // LEFT JOIN persons→erp_clients via erp_client_id pode render null.
      p_phone: erpClients.phone,
    })
    .from(detections)
    .leftJoin(persons, eq(persons.id, detections.person_id))
    .leftJoin(erpClients, eq(erpClients.erp_id, persons.erp_client_id))
    .orderBy(desc(detections.detected_at), desc(detections.id))
    .limit(limit);

  return rows.map((r) => ({
    type: "detection" as const,
    detection: {
      id: r.d_id,
      detected_at: r.d_detected_at.toISOString(),
      snapshot_path: r.d_snapshot_path,
      face_attrs: (r.d_face_attrs ?? {}) as Record<string, unknown>,
      dominant_emotion: r.d_dominant_emotion,
      emotion_confidence: r.d_emotion_confidence,
      session_id: r.d_session_id,
      camera_id: r.d_camera_id,
    },
    person: r.p_id
      ? {
          id: r.p_id,
          display_name: r.p_display_name,
          // Drizzle widens persons.* a T | null no LEFT JOIN; person_type é
          // notNull no schema, então é safe quando r.p_id é truthy (já guardado
          // pelo ternário externo). TS não propaga narrowing entre siblings.
          person_type: r.p_person_type!,
          photo_path: r.p_photo_path,
          last_seen_at: r.p_last_seen_at ? r.p_last_seen_at.toISOString() : null,
          total_visits: r.p_total_visits ?? 0,
          erp_client_id: r.p_erp_client_id,
          erp_employee_id: r.p_erp_employee_id,
          phone: r.p_phone,
        }
      : null,
  }));
}
