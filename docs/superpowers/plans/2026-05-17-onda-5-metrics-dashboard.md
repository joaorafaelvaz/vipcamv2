# Onda 5 — Dashboard de Métricas de Negócio Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only business-metrics dashboard (visits flow, peak hours, recurrence, sentiment) at `/metrics`, served by one combined edge endpoint.

**Architecture:** Edge gets a pure-function-per-metric module (`metrics.queries.ts`, mirroring `dashboard.queries.ts`) aggregating `sessions` on-demand via SQL GROUP BY, an orchestrator, a Hono route, and a new `METRICS_TZ` env. Web gets a React Query hook, five focused chart components (Recharts), a `force-dynamic` page in layout B, and a topbar link.

**Tech Stack:** Bun + Hono + Drizzle + PostgreSQL (edge), Next.js 14 + shadcn/ui + Recharts + React Query (web), TypeScript composite refs, Zod env.

**Spec:** `docs/superpowers/specs/2026-05-17-metrics-dashboard-design.md` (approved by spec-reviewer).

**Environment note:** No local Postgres (Docker off on this machine). Integration tests (DB) cannot execute here — same accepted fallback as Onda 4: write the test, confirm it fails only on DB bootstrap (not on code/type), `bun run typecheck` 3/3 is the hard gate, commit, and flag in the final summary that DB integration tests must run where `vipcam_test` exists before merge. Do NOT weaken/skip tests. Offline-runnable: pure unit tests, route unit tests, typecheck, lint, `next build`.

---

## Chunk 1: Edge API (types, env, metrics queries, route, wiring)

### File Structure

- **Modify:** `packages/shared/src/types/index.ts` — append metrics interfaces (type-only).
- **Modify:** `packages/edge/src/config/env.ts` — add `METRICS_TZ`.
- **Create:** `packages/edge/src/api/metrics.trend.ts` — pure linear-regression trend (testable offline).
- **Create:** `packages/edge/src/api/metrics.queries.ts` — `visitsFlow`, `peakHours`, `recurrence`, `sentiment`, `overviewMetrics`.
- **Create:** `packages/edge/src/api/routes/metrics.ts` — `createMetricsRoutes(deps)`.
- **Modify:** `packages/edge/src/api/server.ts` — mount route + `requireKey` (anchor by existing symbols, not line numbers — Onda 4 shifted lines).
- **Create:** `packages/edge/tests/unit/api/metrics-trend.test.ts`, `packages/edge/tests/unit/config/metrics-env.test.ts`, `packages/edge/tests/unit/api/routes/metrics.test.ts`.
- **Create:** `packages/edge/tests/integration/api/metrics-queries.test.ts`.
- **Modify:** `infra/env-templates/edge.env.example` (repo root; if present) to document `METRICS_TZ`.

---

### Task 1: Shared types

**Files:**
- Modify: `packages/shared/src/types/index.ts` (append at end)

- [ ] **Step 1: Append the interfaces**

Append to the end of `packages/shared/src/types/index.ts`:

```ts
export interface VisitsFlowPoint {
  date: string; // local date YYYY-MM-DD
  count: number;
}
export interface VisitsFlow {
  points: VisitsFlowPoint[];
  trend: { slope: number; direction: "up" | "down" | "flat" };
}
export interface PeakHourCell {
  weekday: number; // 0-6 (0=domingo, local)
  hour: number; // 0-23 (local)
  count: number;
}
export interface PeakHours {
  cells: PeakHourCell[];
}
export interface RecurrenceBreakdown {
  new_count: number;
  returning_count: number;
  identified_visits: number;
  total_visits: number;
}
export interface SentimentBucket {
  emotion: string; // inclui "n/d"
  count: number;
}
export interface SentimentBreakdown {
  buckets: SentimentBucket[];
}
export interface MetricsOverview {
  days: 7 | 30;
  visits: VisitsFlow;
  peak: PeakHours;
  recurrence: RecurrenceBreakdown;
  sentiment: SentimentBreakdown;
}
```

- [ ] **Step 2: Typecheck shared**

Run: `bun run typecheck`
Expected: exit 0, 3/3 (shared/web/edge). Types are additive — nothing consumes them yet.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types/index.ts
git commit -m "$(cat <<'EOF'
feat(shared): Onda 5 — metrics dashboard response types

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `METRICS_TZ` env

**Files:**
- Modify: `packages/edge/src/config/env.ts`
- Test: `packages/edge/tests/unit/config/metrics-env.test.ts`

`env.ts` has a Zod `envSchema = z.object({...}).refine(...)`. Add the key inside the `.object({})` (before the closing `})` that precedes `.refine`). Pattern: other defaulted strings like `ERP_QUERY_CLIENTS: z.string().default("...")`.

- [ ] **Step 1: Write the failing test**

Create `packages/edge/tests/unit/config/metrics-env.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { parseEnv } from "../../../src/config/env.js";

const base = { API_KEY: "k" };

describe("METRICS_TZ env", () => {
  test("defaults to America/Sao_Paulo", () => {
    const env = parseEnv({ ...base });
    expect(env.METRICS_TZ).toBe("America/Sao_Paulo");
  });
  test("accepts override", () => {
    const env = parseEnv({ ...base, METRICS_TZ: "UTC" });
    expect(env.METRICS_TZ).toBe("UTC");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/edge && bun test tests/unit/config/metrics-env.test.ts`
