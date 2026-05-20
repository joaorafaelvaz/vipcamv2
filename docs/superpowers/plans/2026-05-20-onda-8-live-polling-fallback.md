# Onda 8 — `/live` Polling-Only Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken SSE-based `/live` feed with a DB-backed polling endpoint + React Query hook, removing all stream code from the project.

**Architecture:** New edge endpoint `GET /api/events/recent?limit=50` returns the existing `LiveDetectionEvent[]` shape (zero shared-type changes) via a Drizzle query that mirrors `dashboard.queries.ts`. Web replaces `useSse` with a `useRecentDetections` React Query hook (3 s interval, pauses when tab is hidden). The streamSSE route, `useSse` hook + test, and `allowQueryOn` middleware option are deleted. The `event-bus` + its `publish()` calls in the ingest pipeline stay dormant (zero-cost, future-use).

**Tech Stack:** Bun + Hono + Drizzle + PostgreSQL (edge), Next.js 14 + React Query (web), Zod-free (route does manual `limit` validation in line with prior routes).

**Spec:** `docs/superpowers/specs/2026-05-20-onda-8-live-polling-fallback-design.md` (spec-reviewer approved, commit `c10d098`).

**Branch:** `onda-8-live-polling`.

**Environment note (offline dev):** No local Postgres (Docker off here). Offline gates: `bun run typecheck` (3/3 — hard), pure/route unit suites (no DB), `bun run lint` clean, `cd packages/web && bun run build`. The single new **edge integration test** (`events-recent.test.ts`) requires `vipcam_test` Postgres — same accepted fallback as Onda 4/5/6: write it, confirm it fails for the right reason (missing module first; DB errors later), `bun run typecheck` is the hard gate, commit, flag in the final summary that DB integration must be run where Postgres exists before merge. Do NOT weaken tests.

---

## Chunk 1: Onda 8 — full implementation (single coherent chunk, ≤1000 lines)

### File Structure

- **Create** `packages/edge/src/api/events.queries.ts` — `recentDetections(db, limit) → Promise<LiveDetectionEvent[]>`. Pure over `db`. Single responsibility: DB query + map to shared shape.
- **Rewrite** `packages/edge/src/api/routes/events.ts` — `createEventsRoutes(deps)` now exposes only `GET /recent`; `subscribe`/`heartbeatMs` + `streamSSE` handler **deleted**.
- **Rewrite** `packages/edge/tests/unit/api/routes/events.test.ts` — old SSE tests replaced with `GET /recent` tests (mock deps).
- **Create** `packages/edge/tests/integration/api/events-recent.test.ts` — Postgres integration test for `recentDetections` (DB-deferred per env note).
- **Modify** `packages/edge/src/api/server.ts` — drop `allowQueryOn` option; rewire `createEventsRoutes` deps to `{ recent: (limit) => recentDetections(getDb(), limit) }`.
- **Create** `packages/web/src/lib/queries/events.ts` — `useRecentDetections({limit,intervalMs,enabled})` hook.
- **Modify** `packages/web/src/components/live-feed.tsx` — replace `useSse` block with `useRecentDetections`. Strip client-side ring buffer.
- **Create** `packages/web/tests/unit/lib/queries-events.test.ts` — hook test with fake timers + visibility mock.
- **Create** `packages/web/tests/unit/components/live-feed-polling.test.tsx` — component test with mocked hook.
- **DELETE** `packages/web/src/hooks/use-sse.ts`.
- **DELETE** `packages/web/tests/unit/hooks/use-sse.test.ts`.

`event-bus.ts` + its `publish()` calls in `packages/edge/src/ingest/pipeline.ts` are **NOT touched** (per spec — dormant, future-use).

---

### Task 1: Edge — `recentDetections` query module (TDD)

**Files:**
- Create: `packages/edge/src/api/events.queries.ts`
- Test: `packages/edge/tests/integration/api/events-recent.test.ts`

Mirrors `packages/edge/src/api/dashboard.queries.ts` pattern: `getDb()`, Drizzle, plain SQL. The query is a LEFT JOIN of `detections` → `persons`. Maps each row to the existing `LiveDetectionEvent` shape (envelope `{type:"detection", detection, person}` per item — **not** a flat `DetectionThumbnail[]`; preserves SSE parity).

- [ ] **Step 1: Write the failing integration test**

Create `packages/edge/tests/integration/api/events-recent.test.ts`:

