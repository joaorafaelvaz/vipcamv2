import { and, asc, between, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../db.js";
import { type Detection, type NewDetection, detections } from "../schema/detections.js";

export const detectionsRepo = {
  async create(data: Omit<NewDetection, "id">): Promise<Detection> {
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
};