Expected: FAIL — `env.METRICS_TZ` is `undefined` (key not in schema).

- [ ] **Step 3: Add the env key**

In `packages/edge/src/config/env.ts`, inside the `z.object({ ... })`, after the `ERP_CHECKINS_INITIAL_LOOKBACK_HOURS` line and before the `})` that precedes `.refine(`, add:

```typescript
    // Onda 5: timezone p/ buckets de dia/hora das métricas. Timestamps são
    // timestamptz (UTC); a barbearia é local — sem isso pico/fluxo deslocam ~3h.
    METRICS_TZ: z.string().min(1).default("America/Sao_Paulo"),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/edge && bun test tests/unit/config/metrics-env.test.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Document in env example**

Run: `ls infra/env-templates/edge.env.example 2>/dev/null` (repo root). If present, add a documented line: `# METRICS_TZ=America/Sao_Paulo  # opcional — TZ dos buckets de métricas`. If absent, skip this step (note it in the commit body).

- [ ] **Step 6: Commit**

```bash
git add packages/edge/src/config/env.ts packages/edge/tests/unit/config/metrics-env.test.ts
git commit -m "$(cat <<'EOF'
feat(edge): Onda 5 — METRICS_TZ env (default America/Sao_Paulo)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Pure trend function (offline-testable)

**Files:**
- Create: `packages/edge/src/api/metrics.trend.ts`
- Test: `packages/edge/tests/unit/api/metrics-trend.test.ts`

Least-squares slope over the daily counts (x = index 0..n-1, y = count). Direction from slope with a flat deadband.

- [ ] **Step 1: Write the failing test**

Create `packages/edge/tests/unit/api/metrics-trend.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { computeTrend } from "../../../src/api/metrics.trend.js";