```typescript
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { recentDetections } from "../../../src/api/events.queries.js";
import { closeDb, getDb } from "../../../src/persistence/db.js";
import {
  camerasRepo,
  detectionsRepo,
  personsRepo,
  sessionsRepo,
} from "../../../src/persistence/repositories/index.js";
import { persons } from "../../../src/persistence/schema/persons.js";
import { truncateAll } from "../persistence/_helpers.js";

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await closeDb();
});

describe("recentDetections (Onda 8)", () => {
  test("empty DB → []", async () => {
    expect(await recentDetections(50)).toEqual([]);
  });

  test("returns LiveDetectionEvent envelope per row, DESC by detected_at", async () => {
    const cam = await camerasRepo.create({ name: "c", ip_address: "10.0.0.1" });
    const sess = await sessionsRepo.create({
      camera_id: cam.id,
      started_at: new Date("2026-05-20T14:00:00Z"),
      last_seen_at: new Date("2026-05-20T14:00:00Z"),
      detection_count: 1,
    });
    // Older anônima
    await detectionsRepo.create({
      camera_id: cam.id,
      session_id: sess.id,
      detected_at: new Date("2026-05-20T14:00:00Z"),
      raw_event: {},
      face_attrs: { age: 30 },
    });
    // Newer com cliente identificado
    const person = await personsRepo.create({
      display_name: "Cliente A",
      person_type: "client",
      erp_client_id: "cli-A",
    });
    const dNew = await detectionsRepo.create({
      camera_id: cam.id,
      session_id: sess.id,
      detected_at: new Date("2026-05-20T15:00:00Z"),
      raw_event: {},
      face_attrs: { age: 40 },
    });
    await detectionsRepo.linkToPerson(dNew.id, person.id); // helper de Onda 1/2

    const out = await recentDetections(50);
    expect(out).toHaveLength(2);
    // Envelope check
    expect(out[0]!.type).toBe("detection");
    expect(out[0]!.detection).toBeDefined();
    // Order DESC by detected_at — newest (15:00) first
    expect(new Date(out[0]!.detection.detected_at).getTime()).toBeGreaterThan(
      new Date(out[1]!.detection.detected_at).getTime(),
    );
    // Identified row has person populated
    expect(out[0]!.person).not.toBeNull();
    expect(out[0]!.person?.display_name).toBe("Cliente A");
    expect(out[0]!.person?.person_type).toBe("client");
    // Anônima has person:null
    expect(out[1]!.person).toBeNull();
  });

  test("limit honored (cap responsibility lives in the route; query honors what is passed)", async () => {
    const cam = await camerasRepo.create({ name: "c2", ip_address: "10.0.0.2" });
    const sess = await sessionsRepo.create({
      camera_id: cam.id,
      started_at: new Date("2026-05-20T13:00:00Z"),
      last_seen_at: new Date("2026-05-20T13:00:00Z"),
      detection_count: 1,
    });
    for (let i = 0; i < 5; i++) {
      await detectionsRepo.create({
        camera_id: cam.id,
        session_id: sess.id,
        detected_at: new Date(`2026-05-20T13:0${i}:00Z`),
        raw_event: {},
        face_attrs: {},
      });
    }
    const out = await recentDetections(3);
    expect(out).toHaveLength(3);
  });

  test("person deleted (ON DELETE SET NULL) → person:null in response", async () => {
    const cam = await camerasRepo.create({ name: "c3", ip_address: "10.0.0.3" });
    const sess = await sessionsRepo.create({
      camera_id: cam.id,
      started_at: new Date("2026-05-20T12:00:00Z"),
      last_seen_at: new Date("2026-05-20T12:00:00Z"),
      detection_count: 1,
    });
    const person = await personsRepo.create({
      display_name: "Temp",
      person_type: "client",
      erp_client_id: "cli-T",
    });
    const det = await detectionsRepo.create({
      camera_id: cam.id,
      session_id: sess.id,
      detected_at: new Date("2026-05-20T12:00:00Z"),
      raw_event: {},
      face_attrs: {},
    });
    await detectionsRepo.linkToPerson(det.id, person.id);
    // Delete the person via Drizzle direto — personsRepo NÃO expõe delete()
    // (só create/update/incrementVisitCount/find* — verificado contra
    // persons.repo.ts). detections.person_id é ON DELETE SET NULL no schema.
    await getDb().delete(persons).where(eq(persons.id, person.id));
    const out = await recentDetections(10);
    expect(out).toHaveLength(1);
    expect(out[0]!.person).toBeNull();
  });
});
```

> Helpers confirmados contra a fonte: `detectionsRepo.linkToPerson(detectionId, personId)` ✓ existe (`detections.repo.ts:32`). `personsRepo.delete` **não existe** — não invente; use Drizzle direto como mostrado acima (`getDb().delete(persons).where(eq(persons.id, ...))`). `camerasRepo.create`, `sessionsRepo.create`, `detectionsRepo.create`, `personsRepo.create` ✓ são os já usados nos testes de integração de Ondas 4/5/6.

