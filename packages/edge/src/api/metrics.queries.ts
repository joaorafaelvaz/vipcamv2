import type {
  MetricsOverview,
  PeakHours,
  RecurrenceBreakdown,
  SentimentBreakdown,
  VisitsFlow,
} from "@vipcam/shared";
import { sql } from "drizzle-orm";
import { getEnv } from "../config/env.js";
import { getDb } from "../persistence/db.js";
import { persons } from "../persistence/schema/persons.js";
import { sessions } from "../persistence/schema/sessions.js";
import { computeTrend } from "./metrics.trend.js";

function windowStart(days: number): Date {
  return new Date(Date.now() - days * 24 * 3600 * 1000);
}

export async function visitsFlow(days: number): Promise<VisitsFlow> {
  const db = getDb();
  const tz = getEnv().METRICS_TZ;
  const start = windowStart(days);
  const rows = await db
    .select({
      date: sql<string>`to_char((${sessions.started_at} AT TIME ZONE ${tz})::date, 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
    })
    .from(sessions)
    .leftJoin(persons, sql`${persons.id} = ${sessions.person_id}`)
    .where(
      sql`${sessions.started_at} >= ${start} AND (${persons.person_type} IS NULL OR ${persons.person_type} <> 'employee')`,
    )
    // GROUP/ORDER BY ordinal posicional (col 1 = a expressão de data). Repetir
    // ${tz} no group/order criaria $3/$4 ≠ $1 do select, e o Postgres casa
    // expressões de GROUP BY sintaticamente (inclui nº do bind param) → erro
    // "must appear in GROUP BY". Posicional referencia a coluna de saída.
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  const points = rows.map((r) => ({ date: r.date, count: r.count }));
  return { points, trend: computeTrend(points.map((p) => p.count)) };
}

export async function peakHours(days: number): Promise<PeakHours> {
  const db = getDb();
  const tz = getEnv().METRICS_TZ;
  const start = windowStart(days);
  const rows = await db
    .select({
      weekday: sql<number>`extract(dow from (${sessions.started_at} AT TIME ZONE ${tz}))::int`,
      hour: sql<number>`extract(hour from (${sessions.started_at} AT TIME ZONE ${tz}))::int`,
      count: sql<number>`count(*)::int`,
    })
    .from(sessions)
    .leftJoin(persons, sql`${persons.id} = ${sessions.person_id}`)
    .where(
      sql`${sessions.started_at} >= ${start} AND (${persons.person_type} IS NULL OR ${persons.person_type} <> 'employee')`,
    )
    // GROUP BY posicional (col 1 = weekday, col 2 = hour). Mesmo motivo do
    // visitsFlow: repetir ${tz} criaria binds diferentes que o Postgres não
    // casa com os do SELECT.
    .groupBy(sql`1, 2`);
  return { cells: rows.map((r) => ({ weekday: r.weekday, hour: r.hour, count: r.count })) };
}

export async function recurrence(days: number): Promise<RecurrenceBreakdown> {
  const db = getDb();
  const start = windowStart(days);
  const [tot] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(sessions)
    .leftJoin(persons, sql`${persons.id} = ${sessions.person_id}`)
    .where(
      sql`${sessions.started_at} >= ${start} AND (${persons.person_type} IS NULL OR ${persons.person_type} <> 'employee')`,
    );
  const [idv] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(sessions)
    .innerJoin(persons, sql`${persons.id} = ${sessions.person_id}`)
    .where(sql`${sessions.started_at} >= ${start} AND ${persons.person_type} = 'client'`);
  const perClient = await db
    .select({
      personId: sql<string>`${persons.id}`,
      firstEver: sql<string>`min(${sessions.started_at})`,
    })
    .from(persons)
    .innerJoin(sessions, sql`${sessions.person_id} = ${persons.id}`)
    .where(sql`${persons.person_type} = 'client'`)
    .groupBy(sql`${persons.id}`)
    .having(sql`bool_or(${sessions.started_at} >= ${start})`);
  let newCount = 0;
  let returningCount = 0;
  for (const c of perClient) {
    if (new Date(c.firstEver) >= start) newCount++;
    else returningCount++;
  }
  return {
    new_count: newCount,
    returning_count: returningCount,
    identified_visits: idv?.c ?? 0,
    total_visits: tot?.c ?? 0,
  };
}

export async function sentiment(days: number): Promise<SentimentBreakdown> {
  const db = getDb();
  const start = windowStart(days);
  const rows = await db
    .select({
      emotion: sql<string>`coalesce(${sessions.dominant_emotion}, 'n/d')`,
      count: sql<number>`count(*)::int`,
    })
    .from(sessions)
    .leftJoin(persons, sql`${persons.id} = ${sessions.person_id}`)
    .where(
      sql`${sessions.started_at} >= ${start} AND (${persons.person_type} IS NULL OR ${persons.person_type} <> 'employee')`,
    )
    .groupBy(sql`coalesce(${sessions.dominant_emotion}, 'n/d')`)
    .orderBy(sql`count(*) desc`);
  return { buckets: rows.map((r) => ({ emotion: r.emotion, count: r.count })) };
}

export async function overviewMetrics(days: 7 | 30): Promise<MetricsOverview> {
  const [visits, peak, rec, sent] = await Promise.all([
    visitsFlow(days),
    peakHours(days),
    recurrence(days),
    sentiment(days),
  ]);
  return { days, visits, peak, recurrence: rec, sentiment: sent };
}
