import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import { type FaceRecord, type NewFaceRecord, faceRecords } from "../schema/face-records.js";

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

  /**
   * Insere face_record + FIFO eviction (cap=5) numa transação.
   * Pattern Onda 7 §4.2: SELECT FOR UPDATE defensivo (pipeline atual é
   * single-threaded mas paralelização futura não-quebra).
   */
  async insertAndEvict(data: Omit<NewFaceRecord, "id" | "created_at">): Promise<FaceRecord> {
    return await getDb().transaction(async (tx) => {
      // Lock dos existentes pra evitar race com outro insert na mesma person
      await tx.execute(sql`
        SELECT id FROM face_records WHERE person_id = ${data.person_id} FOR UPDATE
      `);
      const [inserted] = await tx.insert(faceRecords).values(data).returning();
      if (!inserted) throw new Error("face_records insert returned no row");
      // Eviction: deleta o que sobra além de 5 mais recentes
      await tx.execute(sql`
        DELETE FROM face_records
        WHERE id IN (
          SELECT id FROM face_records
          WHERE person_id = ${data.person_id}
          ORDER BY created_at DESC
          OFFSET 5
        )
      `);
      return inserted;
    });
  },

  /**
   * Move todos face_records de srcPersonId pra dstPersonId, depois FIFO
   * eviction em dst se total > 5. Helper usado por personsRepo.mergeInto
   * (Onda 7 §5.2 step 2 + step 3).
   *
   * Aceita um Drizzle transaction opcional (`tx`) pra rodar DENTRO de uma
   * transação maior (caso típico: mergeInto). Quando `tx` ausente, usa o
   * connection pool normal (getDb()) — útil pra ad-hoc fixups.
   *
   * Importante: quando rodando fora de transação, race condition é possível
   * (entre UPDATE e DELETE outro insert pode mover o cap). Pra produção
   * usar dentro do mergeInto.
   */
  async transferToPerson(
    srcPersonId: string,
    dstPersonId: string,
    tx?: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  ): Promise<void> {
    const db = tx ?? getDb();
    await db.execute(sql`
      UPDATE face_records SET person_id = ${dstPersonId}
      WHERE person_id = ${srcPersonId}
    `);
    await db.execute(sql`
      DELETE FROM face_records
      WHERE id IN (
        SELECT id FROM face_records
        WHERE person_id = ${dstPersonId}
        ORDER BY created_at DESC
        OFFSET 5
      )
    `);
  },
};