- [ ] **Step 2: Run, expect FAIL for the right reason**

Run: `cd packages/edge && bun test tests/integration/api/events-recent.test.ts`
Expected: FAIL — `Cannot find module '../../../src/api/events.queries.js'` (module-not-found). If you see a DB connection error first (no local Postgres), that confirms the env constraint — proceed per the Environment note (the typecheck is the hard gate locally; DB run is VPS-deferred).

- [ ] **Step 3: Implement `packages/edge/src/api/events.queries.ts`**

```typescript
import type { LiveDetectionEvent } from "@vipcam/shared";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../persistence/db.js";
import { detections } from "../persistence/schema/detections.js";
import { erpClients } from "../persistence/schema/erp-cache.js";
import { persons } from "../persistence/schema/persons.js";

/**
 * Últimas N detecções enriquecidas com a Person correspondente (LEFT JOIN —
 * detecções anônimas vêm com person: null). Substitui o stream SSE do /live
 * por polling autoritativo do DB. (Onda 8.)
 *
 * Espelha o padrão de dashboard.queries.ts (getDb dentro) + listWithFilters
 * do persons.repo.ts (LEFT JOIN persons+erp_clients para sourcing de
 * photo_path/phone). Sem filtros por tipo (inclui anônimos + funcionários +
 * clientes — paridade com SSE). Cap de `limit` é responsabilidade da rota.
 */
export async function recentDetections(limit: number): Promise<LiveDetectionEvent[]> {
  const db = getDb();
  const rows = await db
    .select({
      // detection fields
      d_id: detections.id,
      d_detected_at: detections.detected_at,
      d_snapshot_path: detections.snapshot_path,
      d_face_attrs: detections.face_attrs,
      d_dominant_emotion: detections.dominant_emotion,
      d_emotion_confidence: detections.emotion_confidence,
      d_session_id: detections.session_id,
      d_camera_id: detections.camera_id,
      // person fields (todos nullable via LEFT JOIN)
      p_id: persons.id,
      p_display_name: persons.display_name,
      p_person_type: persons.person_type,
      // PersonSummary.photo_path = persons.thumbnail_path (apelido — coluna
      // real chama thumbnail_path; ver persons.repo.ts:88-99 listWithFilters)
      p_photo_path: persons.thumbnail_path,
      p_last_seen_at: persons.last_seen_at, // notNull no schema, mas LEFT JOIN o torna nullable
      p_total_visits: persons.total_visits, // idem
      p_erp_client_id: persons.erp_client_id,
      p_erp_employee_id: persons.erp_employee_id,
      // PersonSummary.phone vem de erp_clients (persons não tem phone);
      // LEFT JOIN persons→erp_clients via erp_client_id pode render null.
      p_phone: erpClients.phone,
    })
    .from(detections)
    .leftJoin(persons, eq(persons.id, detections.person_id))
    .leftJoin(erpClients, eq(erpClients.erp_id, persons.erp_client_id))
    .orderBy(desc(detections.detected_at), desc(detections.id))
    .limit(limit);

  return rows.map((r) => ({
    type: "detection" as const,
    detection: {
      id: r.d_id,
      detected_at: r.d_detected_at.toISOString(),
      snapshot_path: r.d_snapshot_path,
      face_attrs: (r.d_face_attrs ?? {}) as Record<string, unknown>,
      dominant_emotion: r.d_dominant_emotion,
      emotion_confidence: r.d_emotion_confidence,
      session_id: r.d_session_id,
      camera_id: r.d_camera_id,
    },
    person: r.p_id
      ? {
          id: r.p_id,
          display_name: r.p_display_name,
          person_type: r.p_person_type,
          photo_path: r.p_photo_path,
          last_seen_at: r.p_last_seen_at ? r.p_last_seen_at.toISOString() : null,
          total_visits: r.p_total_visits ?? 0,
          erp_client_id: r.p_erp_client_id,
          erp_employee_id: r.p_erp_employee_id,
          phone: r.p_phone,
        }
      : null,
  }));
}
```

> Field-mapping confirmados contra a fonte: `persons` **não tem** `photo_path` (é `thumbnail_path`) e **não tem** `phone` (vive em `erp_clients.phone` via `persons.erp_client_id → erp_clients.erp_id`). O mapeamento acima espelha `persons.repo.ts:88-99` (`listWithFilters`) — mesma topologia de joins, mesma renomeação. `last_seen_at` e `total_visits` SÃO colunas (NOT NULL com default), só ficam nullable porque o LEFT JOIN com `persons` rende null inteiro quando a detecção é anônima.

