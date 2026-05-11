import { and, eq } from "drizzle-orm";
import { getDb } from "../db.js";
import { type FaceRecord, faceRecords, type NewFaceRecord } from "../schema/face-records.js";

export const faceRecordsRepo = {
  async create(data: Omit<NewFaceRecord, "id">): Promise<FaceRecord> {
    const [fr] = await getDb().insert(faceRecords).values(data).returning();
    if (!fr) throw new Error("insert returned no row");
    return fr;
  },

  /**
   * Query crítica do reid-mgr A (failover via Face DB câmera).
   * Lookup por camera_face_id (string retornada pelo Face DB embarcado).
   * Retorna NULL se não encontrar — caller decide criar pessoa anônima.
   */
  async findByCameraFaceId(faceId: string): Promise<FaceRecord | null> {
    const rows = await getDb()
      .select()
      .from(faceRecords)
      .where(eq(faceRecords.camera_face_id, faceId))
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * Retorna o face record primário (canonical) de uma pessoa.
   * Cada pessoa pode ter múltiplos faces (um por câmera/ângulo); o primary
   * é o usado pra exibição/comparação principal.
   */
  async findPrimaryByPersonId(personId: string): Promise<FaceRecord | null> {
    const rows = await getDb()
      .select()
      .from(faceRecords)
      .where(and(eq(faceRecords.person_id, personId), eq(faceRecords.is_primary, true)))
      .limit(1);
    return rows[0] ?? null;
  },

  async delete(id: string): Promise<void> {
    await getDb().delete(faceRecords).where(eq(faceRecords.id, id));
  },
};
