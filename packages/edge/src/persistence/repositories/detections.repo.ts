import { and, asc, between, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../db.js";
import { type Detection, type NewDetection, detections } from "../schema/detections.js";
import { persons } from "../schema/persons.js";

export const detectionsRepo = {
  /**
   * `id` é opcional: quando ausente, Postgres preenche via defaultRandom().
   * Onda 7 — pipeline pré-gera o uuid pra passar ao reid orchestrator
   * (que loga detectionId em metrics) ANTES do insert. Pre-gen é seguro
   * porque uuid v4 colisão é desprezível e o INSERT abaixo respeita
   * NewDetection.id?.
   */
  async create(data: NewDetection): Promise<Detection> {
    const [d] = await getDb().insert(detections).values(data).returning();
    if (!d) throw new Error("insert returned no row");
    return d;
  },

  async findById(id: string): Promise<Detection | null> {
    const rows = await getDb().select().from(detections).where(eq(detections.id, id)).limit(1);
    return rows[0] ?? null;
  },

  /**
   * Detections sem person_id em uma janela temporal — query crítica do match-temp
   * (correlaciona checkin ERP com detections anônimas próximas no tempo).
   */
  async findAnonymousInWindow(start: Date, end: Date): Promise<Detection[]> {
    return getDb()
      .select()
      .from(detections)
      .where(and(isNull(detections.person_id), between(detections.detected_at, start, end)))
      .orderBy(asc(detections.detected_at));
  },

  /**
   * Onda 9-A: substitui findAnonymousInWindow no orchestrator. Retorna TODAS
   * as detections na janela (NULL + non-NULL person_id) pra suportar §5.1
   * rows 3-5 (conflito reid+ERP divergente) — o caller particiona por
   * person_id (NULL → decideMatch clássico, non-NULL → loop divergent).
   *
   * findAnonymousInWindow continua existindo (Task 3 remove o uso no
   * orchestrator; cleanup final acontece depois).
   *
   * `session_id` é incluído no projection porque é required pelo orchestrator
   * auto-match session-linkage path (Task 3): ao confirmar match, atualizamos
   * sessions.person_id/linked_erp_checkin_id usando det.session_id. Sem esse
   * campo, a branch de auto-match silenciosamente no-op e quebra o
   * comportamento existente de Onda 2/3.
   */
  async findInWindow(
    start: Date,
    end: Date,
  ): Promise<
    Array<{
      id: string;
      detected_at: Date;
      person_id: string | null;
      // Onda 9-D: person_type via LEFT JOIN persons — NULL quando person_id NULL.
      // Usado pelo orchestrator p/ classificar candidatos (anonymous/employee/client).
      person_type: "client" | "employee" | "anonymous" | null;
      session_id: string | null;
      snapshot_path: string | null;
    }>
  > {
    return getDb()
      .select({
        id: detections.id,
        detected_at: detections.detected_at,
        person_id: detections.person_id,
        person_type: persons.person_type,
        session_id: detections.session_id,
        snapshot_path: detections.snapshot_path,
      })
      .from(detections)
      .leftJoin(persons, eq(detections.person_id, persons.id))
      .where(between(detections.detected_at, start, end))
      .orderBy(asc(detections.detected_at));
  },

  /**
   * Liga uma detection a uma pessoa (após match temporal/visual ou link manual).
   */
  async linkToPerson(detectionId: string, personId: string): Promise<void> {
    await getDb()
      .update(detections)
      .set({ person_id: personId })
      .where(eq(detections.id, detectionId));
  },

  /**
   * Últimas N detections (ordenadas por timestamp desc) — usado pela UI/dashboard.
   */
  async recent(limit: number): Promise<Detection[]> {
    return getDb().select().from(detections).orderBy(desc(detections.detected_at)).limit(limit);
  },

  /**
   * Detections de uma sessão específica (Onda 3 — usado por GET /api/sessions/:id/detections
   * pra hidratar fotos no perfil quando UI precisa mais que as 20 já embedded
   * em sessionsRepo.listByPerson).
   */
  async listBySession(sessionId: string, limit = 100): Promise<Detection[]> {
    return getDb()
      .select()
      .from(detections)
      .where(eq(detections.session_id, sessionId))
      .orderBy(desc(detections.detected_at))
      .limit(limit);
  },
};