- [ ] **Step 4: Run integration test (expect PASS or documented DB-skip)**

Run: `cd packages/edge && bun test tests/integration/api/events-recent.test.ts`
Expected: PASS (4/4) where Postgres `vipcam_test` exists. Locally without DB → fails on env/DB bootstrap only; do not modify the test.

- [ ] **Step 5: `bun run typecheck` — hard gate**

Run: `bun run typecheck`
Expected: exit 0, 3/3 (shared/web/edge).

- [ ] **Step 6: Commit**

```bash
git add packages/edge/src/api/events.queries.ts packages/edge/tests/integration/api/events-recent.test.ts
git commit -m "$(cat <<'EOF'
feat(edge): Onda 8 — recentDetections query (DB-backed /live source)

Drizzle LEFT JOIN detections+persons, ORDER BY detected_at DESC, LIMIT.
Returns LiveDetectionEvent[] (envelope per row — paridade com SSE).
Mirrors dashboard.queries.ts pattern.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Edge — rewrite `routes/events.ts` (TDD)

**Files:**
- Modify (rewrite): `packages/edge/src/api/routes/events.ts`
- Modify (rewrite): `packages/edge/tests/unit/api/routes/events.test.ts`

Replaces the old SSE handler with a `GET /recent` handler. The old `EventsDeps {subscribe, heartbeatMs}` becomes `EventsDeps {recent}`. No DB here — pure Hono + limit validation + delegate to `deps.recent`.

- [ ] **Step 1: Write the failing tests (replace the old SSE tests entirely)**

Replace the entire contents of `packages/edge/tests/unit/api/routes/events.test.ts` with:

```typescript
import { describe, expect, test } from "bun:test";
import type { LiveDetectionEvent } from "@vipcam/shared";
import { createEventsRoutes } from "../../../../src/api/routes/events.js";

const fakeEvent: LiveDetectionEvent = {
  type: "detection",
  detection: {
    id: "00000000-0000-0000-0000-000000000001",
    detected_at: "2026-05-20T15:00:00Z",
    snapshot_path: null,
    face_attrs: {},
    dominant_emotion: null,
    emotion_confidence: null,
    session_id: null,
    camera_id: "00000000-0000-0000-0000-000000000099",
  },
  person: null,
};

function app(recent: (limit: number) => Promise<LiveDetectionEvent[]>) {
  return createEventsRoutes({ recent });
}

