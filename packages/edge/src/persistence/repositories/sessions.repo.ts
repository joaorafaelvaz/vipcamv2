import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { getDb } from "../db.js";
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
};
