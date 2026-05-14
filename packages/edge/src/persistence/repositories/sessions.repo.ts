import type { SessionWithDetections } from "@vipcam/shared";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import { detections } from "../schema/detections.js";
import { type NewSession, type Session, sessions } from "../schema/sessions.js";

export const sessionsRepo = {
  /**
   * Busca sessão aberta para (camera, track) que ainda esteja dentro do gap
   * temporal — usado pelo session-tracker para reusar sessão entre detections
   * consecutivas do mesmo track. Se não achar, caller deve criar nova sessão.
   *
   * O `eventAt` (não Date.now()) é a base do cutoff — protege contra clock
   * skew entre câmera e servidor: se câmera atrasa, ainda achamos a sessão;
   * se servidor anda na frente, não promovemos eventos antigos artificialmente.
   */
  async findOpenForTrack(
    cameraId: string,
    trackId: string,
    eventAt: Date,
    gapMs: number,
  ): Promise<Session | null> {
    const cutoff = new Date(eventAt.getTime() - gapMs);
    const rows = await getDb()
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.camera_id, cameraId),
          eq(sessions.current_track_id, trackId),
          isNull(sessions.ended_at),
          gte(sessions.last_seen_at, cutoff),
        ),
      )
      // Determinístico: se houver mais de uma sessão aberta para o mesmo
      // (camera, track) — caso de stale-open por falta de close — pega
      // a mais recente.
      .orderBy(desc(sessions.started_at))
      .limit(1);
    return rows[0] ?? null;
  },

  async create(data: Omit<NewSession, "id">): Promise<Session> {
    // Inicializa last_seen_at = started_at se caller não passou explicitamente.
    const withDefaults = {
      ...data,
      last_seen_at: data.last_seen_at ?? data.started_at,
    };
    const [s] = await getDb().insert(sessions).values(withDefaults).returning();
    if (!s) throw new Error("insert returned no row");
    return s;
  },

  /**
   * Anexa uma detection à sessão: incrementa contador e atualiza last_seen_at.
   * Usado em hot path do ingest, então 1 UPDATE atômico.
   * (Recalculo de dominant_emotion vem depois via recalcDominantEmotion,
   * porque precisa da detection já INSERIDA no DB.)
   */
  async appendDetection(sessionId: string, detectedAt: Date): Promise<void> {
    await getDb()
      .update(sessions)
      .set({
        detection_count: sql`${sessions.detection_count} + 1`,
        last_seen_at: detectedAt,
      })
      .where(eq(sessions.id, sessionId));
  },

  /**
   * Recalcula dominant_emotion da sessão via mode() (ordered-set aggregate
   * do PostgreSQL — moda dos valores não-NULL). Chamar APÓS o insert de
   * uma nova detection. Idempotente.
   *
   * Performance: subquery escaneia apenas linhas com session_id = X,
   * sustentado pelo índice detections_session_idx. Custo: O(N) com N =
   * detections da sessão (tipicamente <20 num intervalo de poucos minutos).
   *
   * Mantém o valor anterior (COALESCE) se ainda não há nenhuma detection
   * com dominant_emotion populada — evita resetar pra NULL prematuramente.
   */
  async recalcDominantEmotion(sessionId: string): Promise<void> {
    await getDb()
      .update(sessions)
      .set({
        dominant_emotion: sql`COALESCE(
          (SELECT mode() WITHIN GROUP (ORDER BY ${detections.dominant_emotion})
           FROM ${detections}
           WHERE ${detections.session_id} = ${sessionId}
             AND ${detections.dominant_emotion} IS NOT NULL),
          ${sessions.dominant_emotion}
        )`,
      })
      .where(eq(sessions.id, sessionId));
  },

  async close(sessionId: string, endedAt: Date): Promise<void> {
    await getDb().update(sessions).set({ ended_at: endedAt }).where(eq(sessions.id, sessionId));
  },

  /**
   * Liga sessão a uma pessoa identificada (após match) e ao checkin ERP correlato.
   */
  async linkToPerson(
    sessionId: string,
    personId: string,
    erpCheckinId: string | null,
  ): Promise<void> {
    await getDb()
      .update(sessions)
      .set({ person_id: personId, linked_erp_checkin_id: erpCheckinId })
      .where(eq(sessions.id, sessionId));
  },

  /**
   * Onda 3: lista sessions de uma pessoa com detections embedded (cap 20
   * detections por session no payload). Usado pelo perfil em /people/[id]
   * pra renderizar stack de visitas com mini-thumbnails.
   *
   * 2 queries (não N+1): 1 SELECT em sessions + 1 SELECT em detections com
   * inArray(session_ids). Agrupamento em memória.
   */
  async listByPerson(personId: string, limit: number): Promise<SessionWithDetections[]> {
    const db = getDb();
    const sessRows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.person_id, personId))
      .orderBy(desc(sessions.started_at))
      .limit(limit);

    if (sessRows.length === 0) return [];

    const sessIds = sessRows.map((s) => s.id);
    const detRows = await db
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
      .where(inArray(detections.session_id, sessIds))
      .orderBy(desc(detections.detected_at));

    // Agrupa em memória + cap 20 por session
    const detsBySession = new Map<string, typeof detRows>();
    for (const d of detRows) {
      if (!d.session_id) continue;
      const arr = detsBySession.get(d.session_id) ?? [];
      if (arr.length < 20) arr.push(d);
      detsBySession.set(d.session_id, arr);
    }

    return sessRows.map((s) => ({
      id: s.id,
      started_at: s.started_at.toISOString(),
      ended_at: s.ended_at?.toISOString() ?? null,
      detection_count: s.detection_count,
      dominant_emotion: s.dominant_emotion,
      linked_erp_checkin_id: s.linked_erp_checkin_id,
      detections: (detsBySession.get(s.id) ?? []).map((d) => ({
        id: d.id,
        detected_at: d.detected_at.toISOString(),
        snapshot_path: d.snapshot_path,
        face_attrs: d.face_attrs as Record<string, unknown>,
        dominant_emotion: d.dominant_emotion,
        emotion_confidence: d.emotion_confidence,
        session_id: d.session_id,
        camera_id: d.camera_id,
      })),
    }));
  },
};