describe("createEventsRoutes GET /recent", () => {
  test("default limit=50 honored, calls deps.recent, returns array", async () => {
    let received: number | undefined;
    const r = await app(async (limit) => {
      received = limit;
      return [fakeEvent];
    }).request("/recent");
    expect(r.status).toBe(200);
    expect(received).toBe(50);
    expect(await r.json()).toEqual([fakeEvent]);
  });

  test("limit=1 boundary OK", async () => {
    let received: number | undefined;
    const r = await app(async (l) => {
      received = l;
      return [];
    }).request("/recent?limit=1");
    expect(r.status).toBe(200);
    expect(received).toBe(1);
  });

  test("limit=200 boundary OK", async () => {
    let received: number | undefined;
    const r = await app(async (l) => {
      received = l;
      return [];
    }).request("/recent?limit=200");
    expect(r.status).toBe(200);
    expect(received).toBe(200);
  });

  test.each([
    ["0", 400],
    ["201", 400],
    ["-5", 400],
    ["abc", 400],
    ["1.5", 400],
  ])("invalid limit=%s → %d", async (raw, expectedStatus) => {
    const r = await app(async () => []).request(`/recent?limit=${raw}`);
    expect(r.status).toBe(expectedStatus);
    const body = (await r.json()) as { error?: string };
    expect(body.error).toContain("limit");
  });

  test("returns [] when deps.recent returns []", async () => {
    const r = await app(async () => []).request("/recent");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd packages/edge && bun test tests/unit/api/routes/events.test.ts`
Expected: FAIL — either compile errors (the new test uses a fn signature the old route doesn't expose: `createEventsRoutes({recent})`), or runtime failures because `/recent` doesn't exist yet.

- [ ] **Step 3: Rewrite `packages/edge/src/api/routes/events.ts` (replace entire contents)**

```typescript
import type { LiveDetectionEvent } from "@vipcam/shared";
import { Hono } from "hono";

export interface EventsDeps {
  /** Últimas N detecções enriquecidas, em ordem DESC por detected_at. */
  recent: (limit: number) => Promise<LiveDetectionEvent[]>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Endpoints REST do /live (Onda 8 — polling-only).
 *
 * GET /recent?limit=N  →  LiveDetectionEvent[]  (envelope por item, DESC por
 * detected_at, default 50, cap 200). Substitui o antigo /stream (SSE) que
 * era inconsertável sob nginx HTTP/2 (ver onda 8 spec §2 e relatório
 * 2026-05-19/20). Auth via apiKeyMiddleware aplicado em /api/events/* no
 * server.ts (header X-API-Key normal — sem allowQueryOn).
 */
export function createEventsRoutes(deps: EventsDeps): Hono {
  const r = new Hono();
  r.get("/recent", async (c) => {
    const raw = c.req.query("limit");
    let limit: number = DEFAULT_LIMIT;
    if (raw !== undefined) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
        return c.json({ error: `limit must be 1..${MAX_LIMIT}` }, 400);
      }
      limit = n;
    }
    return c.json(await deps.recent(limit));
  });
  return r;
}
```

- [ ] **Step 4: Run, expect PASS (7/7)**

Run: `cd packages/edge && bun test tests/unit/api/routes/events.test.ts`
Expected: PASS — default, 1/200 boundaries, 0/201/-5/abc/1.5 → 400, empty array OK.

- [ ] **Step 5: `bun run typecheck` 3/3, then commit**

```bash
git add packages/edge/src/api/routes/events.ts packages/edge/tests/unit/api/routes/events.test.ts
git commit -m "$(cat <<'EOF'
feat(edge): Onda 8 — rewrite events route as GET /recent (drops SSE)

EventsDeps now {recent}; streamSSE handler + subscribe/heartbeatMs removed.
Manual limit validation (1..200, default 50, invalid → 400). Auth segue
via requireKey no /api/events/* (header X-API-Key padrão).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Edge — wire `server.ts` (drop `allowQueryOn`, rewire deps)

**Files:**
- Modify: `packages/edge/src/api/server.ts` (grep-anchored — line numbers shifted across waves)

- [ ] **Step 1: Find anchors (read-only)**

In `packages/edge/src/api/server.ts`, grep for:
- `apiKeyMiddleware(` — the call that currently includes `{ allowQueryOn: "/api/events/stream" }`.
- `createEventsRoutes(` — currently wired with `{ subscribe: ..., heartbeatMs: ... }`.

- [ ] **Step 2: Edit**

Change the `apiKeyMiddleware` call from (something like):
```typescript
const requireKey = apiKeyMiddleware(env.API_KEY, { allowQueryOn: "/api/events/stream" });
```
to:
```typescript
const requireKey = apiKeyMiddleware(env.API_KEY);
```
(The `ApiKeyMiddlewareOptions = {}` default makes the options object optional — verified in `middleware/api-key.ts`. No other config keys are in use.)

Change the `createEventsRoutes` mount from (something like):
```typescript
app.route(
  "/api/events",
  createEventsRoutes({
    subscribe: eventBus.subscribe,
    heartbeatMs: 15_000,
  }),
);
```
to:
```typescript
import { recentDetections } from "./events.queries.js";
// ...
app.route(
  "/api/events",
  createEventsRoutes({ recent: (limit) => recentDetections(limit) }),
);
```
Add the `import` near the other `./*.queries.js` imports (e.g., `./dashboard.queries.js`, `./metrics.queries.js`).

**Do NOT** remove the `eventBus` import or its `publish()` consumers in the ingest pipeline — per spec, the event-bus stays dormant. If `eventBus` is now unused in `server.ts` itself (it was only referenced by the old `subscribe`), the `import { eventBus } from "./events/event-bus.js";` line in `server.ts` becomes unused — **only then** remove that one import line. Verify with grep before removing.

- [ ] **Step 3: Typecheck + full edge unit suites**

Run: `bun run typecheck` → exit 0, 3/3.
Run: `cd packages/edge && bun test tests/unit` → all pass. The new `events.test.ts` is green (Task 2); existing suites must remain green (this task only touches wiring + drops one option).

- [ ] **Step 4: Commit**

```bash
git add packages/edge/src/api/server.ts
git commit -m "$(cat <<'EOF'
feat(edge): Onda 8 — wire GET /api/events/recent + drop allowQueryOn

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Web — `useRecentDetections` hook (TDD)

**Files:**
- Create: `packages/web/src/lib/queries/events.ts`
- Test: `packages/web/tests/unit/lib/queries-events.test.ts`

Mirrors `packages/web/src/lib/queries/persons.ts` (React Query + `apiFetch`). Adds `refetchInterval`, `refetchIntervalInBackground:false`, `enabled`-aware polling.

Reference: bun-test happy-dom pattern lives in `packages/web/tests/unit/components/visit-card.test.tsx` (see how `mock.module("../../../src/lib/api-client", ...)` is used). For React Query in tests we need a fresh `QueryClient` per test, wrapped in `QueryClientProvider`.

- [ ] **Step 1: Write the failing test**

Create `packages/web/tests/unit/lib/queries-events.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import type { LiveDetectionEvent } from "@vipcam/shared";

// Mock apiFetch BEFORE importing the hook.
let fetchCalls = 0;
let returnRows: LiveDetectionEvent[] = [];
mock.module("../../../src/lib/api-client", () => ({
  apiFetch: async () => {
    fetchCalls += 1;
    return returnRows;
  },
  snapshotUrl: () => null,
  ApiError: class extends Error {},
}));

// Import AFTER the mock.
import { useRecentDetections } from "../../../src/lib/queries/events";

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function Probe({ enabled, intervalMs }: { enabled: boolean; intervalMs: number }) {
  const q = useRecentDetections({ limit: 10, intervalMs, enabled });
  return <div data-testid="count">{q.data?.length ?? 0}</div>;
}

beforeEach(() => {
  fetchCalls = 0;
  returnRows = [];
});
afterEach(() => {
  // restore visibility
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

describe("useRecentDetections", () => {
  test("initial fetch + renders array length", async () => {
    returnRows = [
      { type: "detection", detection: { id: "a", detected_at: "t", snapshot_path: null,
        face_attrs: {}, dominant_emotion: null, emotion_confidence: null,
        session_id: null, camera_id: "c" }, person: null },
    ];
    const qc = makeClient();
    render(
      <QueryClientProvider client={qc}>
        <Probe enabled={true} intervalMs={1000} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("1"));
    expect(fetchCalls).toBe(1);
  });

  test("polls at intervalMs when enabled", async () => {
    returnRows = [];
    const qc = makeClient();
    render(
      <QueryClientProvider client={qc}>
        <Probe enabled={true} intervalMs={50} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(fetchCalls).toBeGreaterThanOrEqual(1));
    const a = fetchCalls;
    await new Promise((r) => setTimeout(r, 130)); // ~2 more intervals
    expect(fetchCalls).toBeGreaterThan(a);
  });

  test("does not poll when enabled=false", async () => {
    returnRows = [];
    const qc = makeClient();
    render(
      <QueryClientProvider client={qc}>
        <Probe enabled={false} intervalMs={50} />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 120));
    expect(fetchCalls).toBe(0);
  });
});
```

- [ ] **Step 2: Run, expect FAIL — module not found**

Run: `cd packages/web && bun test tests/unit/lib/queries-events.test.ts`
Expected: FAIL — `Cannot find module '../../../src/lib/queries/events'`.

- [ ] **Step 3: Implement `packages/web/src/lib/queries/events.ts`**

```typescript
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { LiveDetectionEvent } from "@vipcam/shared";
import { apiFetch } from "../api-client";

export interface UseRecentDetectionsOpts {
  /** Max events returned per request (1..200). Default 50. */
  limit?: number;
  /** Polling interval in ms. Default 3000. */
  intervalMs?: number;
  /** When false, polling is paused (no fetch). Default true. */
  enabled?: boolean;
}

/**
 * Polling-based live feed source (Onda 8). Substitui o EventSource antigo
 * (`useSse`) — provado inconsertável sob nginx HTTP/2 deste setup. Pausa
 * automaticamente quando a aba está oculta (Page Visibility via React
 * Query `refetchIntervalInBackground:false`).
 */
export function useRecentDetections(opts: UseRecentDetectionsOpts = {}) {
  const limit = opts.limit ?? 50;
  const intervalMs = opts.intervalMs ?? 3000;
  const enabled = opts.enabled ?? true;

  return useQuery<LiveDetectionEvent[]>({
    queryKey: ["events", "recent", limit],
    queryFn: ({ signal }) =>
      apiFetch<LiveDetectionEvent[]>(`/api/events/recent?limit=${limit}`, { signal }),
    enabled,
    refetchInterval: enabled ? intervalMs : false,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}
```

- [ ] **Step 4: Run from `packages/web` — expect PASS**

Run: `cd packages/web && bun test tests/unit/lib/queries-events.test.ts`
Expected: PASS (3/3). Note: web tests must run **from `packages/web`** (alias `@/*` resolution — established session pattern).

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck` → 3/3.

```bash
git add packages/web/src/lib/queries/events.ts packages/web/tests/unit/lib/queries-events.test.ts
git commit -m "$(cat <<'EOF'
feat(web): Onda 8 — useRecentDetections hook (React Query polling)

3s default interval, pausa quando aba oculta, enabled-aware.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Web — refactor `live-feed.tsx` to use the polling hook (TDD)

**Files:**
- Modify (rewrite): `packages/web/src/components/live-feed.tsx`
- Create: `packages/web/tests/unit/components/live-feed-polling.test.tsx`

UI stays visually identical (cards, contagem, botão Pausar). Estado simplificado: sem `useSse`, sem `useState<events>`, sem ring buffer client-side — `data ?? []` direto do hook.

- [ ] **Step 1: Write the failing component test**

Create `packages/web/tests/unit/components/live-feed-polling.test.tsx`:

```tsx
import { describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import type { LiveDetectionEvent } from "@vipcam/shared";

// Mock api-client BEFORE importing LiveFeed (componente novo não importa
// mais getClientEnv — apiFetch internaliza isso).
mock.module("../../../src/lib/api-client", () => ({
  apiFetch: async () => [] as LiveDetectionEvent[],
  snapshotUrl: () => null,
  ApiError: class extends Error {},
}));

// Mock the hook so we control state deterministically.
const hookState: {
  data: LiveDetectionEvent[];
  isFetching: boolean;
  isError: boolean;
  status: "pending" | "success" | "error";
  lastEnabled?: boolean;
} = { data: [], isFetching: false, isError: false, status: "success" };

mock.module("../../../src/lib/queries/events", () => ({
  useRecentDetections: (opts: { enabled?: boolean } = {}) => {
    hookState.lastEnabled = opts.enabled ?? true;
    return hookState;
  },
}));

// Import AFTER the mocks.
import { LiveFeed } from "../../../src/components/live-feed";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("LiveFeed (polling)", () => {
  test("renders empty state when data is []", () => {
    hookState.data = [];
    hookState.isFetching = false;
    hookState.isError = false;
    hookState.status = "success";
    render(wrap(<LiveFeed />));
    expect(screen.getByText(/aguardando/i)).toBeDefined();
  });

  test("renders detection cards from hook data", () => {
    hookState.data = [
      { type: "detection", detection: { id: "d1", detected_at: "2026-05-20T15:00:00Z",
        snapshot_path: null, face_attrs: {}, dominant_emotion: "happy",
        emotion_confidence: 0.9, session_id: null, camera_id: "c" }, person: null },
    ];
    render(wrap(<LiveFeed />));
    // We don't assert DetectionCard internals; just that the count badge updates.
    expect(screen.getByText(/1 detec/i)).toBeDefined();
  });

  test("Pausar toggles hook.enabled", () => {
    hookState.data = [];
    hookState.lastEnabled = undefined;
    render(wrap(<LiveFeed />));
    // Initial render: enabled is true.
    expect(hookState.lastEnabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Pausar/i));
    expect(hookState.lastEnabled).toBe(false);
    fireEvent.click(screen.getByLabelText(/Pausar/i));
    expect(hookState.lastEnabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd packages/web && bun test tests/unit/components/live-feed-polling.test.tsx`
Expected: FAIL — `LiveFeed` still imports `useSse` (not the new hook); the mock for `lib/queries/events` won't intercept anything yet.

- [ ] **Step 3: Rewrite `packages/web/src/components/live-feed.tsx`**

Replace the entire contents with:

```tsx
"use client";

import { DetectionCard } from "@/components/detection-card";
import { Button } from "@/components/ui/button";
import { useRecentDetections } from "@/lib/queries/events";
import { useState } from "react";

const POLL_INTERVAL_MS = 3000;
const LIMIT = 50;

export function LiveFeed() {
  const [paused, setPaused] = useState(false);
  const query = useRecentDetections({
    limit: LIMIT,
    intervalMs: POLL_INTERVAL_MS,
    enabled: !paused,
  });

  const events = query.data ?? [];
  const label = paused
    ? "pausado"
    : query.isError
      ? "erro"
      : query.isFetching
        ? "atualizando"
        : "ao vivo";
  const labelColor = paused
    ? "text-slate-500"
    : query.isError
      ? "text-red-600"
      : "text-green-600";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 bg-white border rounded-md p-3">
        <div className="text-sm">
          <span className={labelColor}>●</span> {label}
        </div>
        <div className="text-sm text-slate-500">
          {events.length} detec{events.length === 1 ? "ção" : "ções"} no buffer
        </div>
        <Button
          variant="outline"
          size="sm"
          aria-label="Pausar/Retomar live feed"
          onClick={() => setPaused((p) => !p)}
          className="ml-auto"
        >
          {paused ? "▶ Retomar" : "⏸ Pausar"}
        </Button>
      </div>

      <div>
        {events.length === 0 ? (
          <div className="text-slate-500 italic text-center py-12">
            Aguardando primeira detecção…
          </div>
        ) : (
          // key = detection.id — único por detection; estável entre polls.
          events.map((e, i) => (
            <DetectionCard key={e.detection.id} event={e} fresh={i === 0} />
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run, expect PASS (3/3)**

Run: `cd packages/web && bun test tests/unit/components/live-feed-polling.test.tsx`
Expected: PASS — empty state, cards from data, Pausar toggles `enabled`.

- [ ] **Step 5: Typecheck + commit**

```bash
git add packages/web/src/components/live-feed.tsx packages/web/tests/unit/components/live-feed-polling.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): Onda 8 — LiveFeed via polling hook (drops useSse)

UI idêntica (badge, contagem, botão Pausar); estado simplificado — sem
ring buffer client-side, data ?? [] direto do useRecentDetections.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Web — delete `useSse` hook + its test

**Files:**
- Delete: `packages/web/src/hooks/use-sse.ts`
- Delete: `packages/web/tests/unit/hooks/use-sse.test.ts`

`LiveFeed` no longer imports `useSse` (Task 5). Confirm zero other consumers before deleting.

- [ ] **Step 1: Grep for remaining references**

Run: `grep -rn 'use-sse\|useSse' packages/web/src packages/web/tests 2>&1 | grep -v use-sse.ts | grep -v use-sse.test.ts`
Expected: NO matches (only the files themselves). If any match exists, **stop** and report — there's an unexpected consumer to handle first.

- [ ] **Step 2: Delete the files**

```bash
git rm packages/web/src/hooks/use-sse.ts packages/web/tests/unit/hooks/use-sse.test.ts
```

- [ ] **Step 3: Typecheck + full web suite**

Run: `bun run typecheck` → 3/3.
Run: `cd packages/web && bun test` → all pass (use-sse tests gone; others unchanged; new events/queries + live-feed-polling tests green).

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
chore(web): Onda 8 — delete useSse hook + test (replaced by polling)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Final verification + branch finish

**Files:** none (verification only).

- [ ] **Step 1: Full repo typecheck**

Run: `bun run typecheck` → exit 0, 3/3.

- [ ] **Step 2: Lint**

Run: `bun run lint` → exit 0 (no new errors vs the pre-existing baseline warning in `listener-stream.test.ts`). If biome flags new Onda-8 files, apply `bunx biome check --write <files>` and re-verify (behavior-preserving formatting/import order); commit as `style(...)`.

- [ ] **Step 3: Offline test suites**

Run: `cd packages/edge && bun test tests/unit` → pass.
Run: `cd packages/web && bun test` → pass.
Run: `cd packages/web && bun run build` → success.

Edge integration test (`events-recent.test.ts`) errors locally without Postgres — accepted; **flag in the final summary** that it must be run where `vipcam_test` exists before relying on it in prod.

- [ ] **Step 4: Finish the branch**

Use **superpowers:finishing-a-development-branch**. Merge summary must list:
- Offline gates run (typecheck 3/3, lint, edge+web unit suites, web build).
- DB-deferred test (events-recent integration).
- Operational follow-up post-merge (see below).

---

## Operational follow-up (NOT code — runbook after merge)

1. `cd /opt/vipcamv2 && sudo -u vipcam git pull origin master`
2. `sudo bash /opt/vipcamv2/scripts/deploy.sh` (pulls + build + restart edge/web — zero apt/nginx).
3. Smoke (header X-API-Key via `apiFetch` now; no `?api_key`):
   ```
   KEY=$(grep -m1 '^API_KEY=' /etc/vipcam/edge.env | cut -d= -f2- | tr -d '"')
   curl -s -H "X-API-Key: $KEY" https://monitoramento.franquiabv.com.br/api/events/recent?limit=10 | head -c 400; echo
   curl -i -H "X-API-Key: $KEY" "https://monitoramento.franquiabv.com.br/api/events/stream?api_key=$KEY" | head -2   # espera 404 (rota removida)
   ```
4. Browser `/live` (kiosk): cards aparecem ≤5 s da próxima detecção; badge alterna "atualizando"; Pausar/Retomar funciona; tab oculta → polling pausa (DevTools Network).
5. `sudo tail -f /var/log/nginx/vipcam.error.log` por alguns minutos — **sem novas** linhas `upstream prematurely closed connection while reading upstream /api/events/stream` (a fonte da falha some ao remover a rota).
6. Once `/live` is stable, **resume Onda 7 (Failover B)** where it paused (Seção 2 do spec da Onda 7).