describe("computeTrend", () => {
  test("rising series → up, positive slope", () => {
    const t = computeTrend([1, 2, 3, 4, 5]);
    expect(t.slope).toBeGreaterThan(0);
    expect(t.direction).toBe("up");
  });
  test("falling series → down", () => {
    expect(computeTrend([5, 4, 3, 2, 1]).direction).toBe("down");
  });
  test("flat series → flat, slope 0", () => {
    const t = computeTrend([3, 3, 3, 3]);
    expect(t.slope).toBe(0);
    expect(t.direction).toBe("flat");
  });
  test("near-flat within deadband → flat", () => {
    // slope ~0.02/day over tiny variation → treated as flat
    expect(computeTrend([10, 10, 10, 10, 10.1]).direction).toBe("flat");
  });
  test("empty / single point → flat slope 0 (no throw)", () => {
    expect(computeTrend([])).toEqual({ slope: 0, direction: "flat" });
    expect(computeTrend([7])).toEqual({ slope: 0, direction: "flat" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/edge && bun test tests/unit/api/metrics-trend.test.ts`
Expected: FAIL — cannot find module `metrics.trend.js`.

- [ ] **Step 3: Implement**

Create `packages/edge/src/api/metrics.trend.ts`:

```typescript
/**
 * Tendência por mínimos quadrados sobre contagens diárias.
 * x = índice do dia (0..n-1), y = contagem. Função pura (Onda 5).
 * Deadband: |slope| < 0.05 visitas/dia → "flat" (ruído não vira tendência).
 */
export interface Trend {
  slope: number;
  direction: "up" | "down" | "flat";
}

const FLAT_DEADBAND = 0.05;

export function computeTrend(counts: number[]): Trend {
  const n = counts.length;
  if (n < 2) return { slope: 0, direction: "flat" };
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const y = counts[i] ?? 0;
    sx += i;
    sy += y;
    sxx += i * i;
    sxy += i * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, direction: "flat" };
  const rawSlope = (n * sxy - sx * sy) / denom;
  // arredonda p/ estabilidade do snapshot/teste
  const slope = Math.round(rawSlope * 1000) / 1000;
  const direction =
    Math.abs(slope) < FLAT_DEADBAND ? "flat" : slope > 0 ? "up" : "down";
  return { slope, direction };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/edge && bun test tests/unit/api/metrics-trend.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add packages/edge/src/api/metrics.trend.ts packages/edge/tests/unit/api/metrics-trend.test.ts
git commit -m "$(cat <<'EOF'
feat(edge): Onda 5 — pure least-squares trend helper

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `metrics.queries.ts` — the 4 metric functions + orchestrator

**Files:**
- Create: `packages/edge/src/api/metrics.queries.ts`
- Test: `packages/edge/tests/integration/api/metrics-queries.test.ts` (DB — deferred run)

Mirrors `dashboard.queries.ts` (`getDb()`, Drizzle `sql`). Authoritative session→person link is `sessions.person_id` (spec §3). TZ value comes from `getEnv().METRICS_TZ`, interpolated as a **bound parameter** in the `sql` template (Drizzle parameterizes `${value}`), never string-concatenated.

Window: `windowStart = now - days*24h`. "Non-employee sessions" = `LEFT JOIN persons ON persons.id = sessions.person_id WHERE (persons.person_type IS NULL OR persons.person_type <> 'employee')`.

> **TZ idiom note (reconciles spec §3 wording):** spec §3 sketches `(... AT TIME ZONE 'UTC' AT TIME ZONE <tz>)`. Since `sessions.started_at` is `timestamptz` (not naive `timestamp`), the correct equivalent Postgres idiom is a **single** `(${sessions.started_at} AT TIME ZONE ${tz})` — it yields the local wall-clock `timestamp`. The double form is only needed for tz-naive columns. The code below uses the single form intentionally; this is not spec drift.

- [ ] **Step 1: Write the failing integration test**

Create `packages/edge/tests/integration/api/metrics-queries.test.ts`:

```typescript
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { overviewMetrics } from "../../../src/api/metrics.queries.js";
import { closeDb } from "../../../src/persistence/db.js";
import {
  camerasRepo,
  personsRepo,
  sessionsRepo,
} from "../../../src/persistence/repositories/index.js";
import { truncateAll } from "../persistence/_helpers.js";

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await closeDb();
});

// helper: cria sessão (opcionalmente ligada a um person) num instante
async function mkSession(cameraId: string, startedAt: Date, opts?: {
  personId?: string;
  emotion?: string | null;
}) {
  const s = await sessionsRepo.create({
    camera_id: cameraId,
    started_at: startedAt,
    last_seen_at: startedAt,
    detection_count: 1,
    dominant_emotion: opts?.emotion ?? null,
  });
  if (opts?.personId) {
    // API real confirmada: sessionsRepo.linkToPerson(sessionId, personId,
    // erpCheckinId: string|null) — sessions.repo.ts:104. Usar como está.
    await sessionsRepo.linkToPerson(s.id, opts.personId, null);
  }
  return s;
}

describe("overviewMetrics (Onda 5)", () => {
  test("período vazio → estrutura vazia tipada, sem throw", async () => {
    const o = await overviewMetrics(7);
    expect(o.days).toBe(7);
    expect(o.visits.points).toEqual([]);
    expect(o.visits.trend).toEqual({ slope: 0, direction: "flat" });
    expect(o.peak.cells).toEqual([]);
    expect(o.recurrence).toEqual({
      new_count: 0,
      returning_count: 0,
      identified_visits: 0,
      total_visits: 0,
    });
    expect(o.sentiment.buckets).toEqual([]);
  });

  test("funcionário é excluído de TODAS as métricas; anônimo entra; n/d bucket", async () => {
    const cam = await camerasRepo.create({ name: "c", ip_address: "10.0.0.1" });
    const emp = await personsRepo.create({
      display_name: "Func",
      person_type: "employee",
      erp_employee_id: "e1",
    });
    const now = new Date();
    const within = new Date(now.getTime() - 2 * 24 * 3600 * 1000);

    await mkSession(cam.id, within, { emotion: "happy" }); // anônima
    await mkSession(cam.id, within, { emotion: null }); // anônima, n/d
    await mkSession(cam.id, within, { personId: emp.id, emotion: "sad" }); // funcionário (sai)

    const o = await overviewMetrics(7);
    const totalVisits = o.visits.points.reduce((a, p) => a + p.count, 0);
    expect(totalVisits).toBe(2); // funcionário excluído
    expect(o.recurrence.total_visits).toBe(2);
    const nd = o.sentiment.buckets.find((b) => b.emotion === "n/d");
    expect(nd?.count).toBe(1);
    expect(o.sentiment.buckets.find((b) => b.emotion === "sad")).toBeUndefined();
  });

  test("recorrência: novo (1ª visita na janela) vs recorrente (visita anterior)", async () => {
    const cam = await camerasRepo.create({ name: "c2", ip_address: "10.0.0.2" });
    const now = new Date();
    const inWin = new Date(now.getTime() - 1 * 24 * 3600 * 1000);
    const beforeWin = new Date(now.getTime() - 20 * 24 * 3600 * 1000);

    const novo = await personsRepo.create({ display_name: "Novo", person_type: "client" });
    const recorrente = await personsRepo.create({ display_name: "Volta", person_type: "client" });

    await mkSession(cam.id, inWin, { personId: novo.id, emotion: "happy" });
    await mkSession(cam.id, beforeWin, { personId: recorrente.id, emotion: "happy" });
    await mkSession(cam.id, inWin, { personId: recorrente.id, emotion: "happy" });

    const o = await overviewMetrics(7);
    expect(o.recurrence.new_count).toBe(1);
    expect(o.recurrence.returning_count).toBe(1);
    expect(o.recurrence.identified_visits).toBe(2); // 2 sessões de clientes na janela
  });

  test("timezone: sessão perto da meia-noite UTC cai no dia LOCAL correto", async () => {
    // Com METRICS_TZ=America/Sao_Paulo (UTC-3), 2026-05-10T02:00:00Z é
    // 2026-05-09 23:00 local → deve agregar no dia 2026-05-09.
    process.env.METRICS_TZ = "America/Sao_Paulo";
    const cam = await camerasRepo.create({ name: "c3", ip_address: "10.0.0.3" });
    // dentro da janela de 30d a partir de "agora" do teste só funciona se a
    // data for recente; usar um instante recente perto da meia-noite local.
    const now = new Date();
    const localMidnightish = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 2, 0, 0),
    );
    await mkSession(cam.id, localMidnightish, { emotion: "happy" });
    const o = await overviewMetrics(30);
    // o ponto do dia deve ser o dia LOCAL (UTC-3), não o dia UTC
    const expectedLocalDate = new Date(localMidnightish.getTime() - 3 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    expect(o.visits.points.some((p) => p.date === expectedLocalDate)).toBe(true);
  });
});
```

> Confirmed API (no placeholder): `sessionsRepo.linkToPerson(sessionId: string, personId: string, erpCheckinId: string | null)` — `packages/edge/src/persistence/repositories/sessions.repo.ts:104` (does `.set({ person_id, linked_erp_checkin_id })`). The `mkSession` helper above uses it correctly as-is; pass `null` for `erpCheckinId`.

- [ ] **Step 2: Run test to verify it fails for the right reason**

Run: `cd packages/edge && bun test tests/integration/api/metrics-queries.test.ts`
Expected: FAIL — cannot find module `metrics.queries.js` (module-not-found). If it instead fails on Postgres/env bootstrap before resolving the import, that confirms the no-DB environment; proceed and rely on typecheck (per Environment note).

- [ ] **Step 3: Implement `metrics.queries.ts`**

Create `packages/edge/src/api/metrics.queries.ts`:

```typescript
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

// Expressão SQL do dia/hora LOCAL. tz é bound param (Drizzle parametriza ${tz}).
// `started_at` é timestamptz; `AT TIME ZONE tz` devolve timestamp local.

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
    .groupBy(sql`(${sessions.started_at} AT TIME ZONE ${tz})::date`)
    .orderBy(sql`(${sessions.started_at} AT TIME ZONE ${tz})::date`);
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
    .groupBy(
      sql`extract(dow from (${sessions.started_at} AT TIME ZONE ${tz}))`,
      sql`extract(hour from (${sessions.started_at} AT TIME ZONE ${tz}))`,
    );
  return { cells: rows.map((r) => ({ weekday: r.weekday, hour: r.hour, count: r.count })) };
}

export async function recurrence(days: number): Promise<RecurrenceBreakdown> {
  const db = getDb();
  const start = windowStart(days);
  // total_visits = sessões não-funcionário na janela
  const [tot] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(sessions)
    .leftJoin(persons, sql`${persons.id} = ${sessions.person_id}`)
    .where(
      sql`${sessions.started_at} >= ${start} AND (${persons.person_type} IS NULL OR ${persons.person_type} <> 'employee')`,
    );
  // identified_visits = sessões de clientes na janela
  const [idv] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(sessions)
    .innerJoin(persons, sql`${persons.id} = ${sessions.person_id}`)
    .where(
      sql`${sessions.started_at} >= ${start} AND ${persons.person_type} = 'client'`,
    );
  // por cliente com sessão na janela: MIN(started_at) de TODAS as sessões dele
  const perClient = await db
    .select({
      personId: sql<string>`${persons.id}`,
      firstEver: sql<string>`min(${sessions.started_at})`,
    })
    .from(persons)
    .innerJoin(sessions, sql`${sessions.person_id} = ${persons.id}`)
    .where(sql`${persons.person_type} = 'client'`)
    .groupBy(sql`${persons.id}`)
    .having(
      sql`bool_or(${sessions.started_at} >= ${start})`, // tem ≥1 sessão na janela
    );
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
```

> Import convention follows `dashboard.queries.ts` lines 1-6 (`sessions` from `../persistence/schema/sessions.js`, `persons` from `../persistence/schema/persons.js`). The `having(bool_or(...))` keeps "client has ≥1 session in window" while `min(started_at)` is over ALL their sessions — that is the spec's recurrence rule. Verify Drizzle accepts these `sql\`\`` fragments the same way `dashboard.queries.ts` does; if a `.where`/`.having` shape needs adjusting, keep the SQL semantics identical.

- [ ] **Step 4: Run integration test (expect PASS, or documented DB-skip)**

Run: `cd packages/edge && bun test tests/integration/api/metrics-queries.test.ts`
Expected: PASS (4/4) where Postgres `vipcam_test` is available. If no DB here, it errors on DB bootstrap only — acceptable per Environment note; do NOT modify the test.

- [ ] **Step 5: Typecheck (hard gate)**

Run: `bun run typecheck`
Expected: exit 0, 3/3. Confirms imports/types correct (catches the flagged import fix).

- [ ] **Step 6: Commit**

```bash
git add packages/edge/src/api/metrics.queries.ts packages/edge/tests/integration/api/metrics-queries.test.ts
git commit -m "$(cat <<'EOF'
feat(edge): Onda 5 — on-demand metrics queries + orchestrator

visitsFlow/peakHours/recurrence/sentiment over sessions (sessions.person_id
authoritative; employees excluded; METRICS_TZ buckets). Integration test
covers empty period, employee exclusion, recurrence new/returning, TZ.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Route + server wiring

**Files:**
- Create: `packages/edge/src/api/routes/metrics.ts`
- Modify: `packages/edge/src/api/server.ts`
- Test: `packages/edge/tests/unit/api/routes/metrics.test.ts` (no DB — runs offline)

Mirrors `routes/dashboard.ts` (`createXRoutes(deps)` → Hono). Validate `days` query as enum `{7,30}`, default 7, invalid → 400.

- [ ] **Step 1: Write the failing route test**

Create `packages/edge/tests/unit/api/routes/metrics.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { MetricsOverview } from "@vipcam/shared";
import { createMetricsRoutes } from "../../../../src/api/routes/metrics.js";

const fake: MetricsOverview = {
  days: 7,
  visits: { points: [], trend: { slope: 0, direction: "flat" } },
  peak: { cells: [] },
  recurrence: { new_count: 0, returning_count: 0, identified_visits: 0, total_visits: 0 },
  sentiment: { buckets: [] },
};

function app() {
  return createMetricsRoutes({
    overview: async (days) => ({ ...fake, days }),
  });
}

describe("createMetricsRoutes GET /overview", () => {
  test("default days=7", async () => {
    const res = await app().request("/overview");
    expect(res.status).toBe(200);
    expect((await res.json()).days).toBe(7);
  });
  test("days=30 honored", async () => {
    const res = await app().request("/overview?days=30");
    expect((await res.json()).days).toBe(30);
  });
  test("invalid days → 400", async () => {
    const res = await app().request("/overview?days=99");
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/edge && bun test tests/unit/api/routes/metrics.test.ts`
Expected: FAIL — module `routes/metrics.js` not found.

- [ ] **Step 3: Implement the route**

Create `packages/edge/src/api/routes/metrics.ts`:

```typescript
import type { MetricsOverview } from "@vipcam/shared";
import { Hono } from "hono";

export interface MetricsDeps {
  overview: (days: 7 | 30) => Promise<MetricsOverview>;
}

/**
 * Endpoints REST de métricas (Onda 5).
 * - GET /overview?days=7|30 → MetricsOverview (1 request = página inteira)
 * Auth via apiKeyMiddleware aplicado em /api/metrics/* no server.ts.
 */
export function createMetricsRoutes(deps: MetricsDeps): Hono {
  const r = new Hono();
  r.get("/overview", async (c) => {
    const raw = c.req.query("days");
    const days = raw === undefined ? 7 : Number(raw);
    if (days !== 7 && days !== 30) {
      return c.json({ error: "days must be 7 or 30" }, 400);
    }
    return c.json(await deps.overview(days as 7 | 30));
  });
  return r;
}
```

- [ ] **Step 4: Run route test — PASS**

Run: `cd packages/edge && bun test tests/unit/api/routes/metrics.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Wire into `server.ts`**

In `packages/edge/src/api/server.ts`:
- Find the import block of `./routes/*.js` (there is `import { createDashboardRoutes } from "./routes/dashboard.js";`). Add: `import { createMetricsRoutes } from "./routes/metrics.js";` and `import { overviewMetrics } from "./metrics.queries.js";`.
- Find the line `app.use("/api/dashboard/*", requireKey);` (grep it). Add directly after it: `app.use("/api/metrics/*", requireKey);`.
- Find the `app.route("/api/dashboard", createDashboardRoutes({ ... }));` block (grep `createDashboardRoutes`). Add after it:

```typescript
  app.route(
    "/api/metrics",
    createMetricsRoutes({
      overview: (days) => overviewMetrics(days),
    }),
  );
```

(Use grep to locate exact anchors — Onda 4 shifted line numbers; do NOT trust hardcoded lines.)

- [ ] **Step 6: Typecheck + full edge unit suites**

Run: `bun run typecheck` → exit 0, 3/3.
Run: `cd packages/edge && bun test tests/unit` → all unit suites pass (DB-less). New route + trend + env tests green.

- [ ] **Step 7: Commit**

```bash
git add packages/edge/src/api/routes/metrics.ts packages/edge/src/api/server.ts packages/edge/tests/unit/api/routes/metrics.test.ts
git commit -m "$(cat <<'EOF'
feat(edge): Onda 5 — GET /api/metrics/overview route + server wiring

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Chunk 1 review gate

Dispatch the plan/spec compliance + code-quality reviews per subagent-driven-development for Chunk 1 before starting Chunk 2. Edge API must be green (typecheck 3/3, unit suites pass; integration deferred if no DB).

---

## Chunk 2: Web UI (Recharts dep, hook, components, page, topbar)

### File Structure

- **Modify:** `packages/web/package.json` — add `recharts`.
- **Create:** `packages/web/src/lib/queries/metrics.ts` — `useMetricsOverview(days)`.
- **Create:** `packages/web/src/components/metrics/metric-kpis.tsx`, `visits-flow-chart.tsx`, `peak-hours-heatmap.tsx`, `recurrence-donut.tsx`, `sentiment-bars.tsx`.
- **Create:** `packages/web/src/app/metrics/page.tsx` (layout B, `force-dynamic`).
- **Modify:** `packages/web/src/components/topbar.tsx` — add "Métricas" tab.
- **Create:** `packages/web/tests/unit/components/metrics-kpis.test.tsx`, `metrics-empty.test.tsx`.

All `bun test` for web runs **from `packages/web`** (alias `@/*`). Recharts renders need a DOM — tests assert on data/empty-state text, not SVG geometry.

---

### Task 6: Recharts dependency + query hook

**Files:**
- Modify: `packages/web/package.json`
- Create: `packages/web/src/lib/queries/metrics.ts`

- [ ] **Step 1: Add recharts**

Add to `packages/web/package.json` `dependencies` (alphabetical order near `react`): `"recharts": "2.13.3",`. Then run `bun install` from repo root.
Run: `bun install`
Expected: lockfile updated, recharts resolved, no peer-dep errors (recharts 2.x supports React 18).

- [ ] **Step 2: Create the hook**

Create `packages/web/src/lib/queries/metrics.ts` (mirror `lib/queries/persons.ts`):

```typescript
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { MetricsOverview } from "@vipcam/shared";
import { apiFetch } from "../api-client";

export function useMetricsOverview(days: 7 | 30) {
  return useQuery<MetricsOverview>({
    queryKey: ["metrics", "overview", days],
    queryFn: ({ signal }) =>
      apiFetch<MetricsOverview>(`/api/metrics/overview?days=${days}`, { signal }),
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: exit 0, 3/3.

- [ ] **Step 4: Commit**

```bash
# run from repo root; lockfile is text `bun.lock` at root (NOT bun.lockb)
git add packages/web/package.json bun.lock packages/web/src/lib/queries/metrics.ts
git commit -m "$(cat <<'EOF'
feat(web): Onda 5 — recharts dep + useMetricsOverview hook

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Chart components (KPIs, visits flow, peak heatmap, recurrence donut, sentiment bars)

**Files:**
- Create: 5 files under `packages/web/src/components/metrics/`
- Test: `packages/web/tests/unit/components/metrics-kpis.test.tsx`, `metrics-empty.test.tsx`

Each component: `props -> render`, explicit empty state, no data fetching (page passes data in). Recharts wrappers use `ResponsiveContainer`.

- [ ] **Step 1: Write the failing component tests**

Create `packages/web/tests/unit/components/metrics-kpis.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import * as React from "react";
import type { MetricsOverview } from "@vipcam/shared";
import { MetricKpis } from "../../../src/components/metrics/metric-kpis";

const data: MetricsOverview = {
  days: 7,
  visits: { points: [{ date: "2026-05-10", count: 10 }, { date: "2026-05-11", count: 20 }], trend: { slope: 1, direction: "up" } },
  peak: { cells: [] },
  recurrence: { new_count: 3, returning_count: 7, identified_visits: 10, total_visits: 30 },
  sentiment: { buckets: [{ emotion: "happy", count: 12 }, { emotion: "n/d", count: 1 }] },
};

describe("MetricKpis", () => {
  test("mostra total de visitas e % recorrentes", () => {
    render(<MetricKpis data={data} />);
    expect(screen.getByText("30")).toBeDefined(); // total visits
    expect(screen.getByText(/70%/)).toBeDefined(); // recorrentes 7/10
  });
});
```

Create `packages/web/tests/unit/components/metrics-empty.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import * as React from "react";
import { VisitsFlowChart } from "../../../src/components/metrics/visits-flow-chart";
import { RecurrenceDonut } from "../../../src/components/metrics/recurrence-donut";

describe("estados vazios", () => {
  test("VisitsFlowChart sem pontos mostra mensagem", () => {
    render(<VisitsFlowChart points={[]} trend={{ slope: 0, direction: "flat" }} />);
    expect(screen.getByText(/sem dados/i)).toBeDefined();
  });
  test("RecurrenceDonut sem identificados mostra mensagem dedicada", () => {
    render(
      <RecurrenceDonut data={{ new_count: 0, returning_count: 0, identified_visits: 0, total_visits: 12 }} />,
    );
    expect(screen.getByText(/sem clientes identificados/i)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd packages/web && bun test tests/unit/components/metrics-kpis.test.tsx tests/unit/components/metrics-empty.test.tsx`
Expected: FAIL — component modules not found.

- [ ] **Step 3: Implement the 5 components**

Create `packages/web/src/components/metrics/metric-kpis.tsx`:

```tsx
import type { MetricsOverview } from "@vipcam/shared";

export function MetricKpis({ data }: { data: MetricsOverview }) {
  const total = data.recurrence.total_visits;
  const avgPerDay = data.visits.points.length
    ? Math.round(total / data.visits.points.length)
    : 0;
  const idv = data.recurrence.identified_visits;
  const pctReturning = idv > 0 ? Math.round((data.recurrence.returning_count / idv) * 100) : 0;
  const topEmotion = [...data.sentiment.buckets].sort((a, b) => b.count - a.count)[0]?.emotion ?? "—";
  const Card = ({ label, value }: { label: string; value: string }) => (
    <div className="flex-1 rounded-md border bg-white p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
    </div>
  );
  return (
    <div className="flex gap-3">
      <Card label="Visitas no período" value={String(total)} />
      <Card label="Média/dia" value={String(avgPerDay)} />
      <Card label="Recorrentes" value={`${pctReturning}%`} />
      <Card label="Emoção predominante" value={topEmotion} />
    </div>
  );
}
```

Create `packages/web/src/components/metrics/visits-flow-chart.tsx`:

```tsx
import type { VisitsFlowPoint } from "@vipcam/shared";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export function VisitsFlowChart({
  points,
  trend,
}: {
  points: VisitsFlowPoint[];
  trend: { slope: number; direction: "up" | "down" | "flat" };
}) {
  if (points.length === 0) {
    return <div className="text-slate-500 italic p-8 text-center">Sem dados no período</div>;
  }
  const arrow = trend.direction === "up" ? "▲" : trend.direction === "down" ? "▼" : "—";
  return (
    <div className="rounded-md border bg-white p-3">
      <div className="flex justify-between mb-2">
        <h3 className="font-semibold text-slate-700">Fluxo de visitas</h3>
        <span className="text-sm text-slate-500">tendência {arrow}</span>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={points}>
          <XAxis dataKey="date" fontSize={11} />
          <YAxis allowDecimals={false} fontSize={11} />
          <Tooltip />
          <Area type="monotone" dataKey="count" stroke="#0f172a" fill="#cbd5e1" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
```

Create `packages/web/src/components/metrics/peak-hours-heatmap.tsx`:

```tsx
import type { PeakHourCell } from "@vipcam/shared";

const DOW = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

export function PeakHoursHeatmap({ cells }: { cells: PeakHourCell[] }) {
  if (cells.length === 0) {
    return <div className="text-slate-500 italic p-8 text-center">Sem dados no período</div>;
  }
  const max = Math.max(...cells.map((c) => c.count), 1);
  const at = (w: number, h: number) => cells.find((c) => c.weekday === w && c.hour === h)?.count ?? 0;
  const hours = Array.from({ length: 24 }, (_, h) => h);
  return (
    <div className="rounded-md border bg-white p-3 overflow-x-auto">
      <h3 className="font-semibold text-slate-700 mb-2">Horários de pico</h3>
      <table className="text-[10px] border-collapse">
        <tbody>
          {DOW.map((label, w) => (
            <tr key={label}>
              <td className="pr-1 text-slate-500">{label}</td>
              {hours.map((h) => {
                const v = at(w, h);
                const alpha = v / max;
                return (
                  <td
                    key={h}
                    title={`${label} ${h}h: ${v}`}
                    style={{ background: `rgba(15,23,42,${alpha})`, width: 14, height: 14 }}
                  />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

Create `packages/web/src/components/metrics/recurrence-donut.tsx`:

```tsx
import type { RecurrenceBreakdown } from "@vipcam/shared";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

export function RecurrenceDonut({ data }: { data: RecurrenceBreakdown }) {
  if (data.identified_visits === 0) {
    return (
      <div className="rounded-md border bg-white p-3">
        <h3 className="font-semibold text-slate-700 mb-2">Recorrência</h3>
        <div className="text-slate-500 italic p-6 text-center">
          Sem clientes identificados no período
        </div>
      </div>
    );
  }
  const pie = [
    { name: "Novos", value: data.new_count },
    { name: "Recorrentes", value: data.returning_count },
  ];
  const colors = ["#94a3b8", "#0f172a"];
  const pct = Math.round((data.identified_visits / Math.max(data.total_visits, 1)) * 100);
  return (
    <div className="rounded-md border bg-white p-3">
      <h3 className="font-semibold text-slate-700 mb-1">Recorrência</h3>
      <ResponsiveContainer width="100%" height={160}>
        <PieChart>
          <Pie data={pie} dataKey="value" innerRadius={40} outerRadius={60}>
            {pie.map((_, i) => (
              <Cell key={i} fill={colors[i]} />
            ))}
          </Pie>
          <Tooltip />
        </PieChart>
      </ResponsiveContainer>
      <div className="text-xs text-slate-500 text-center">
        base: {data.identified_visits} de {data.total_visits} visitas identificadas ({pct}%)
      </div>
    </div>
  );
}
```

Create `packages/web/src/components/metrics/sentiment-bars.tsx`:

```tsx
import type { SentimentBucket } from "@vipcam/shared";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export function SentimentBars({ buckets }: { buckets: SentimentBucket[] }) {
  if (buckets.length === 0) {
    return <div className="text-slate-500 italic p-8 text-center">Sem dados no período</div>;
  }
  return (
    <div className="rounded-md border bg-white p-3">
      <h3 className="font-semibold text-slate-700 mb-2">Sentimento</h3>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={buckets} layout="vertical">
          <XAxis type="number" allowDecimals={false} fontSize={11} />
          <YAxis type="category" dataKey="emotion" fontSize={11} width={60} />
          <Tooltip />
          <Bar dataKey="count" fill="#0f172a" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 4: Run component tests — PASS**

Run: `cd packages/web && bun test tests/unit/components/metrics-kpis.test.tsx tests/unit/components/metrics-empty.test.tsx`
Expected: PASS. If Recharts throws under happy-dom for the non-empty render path, the empty-state tests (no Recharts) must still pass; for KPIs (no Recharts) must pass. Keep assertions on text, not SVG. If a Recharts component needs a fixed-size container to render under jsdom/happy-dom, wrap `ResponsiveContainer` usage so tests target empty-state and KPIs only (those exercise no Recharts) — do not assert chart internals.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/metrics packages/web/tests/unit/components/metrics-kpis.test.tsx packages/web/tests/unit/components/metrics-empty.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): Onda 5 — metrics chart components (KPIs, flow, heatmap, donut, bars)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `/metrics` page (layout B) + topbar link

**Files:**
- Create: `packages/web/src/app/metrics/page.tsx`
- Modify: `packages/web/src/components/topbar.tsx`

Layout **B**: KPIs strip → Fluxo hero (full width) → row of peak/recurrence/sentiment. `force-dynamic` (same as `/people`, `/live` — env at runtime). 7d/30d toggle via local state.

- [ ] **Step 1: Create the page**

Create `packages/web/src/app/metrics/page.tsx`:

```tsx
"use client";

import { MetricKpis } from "@/components/metrics/metric-kpis";
import { PeakHoursHeatmap } from "@/components/metrics/peak-hours-heatmap";
import { RecurrenceDonut } from "@/components/metrics/recurrence-donut";
import { SentimentBars } from "@/components/metrics/sentiment-bars";
import { VisitsFlowChart } from "@/components/metrics/visits-flow-chart";
import { Skeleton } from "@/components/ui/skeleton";
import { useMetricsOverview } from "@/lib/queries/metrics";
import { useState } from "react";

export const dynamic = "force-dynamic";

export default function MetricsPage() {
  const [days, setDays] = useState<7 | 30>(7);
  const { data, isLoading, error } = useMetricsOverview(days);

  return (
    <div className="container mx-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Métricas</h1>
        <div className="flex gap-1">
          {([7, 30] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-3 py-1 text-sm rounded ${days === d ? "bg-slate-900 text-white" : "bg-slate-100"}`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="text-red-600">Erro ao carregar métricas.</div>
      ) : isLoading || !data ? (
        <Skeleton className="h-96" />
      ) : (
        <div className="space-y-4">
          <MetricKpis data={data} />
          <VisitsFlowChart points={data.visits.points} trend={data.visits.trend} />
          <div className="grid grid-cols-3 gap-4">
            <PeakHoursHeatmap cells={data.peak.cells} />
            <RecurrenceDonut data={data.recurrence} />
            <SentimentBars buckets={data.sentiment.buckets} />
          </div>
        </div>
      )}
    </div>
  );
}
```

> Verify `@/components/ui/skeleton` exists (used by `/people/[id]`). If the error-state needs a retry button per spec §5, add a button calling React Query `refetch()` (destructure it from the hook) — keep it minimal.

- [ ] **Step 2: Add topbar tab**

In `packages/web/src/components/topbar.tsx`: import `BarChart3` from `lucide-react` (add to the existing `lucide-react` import line alongside `Activity, AlertCircle, Users`). Add to the `TABS` array:

```tsx
  { href: "/metrics" as Route, label: "Métricas", icon: BarChart3 },
```

(place after the Matches entry).

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: exit 0, 3/3.

- [ ] **Step 4: Topbar test still green + build**

Run: `cd packages/web && bun test tests/unit/components/topbar.test.tsx`
Expected: PASS (the existing test should tolerate an added tab; if it asserts an exact tab count, update that assertion to include "Métricas" — that is an expected, in-scope change).

Run: `cd packages/web && bun run build`
Expected: Next build succeeds; `/metrics` listed as a route (ƒ dynamic). This is the definitive integration check (resolves `@/components/metrics/*`, `@vipcam/shared`, recharts bundling).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/app/metrics/page.tsx packages/web/src/components/topbar.tsx packages/web/tests/unit/components/topbar.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): Onda 5 — /metrics page (layout B) + topbar link

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Final verification + branch finish

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck**

Run: `bun run typecheck` → exit 0, 3/3.

- [ ] **Step 2: Lint**

Run: `bun run lint` → no NEW errors vs the known pre-existing baseline (1 warning in `listener-stream.test.ts`, untouched). If biome flags new issues in Onda 5 files, apply `bunx biome check --write` to the specific new files and re-verify (behavior-preserving), then commit as a `style(...)` commit.

- [ ] **Step 3: Offline test suites**

Run: `cd packages/edge && bun test tests/unit` → pass.
Run: `cd packages/web && bun test` → pass.
Run: `cd packages/web && bun run build` → success.
Note: edge integration tests (metrics-queries, plus prior DB suites) error on DB bootstrap with no local Postgres — accepted; flag in summary that `metrics-queries.test.ts` must run where `vipcam_test` exists before merge.

- [ ] **Step 4: Finish the branch**

Use **superpowers:finishing-a-development-branch**. Merge summary must list: validations run offline (typecheck 3/3, lint, edge+web unit suites, next build) vs deferred (edge integration tests need Postgres; operational deploy needs VPS — same as Onda 4).

---

## Operational follow-up (NOT code — when DB/VPS available)

1. Run `cd packages/edge && bun test tests/integration/api/metrics-queries.test.ts` where Postgres `vipcam_test` exists; confirm 4/4.
2. Set `METRICS_TZ` in `/etc/vipcam/edge.env` if a non-default TZ is ever needed (default `America/Sao_Paulo` is correct for the current unit).
3. Smoke: `curl -s "https://<domain>/api/metrics/overview?days=7" -H "X-API-Key: …"` returns the 4 blocks.
