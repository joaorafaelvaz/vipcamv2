import { getDb } from "../db.js";
import {
  type NewReidMatchAttempt,
  type ReidMatchAttempt,
  reidMatchAttempts,
} from "../schema/reid-match-attempts.js";

export const reidMatchAttemptsRepo = {
  async createAmbiguous(
    data: Omit<NewReidMatchAttempt, "id" | "decision" | "decided_by" | "decided_at">,
  ): Promise<ReidMatchAttempt> {
    const [row] = await getDb()
      .insert(reidMatchAttempts)
      .values({ ...data, decision: "ambiguous", decided_by: "system" })
      .returning();
    if (!row) throw new Error("reid_match_attempts insert returned no row");
    return row;
  },
};
