import type { DashboardSummary } from "@vipcam/shared";
import { eq, gte, sql } from "drizzle-orm";
import { getDb } from "../persistence/db.js";
import { detections } from "../persistence/schema/detections.js";
import { matchAttempts } from "../persistence/schema/match-attempts.js";
import { persons } from "../persistence/schema/persons.js";

/**
 * Agrega counts pra topbar do dashboard (Onda 3 — Task 3.1.7).
 *
 * Extraído pra módulo dedicado pra deixar server.ts magro. 4 queries em
 * paralelo (Promise.all) — todas leves (count(*)/max).
 */
export async function fetchDashboardSummary(): Promise<DashboardSummary> {
  const db = getDb();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [[pending], [lastDet], [todayCount], personCounts] = await Promise.all([
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(matchAttempts)
      .where(eq(matchAttempts.decision, "ambiguous")),
    db.select({ at: sql<Date | null>`max(${detections.detected_at})` }).from(detections),
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(detections)
      .where(gte(detections.detected_at, todayStart)),
    db
      .select({ type: persons.person_type, c: sql<number>`count(*)::int` })
      .from(persons)
      .groupBy(persons.person_type),
  ]);

  const counts = { client: 0, employee: 0 };
  for (const row of personCounts) {
    if (row.type === "client") counts.client = row.c;
    else if (row.type === "employee") counts.employee = row.c;
  }

  return {
    pending_matches: pending?.c ?? 0,
    last_detection_at: lastDet?.at ? new Date(lastDet.at).toISOString() : null,
    detections_today: todayCount?.c ?? 0,
    persons_total: counts,
  };
}
