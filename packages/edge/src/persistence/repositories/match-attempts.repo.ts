import { desc, eq } from "drizzle-orm";
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
};
