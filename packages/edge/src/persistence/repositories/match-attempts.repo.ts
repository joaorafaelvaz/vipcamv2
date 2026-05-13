import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import {
  type MatchAttempt,
  type NewMatchAttempt,
  matchAttempts,
} from "../schema/match-attempts.js";

export const matchAttemptsRepo = {
  async create(data: Omit<NewMatchAttempt, "id">): Promise<MatchAttempt> {
    const [m] = await getDb().insert(matchAttempts).values(data).returning();
    if (!m) throw new Error("insert returned no row");
    return m;
  },

  async findById(id: string): Promise<MatchAttempt | null> {
    const rows = await getDb()
      .select()
      .from(matchAttempts)
      .where(eq(matchAttempts.id, id))
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * Tentativas de match marcadas como ambíguas — ficam pendentes de revisão
   * manual na UI. Ordenadas por decisão mais recente.
   */
  async findPending(limit: number): Promise<MatchAttempt[]> {
    return getDb()
      .select()
      .from(matchAttempts)
      .where(eq(matchAttempts.decision, "ambiguous"))
      .orderBy(desc(matchAttempts.decided_at))
      .limit(limit);
  },

  /**
   * Histórico de tentativas para um checkin ERP específico (auditoria/debug).
   */
  async findByCheckin(erpCheckinId: string): Promise<MatchAttempt[]> {
    return getDb()
      .select()
      .from(matchAttempts)
      .where(eq(matchAttempts.erp_checkin_id, erpCheckinId))
      .orderBy(desc(matchAttempts.decided_at));
  },

  /**
   * Atualiza um match attempt ambíguo após revisão manual: marca decision=
   * 'auto_matched', registra detection escolhida e quem decidiu (user).
   * Vinculação Person/detection/session é responsabilidade do route handler.
   */
  async resolveAmbiguous(
    id: string,
    chosenDetectionId: string,
    notes?: string,
  ): Promise<MatchAttempt | null> {
    const patch: Record<string, unknown> = {
      decision: "auto_matched",
      detection_id: chosenDetectionId,
      decided_by: "user",
      decided_at: sql`now()`,
    };
    if (notes !== undefined) patch.notes = notes;
    const [m] = await getDb()
      .update(matchAttempts)
      .set(patch)
      .where(eq(matchAttempts.id, id))
      .returning();
    return m ?? null;
  },

  /**
   * Marca um match attempt ambíguo como rejected após revisão manual
   * (operador confirmou que nenhuma das candidatas é o cliente do checkin).
   */
  async rejectAmbiguous(id: string, reason?: string): Promise<MatchAttempt | null> {
    const patch: Record<string, unknown> = {
      decision: "rejected",
      decided_by: "user",
      decided_at: sql`now()`,
    };
    if (reason !== undefined) patch.notes = reason;
    const [m] = await getDb()
      .update(matchAttempts)
      .set(patch)
      .where(eq(matchAttempts.id, id))
      .returning();
    return m ?? null;
  },
};
