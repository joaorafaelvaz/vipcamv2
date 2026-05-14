# Onda 3 — Frontend de Visibilidade & Resolução

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir o dashboard web (Next.js + shadcn/ui) que dá visibilidade do que a câmera + ERP + match temporal produzem, mais a UI pra resolver matches ambíguos manualmente.

**Architecture:** Edge agent (já existente, Bun + Hono) ganha 5 endpoints REST novos (`/persons*`, `/sessions/*/detections`, `/matches/pending` enriched, `/dashboard/summary`, `/snapshots/*`) + 1 endpoint SSE (`/events/stream`). Frontend Next.js 14 (já scaffoldado em `packages/web`) ganha 4 telas (Live, People, Profile, Matches) usando shadcn/ui + React Query. SSE expõe detections ao vivo via EventSource browser-nativo.

**Tech Stack:** Bun + Hono + Drizzle (edge); Next.js 14 + React 18 + Tailwind 3.4 + shadcn/ui + React Query (TanStack) + Lucide icons (web); SSE (Hono `streamSSE`).

**Spec:** `docs/superpowers/specs/2026-05-14-onda-3-frontend-visibility-design.md`

**Convenções herdadas da Onda 2:**
- Factory pattern em rotas Hono (`createXRoutes(deps)`) com DI pra testabilidade
- Repos puros (sem business logic) usando `getDb()` singleton
- Tipos compartilhados em `@vipcam/shared`
- Tests unit em `tests/unit/` (mocks); integration em `tests/integration/` (Postgres real)
- `bun --filter '@vipcam/edge' test:integration` roda integration sequencialmente
- Middleware `apiKeyMiddleware` aplicado por prefixo (NÃO wildcard global)

---

## Chunk 3.1 — REST endpoints novos (read-heavy)

**Goal:** Adicionar 4 novos grupos de endpoints REST + tipos compartilhados, sem tocar UI ainda. Edge fica capaz de servir todos os reads que o frontend vai precisar (exceto SSE e snapshots, que ficam pro Chunk 3.2).

**Files affected:**
- Create: `packages/edge/src/api/routes/persons.ts`, `packages/edge/src/api/routes/sessions.ts`, `packages/edge/src/api/routes/dashboard.ts`
- Modify: `packages/shared/src/types/index.ts` (adicionar tipos), `packages/edge/src/persistence/repositories/persons.repo.ts` (extend), `packages/edge/src/persistence/repositories/sessions.repo.ts` (extend), `packages/edge/src/api/routes/matches.ts` (refactor /pending para enriched), `packages/edge/src/api/server.ts` (mount + middleware)
- Test: `packages/edge/tests/unit/api/routes/persons.test.ts`, `packages/edge/tests/unit/api/routes/sessions.test.ts`, `packages/edge/tests/unit/api/routes/dashboard.test.ts`, `packages/edge/tests/integration/persistence/persons.repo.test.ts` (extend), `packages/edge/tests/integration/persistence/sessions.repo.test.ts` (extend)

---

### Task 3.1.1: Tipos compartilhados em `@vipcam/shared`

**Goal:** Adicionar interfaces que ambos edge (response shapes) e web (props/queries) vão usar.

**Files:**
- Modify: `packages/shared/src/types/index.ts`

- [ ] **Step 1: Abrir o arquivo de tipos atual**

Read `packages/shared/src/types/index.ts` (já tem `ISO8601`, `UUID`, `HealthCheck`, `HealthResponse`).

- [ ] **Step 2: Adicionar os 6 tipos novos no final do arquivo**

```typescript
// === Onda 3 — visibility dashboard ===

export interface PersonSummary {
  id: UUID;
  display_name: string | null;
  person_type: "client" | "employee" | "anonymous";
  photo_path: string | null;
  last_seen_at: ISO8601 | null;
  total_visits: number;
  erp_client_id: string | null;
  erp_employee_id: string | null;
  phone: string | null;
}

export interface PersonDetail extends PersonSummary {
  avg_dominant_emotion: string | null;
  first_seen_at: ISO8601 | null;
  avg_visit_duration_min: number | null;
}

export interface DetectionThumbnail {
  id: UUID;
  detected_at: ISO8601;
  snapshot_path: string | null;
  face_attrs: Record<string, unknown>;
  dominant_emotion: string | null;
  emotion_confidence: number | null;
  session_id: UUID | null;
  camera_id: UUID;
}

export interface SessionWithDetections {
  id: UUID;
  started_at: ISO8601;
  ended_at: ISO8601 | null;
  detection_count: number;
  dominant_emotion: string | null;
  linked_erp_checkin_id: string | null;
  detections: DetectionThumbnail[];
}

export interface MatchPendingEnriched {
  match_attempt_id: UUID;
  decided_at: ISO8601;
  notes: string | null;
  checkin: {
    erp_id: string;
    client_name: string | null;
    client_phone: string | null;
    erp_client_id: string;
    person_id: UUID | null;     // Person.id resolvido por JOIN persons.erp_client_id
    occurred_at: ISO8601;
    event_type: string;
  };
  candidates: DetectionThumbnail[];
}

export interface LiveDetectionEvent {
  type: "detection";
  detection: DetectionThumbnail;
  person: PersonSummary | null;
}

export interface DashboardSummary {
  pending_matches: number;
  last_detection_at: ISO8601 | null;
  detections_today: number;
  persons_total: { client: number; employee: number };
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
}
```

- [ ] **Step 3: Verificar typecheck do shared package**

```bash
cd packages/shared && bun run typecheck
```

Expected: zero errors.

- [ ] **Step 4: Verificar que edge + web ainda buildam**

```bash
cd /d/Dev/Barbearia\ VIP/DH-IPC-HFW5442T-ASE && bun run typecheck
```

Expected: 3/3 packages exit code 0.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/index.ts
git commit -m "feat(shared): add Onda 3 dashboard types (PersonSummary, SessionWithDetections, MatchPendingEnriched, LiveDetectionEvent, DashboardSummary)"
```

---

### Task 3.1.2: `personsRepo.listWithFilters()` (TDD integration)

**Goal:** Repo method que retorna pessoas paginadas com search + filter por type, JOIN com `erp_clients` pra trazer telefone.

**Files:**
- Modify: `packages/edge/src/persistence/repositories/persons.repo.ts`
- Test: `packages/edge/tests/integration/persistence/persons.repo.test.ts`

- [ ] **Step 1: Escrever test integration (RED)**

Adicionar ao final de `persons.repo.test.ts`:

```typescript
describe("personsRepo.listWithFilters", () => {
  test("retorna paginação por type=client com phone vindo do erp_clients JOIN", async () => {
    await erpRepo.upsertClient({ erp_id: "100", name: "Ana", phone: "11999", is_active: true });
    await personsRepo.create({
      person_type: "client",
      display_name: "Ana",
      erp_client_id: "100",
    });
    await personsRepo.create({ person_type: "employee", display_name: "Funcionário X" });

    const result = await personsRepo.listWithFilters({ type: "client", limit: 10, offset: 0 });

    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.display_name).toBe("Ana");
    expect(result.items[0]?.phone).toBe("11999");
    expect(result.items[0]?.person_type).toBe("client");
  });

  test("search filtra por display_name (case-insensitive) ou phone", async () => {
    await erpRepo.upsertClient({ erp_id: "200", name: "Maria", phone: "11888", is_active: true });
    await personsRepo.create({ person_type: "client", display_name: "Maria", erp_client_id: "200" });
    await personsRepo.create({ person_type: "client", display_name: "Bruno" });

    const byName = await personsRepo.listWithFilters({ search: "mar", limit: 10, offset: 0 });
    expect(byName.total).toBe(1);
    expect(byName.items[0]?.display_name).toBe("Maria");

    const byPhone = await personsRepo.listWithFilters({ search: "11888", limit: 10, offset: 0 });
    expect(byPhone.total).toBe(1);
    expect(byPhone.items[0]?.display_name).toBe("Maria");
  });

  test("ordena por last_seen_at desc (NULLs por último)", async () => {
    await personsRepo.create({ person_type: "client", display_name: "Antiga" });
    const recent = await personsRepo.create({ person_type: "client", display_name: "Recente" });
    await personsRepo.incrementVisitCount(recent.id, new Date());

    const result = await personsRepo.listWithFilters({ limit: 10, offset: 0 });
    expect(result.items[0]?.display_name).toBe("Recente");
  });
});
```

- [ ] **Step 2: Rodar e ver RED**

```bash
KEY=$(grep '^API_KEY=' /etc/vipcam/edge.env | cut -d= -f2- | tr -d '"' | tr -d "'") || KEY=test-key
DB_PASS=$(grep '^DATABASE_URL=' /etc/vipcam/edge.env | sed -E 's|.*://[^:]+:([^@]+)@.*|\1|') || DB_PASS=vipcam
DATABASE_URL="postgres://vipcam:${DB_PASS}@127.0.0.1:5432/vipcam_test" API_KEY=$KEY \
  bun test packages/edge/tests/integration/persistence/persons.repo.test.ts 2>&1 | tail -10
```

Expected: 3 novos tests `(fail)` por `listWithFilters is not a function`.

- [ ] **Step 3: Implementar (GREEN)**

Adicionar imports e método em `persons.repo.ts`:

```typescript
import { and, eq, ilike, or, sql } from "drizzle-orm";
import { erpClients } from "../schema/erp-cache.js";

// dentro de personsRepo:
async listWithFilters(params: {
  type?: "client" | "employee";
  search?: string;
  limit: number;
  offset: number;
}): Promise<{ items: import("@vipcam/shared").PersonSummary[]; total: number }> {
  const db = getDb();

  const whereClauses = [];
  if (params.type) whereClauses.push(eq(persons.person_type, params.type));
  if (params.search) {
    const pat = `%${params.search}%`;
    // search por display_name OR erp_clients.phone via subquery scalar
    whereClauses.push(
      or(
        ilike(persons.display_name, pat),
        sql`EXISTS (SELECT 1 FROM ${erpClients} ec WHERE ec.erp_id = ${persons.erp_client_id} AND ec.phone ILIKE ${pat})`,
      ),
    );
  }
  const where = whereClauses.length ? and(...whereClauses) : undefined;

  const [items, [{ count }]] = await Promise.all([
    db
      .select({
        id: persons.id,
        display_name: persons.display_name,
        person_type: persons.person_type,
        photo_path: persons.thumbnail_path,
        last_seen_at: persons.last_seen_at,
        total_visits: persons.total_visits,
        erp_client_id: persons.erp_client_id,
        erp_employee_id: persons.erp_employee_id,
        phone: erpClients.phone,
      })
      .from(persons)
      .leftJoin(erpClients, eq(persons.erp_client_id, erpClients.erp_id))
      .where(where)
      .orderBy(sql`${persons.last_seen_at} DESC NULLS LAST`)
      .limit(params.limit)
      .offset(params.offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(persons)
      .where(where),
  ]);

  return { items: items as import("@vipcam/shared").PersonSummary[], total: count };
}
```

- [ ] **Step 4: Rodar e ver GREEN**

```bash
DATABASE_URL="postgres://vipcam:${DB_PASS}@127.0.0.1:5432/vipcam_test" API_KEY=$KEY \
  bun test packages/edge/tests/integration/persistence/persons.repo.test.ts 2>&1 | tail -10
```

Expected: 6 pass, 0 fail (3 antigos + 3 novos).

- [ ] **Step 5: Typecheck + lint**

```bash
cd packages/edge && bun run typecheck
cd ../.. && bun run lint:fix
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add packages/edge/src/persistence/repositories/persons.repo.ts packages/edge/tests/integration/persistence/persons.repo.test.ts
git commit -m "feat(repo): personsRepo.listWithFilters with type/search filters + JOIN erp_clients.phone"
```

---

### Task 3.1.3: `personsRepo.findByIdWithStats()` (TDD integration)

**Goal:** Versão enriched de `findById` que inclui estatísticas (avg_dominant_emotion, first_seen_at, avg_visit_duration_min) — calculadas via subqueries em `sessions`.

**Files:**
- Modify: `packages/edge/src/persistence/repositories/persons.repo.ts`
- Test: `packages/edge/tests/integration/persistence/persons.repo.test.ts`

- [ ] **Step 1: Escrever test (RED)**

```typescript
test("findByIdWithStats agrega first_seen_at + avg_dominant_emotion + avg_visit_duration_min", async () => {
  const cam = await camerasRepo.create({ name: "c", ip_address: "10.0.0.50" });
  await erpRepo.upsertClient({ erp_id: "300", name: "Carla", phone: "11777", is_active: true });
  const person = await personsRepo.create({
    person_type: "client",
    display_name: "Carla",
    erp_client_id: "300",
  });

  // 2 sessões: uma de 10min com happy, outra de 20min com neutral
  const s1 = await sessionsRepo.create({
    camera_id: cam.id,
    person_id: person.id,
    started_at: new Date("2026-05-01T10:00:00Z"),
    last_seen_at: new Date("2026-05-01T10:10:00Z"),
    detection_count: 5,
    dominant_emotion: "happy",
  });
  await sessionsRepo.close(s1.id, new Date("2026-05-01T10:10:00Z"));
  const s2 = await sessionsRepo.create({
    camera_id: cam.id,
    person_id: person.id,
    started_at: new Date("2026-05-02T15:00:00Z"),
    last_seen_at: new Date("2026-05-02T15:20:00Z"),
    detection_count: 8,
    dominant_emotion: "neutral",
  });
  await sessionsRepo.close(s2.id, new Date("2026-05-02T15:20:00Z"));

  const stats = await personsRepo.findByIdWithStats(person.id);
  expect(stats?.id).toBe(person.id);
  expect(stats?.first_seen_at).toBeTruthy();
  expect(["happy", "neutral"]).toContain(stats?.avg_dominant_emotion);
  expect(stats?.avg_visit_duration_min).toBeGreaterThan(9);
  expect(stats?.avg_visit_duration_min).toBeLessThan(21);
  expect(stats?.phone).toBe("11777");
});

test("findByIdWithStats retorna null quando id não existe", async () => {
  const result = await personsRepo.findByIdWithStats("00000000-0000-0000-0000-000000000000");
  expect(result).toBeNull();
});
```

- [ ] **Step 2: Rodar e ver RED**

Same command. Expected: 2 novos `(fail)` por método ausente.

- [ ] **Step 3: Implementar**

```typescript
async findByIdWithStats(id: string): Promise<import("@vipcam/shared").PersonDetail | null> {
  const db = getDb();
  const rows = await db
    .select({
      id: persons.id,
      display_name: persons.display_name,
      person_type: persons.person_type,
      photo_path: persons.thumbnail_path,
      last_seen_at: persons.last_seen_at,
      total_visits: persons.total_visits,
      erp_client_id: persons.erp_client_id,
      erp_employee_id: persons.erp_employee_id,
      phone: erpClients.phone,
      first_seen_at: sql<Date | null>`(SELECT MIN(${sessions.started_at}) FROM ${sessions} WHERE ${sessions.person_id} = ${persons.id})`,
      avg_dominant_emotion: sql<string | null>`(SELECT mode() WITHIN GROUP (ORDER BY ${sessions.dominant_emotion}) FROM ${sessions} WHERE ${sessions.person_id} = ${persons.id} AND ${sessions.dominant_emotion} IS NOT NULL)`,
      avg_visit_duration_min: sql<number | null>`(SELECT AVG(EXTRACT(EPOCH FROM (${sessions.ended_at} - ${sessions.started_at})) / 60.0)::float FROM ${sessions} WHERE ${sessions.person_id} = ${persons.id} AND ${sessions.ended_at} IS NOT NULL)`,
    })
    .from(persons)
    .leftJoin(erpClients, eq(persons.erp_client_id, erpClients.erp_id))
    .where(eq(persons.id, id))
    .limit(1);
  return (rows[0] as import("@vipcam/shared").PersonDetail | undefined) ?? null;
}
```

Adicionar import: `import { sessions } from "../schema/sessions.js";`.

- [ ] **Step 4: Rodar e ver GREEN**

```bash
DATABASE_URL="postgres://vipcam:${DB_PASS}@127.0.0.1:5432/vipcam_test" API_KEY=$KEY \
  bun test packages/edge/tests/integration/persistence/persons.repo.test.ts 2>&1 | tail -10
```

Expected: 8 pass.

- [ ] **Step 5: Typecheck + lint + commit**

```bash
cd packages/edge && bun run typecheck && cd ../.. && bun run lint:fix
git add packages/edge/src/persistence/repositories/persons.repo.ts packages/edge/tests/integration/persistence/persons.repo.test.ts
git commit -m "feat(repo): personsRepo.findByIdWithStats — first_seen + avg_emotion + avg_duration"
```

---

### Task 3.1.4: `sessionsRepo.listByPerson()` (TDD integration)

**Goal:** Retorna sessions de uma person com detections embutidas (limite 20 detections por session) — o "stack" do perfil.

**Files:**
- Modify: `packages/edge/src/persistence/repositories/sessions.repo.ts`
- Test: `packages/edge/tests/integration/persistence/sessions.repo.test.ts`

- [ ] **Step 1: Escrever test (RED)**

```typescript
test("listByPerson retorna sessions ordenadas desc + detections embedded (limit 20)", async () => {
  const cam = await camerasRepo.create({ name: "c", ip_address: "10.0.0.60" });
  const person = await personsRepo.create({ person_type: "client", display_name: "Test" });

  // 2 sessões da mesma pessoa
  const s1 = await sessionsRepo.create({
    camera_id: cam.id,
    person_id: person.id,
    started_at: new Date("2026-05-01T10:00:00Z"),
    last_seen_at: new Date("2026-05-01T10:10:00Z"),
    detection_count: 1,
  });
  await detectionsRepo.create({
    camera_id: cam.id,
    session_id: s1.id,
    person_id: person.id,
    detected_at: new Date("2026-05-01T10:01:00Z"),
    raw_event: {},
    face_attrs: { age: 30 },
    dominant_emotion: "happy",
    snapshot_path: "/var/lib/vipcam/snapshots/abc.jpg",
  });

  const s2 = await sessionsRepo.create({
    camera_id: cam.id,
    person_id: person.id,
    started_at: new Date("2026-05-02T11:00:00Z"),
    last_seen_at: new Date("2026-05-02T11:05:00Z"),
    detection_count: 1,
  });

  const result = await sessionsRepo.listByPerson(person.id, 10);
  expect(result).toHaveLength(2);
  // Mais recente primeiro
  expect(result[0]?.id).toBe(s2.id);
  expect(result[1]?.id).toBe(s1.id);
  // Detections embedded
  expect(result[1]?.detections).toHaveLength(1);
  expect(result[1]?.detections[0]?.dominant_emotion).toBe("happy");
  expect(result[1]?.detections[0]?.face_attrs).toEqual({ age: 30 });
});

test("listByPerson retorna [] quando pessoa não tem sessions", async () => {
  const lonely = await personsRepo.create({ person_type: "client", display_name: "Sozinho" });
  const result = await sessionsRepo.listByPerson(lonely.id, 10);
  expect(result).toEqual([]);
});

test("listByPerson cap 20 detections por session no payload", async () => {
  const cam = await camerasRepo.create({ name: "c", ip_address: "10.0.0.61" });
  const person = await personsRepo.create({ person_type: "client", display_name: "Many" });
  const sess = await sessionsRepo.create({
    camera_id: cam.id,
    person_id: person.id,
    started_at: new Date("2026-05-01T10:00:00Z"),
    last_seen_at: new Date("2026-05-01T11:00:00Z"),
    detection_count: 25,
  });
  for (let i = 0; i < 25; i++) {
    await detectionsRepo.create({
      camera_id: cam.id,
      session_id: sess.id,
      person_id: person.id,
      detected_at: new Date(Date.parse("2026-05-01T10:00:00Z") + i * 60_000),
      raw_event: {},
      face_attrs: {},
    });
  }

  const result = await sessionsRepo.listByPerson(person.id, 10);
  expect(result).toHaveLength(1);
  expect(result[0]?.detections).toHaveLength(20); // cap 20
  expect(result[0]?.detection_count).toBe(25);    // counter na session preservado
});
```

- [ ] **Step 2: Rodar e ver RED**

```bash
DATABASE_URL="postgres://vipcam:${DB_PASS}@127.0.0.1:5432/vipcam_test" API_KEY=$KEY \
  bun test packages/edge/tests/integration/persistence/sessions.repo.test.ts 2>&1 | tail -10
```

Expected: 1 fail.

- [ ] **Step 3: Implementar**

Adicionar em `sessions.repo.ts` (importar `detections` schema também):

```typescript
async listByPerson(
  personId: string,
  limit: number,
): Promise<import("@vipcam/shared").SessionWithDetections[]> {
  const db = getDb();
  const sessRows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.person_id, personId))
    .orderBy(desc(sessions.started_at))
    .limit(limit);

  if (sessRows.length === 0) return [];

  // Carrega detections em batch — 1 query, agrupa em memória
  const sessIds = sessRows.map((s) => s.id);
  const detRows = await db
    .select({
      id: detections.id,
      detected_at: detections.detected_at,
      snapshot_path: detections.snapshot_path,
      face_attrs: detections.face_attrs,
      dominant_emotion: detections.dominant_emotion,
      emotion_confidence: detections.emotion_confidence,
      session_id: detections.session_id,
      camera_id: detections.camera_id,
    })
    .from(detections)
    .where(inArray(detections.session_id, sessIds))
    .orderBy(desc(detections.detected_at));

  const detsBySession = new Map<string, typeof detRows>();
  for (const d of detRows) {
    if (!d.session_id) continue;
    const arr = detsBySession.get(d.session_id) ?? [];
    if (arr.length < 20) arr.push(d);
    detsBySession.set(d.session_id, arr);
  }

  return sessRows.map((s) => ({
    id: s.id,
    started_at: s.started_at.toISOString(),
    ended_at: s.ended_at?.toISOString() ?? null,
    detection_count: s.detection_count,
    dominant_emotion: s.dominant_emotion,
    linked_erp_checkin_id: s.linked_erp_checkin_id,
    detections: (detsBySession.get(s.id) ?? []).map((d) => ({
      id: d.id,
      detected_at: d.detected_at.toISOString(),
      snapshot_path: d.snapshot_path,
      face_attrs: d.face_attrs as Record<string, unknown>,
      dominant_emotion: d.dominant_emotion,
      emotion_confidence: d.emotion_confidence,
      session_id: d.session_id,
      camera_id: d.camera_id,
    })),
  }));
}
```

Adicionar imports: `inArray` from drizzle-orm, `detections` schema.

- [ ] **Step 4: Rodar e ver GREEN**

Expected: 4 pass total no sessions.repo.test.ts.

- [ ] **Step 5: Typecheck + lint + commit**

```bash
cd packages/edge && bun run typecheck && cd ../.. && bun run lint:fix
git add packages/edge/src/persistence/repositories/sessions.repo.ts packages/edge/tests/integration/persistence/sessions.repo.test.ts
git commit -m "feat(repo): sessionsRepo.listByPerson with embedded detections (max 20/session)"
```

---

### Task 3.1.5: Route `/api/persons/*` (TDD unit + integration)

**Goal:** 3 endpoints (`GET /`, `GET /:id`, `GET /:id/sessions`) usando os repos novos. Factory pattern com DI igual `routes/discovery.ts` etc.

**Files:**
- Create: `packages/edge/src/api/routes/persons.ts`
- Create: `packages/edge/tests/unit/api/routes/persons.test.ts`

- [ ] **Step 1: Escrever testes unit com mocked deps (RED)**

```typescript
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { type PersonsDeps, createPersonsRoutes } from "../../../../src/api/routes/persons.js";
import type { PaginatedResponse, PersonDetail, PersonSummary, SessionWithDetections } from "@vipcam/shared";

const stubPerson: PersonSummary = {
  id: "11111111-1111-1111-1111-111111111111",
  display_name: "Ana",
  person_type: "client",
  photo_path: null,
  last_seen_at: "2026-05-12T12:00:00Z",
  total_visits: 5,
  erp_client_id: "100",
  erp_employee_id: null,
  phone: "11999",
};

function mountWith(deps: PersonsDeps): Hono {
  const app = new Hono();
  app.route("/api/persons", createPersonsRoutes(deps));
  app.onError((_err, c) => c.json({ error: "internal_error" }, 500));
  return app;
}

function defaultDeps(overrides: Partial<PersonsDeps> = {}): PersonsDeps {
  return {
    list: async () => ({ items: [stubPerson], total: 1 }),
    getById: async () => ({ ...stubPerson, avg_dominant_emotion: "happy", first_seen_at: "2026-04-01T00:00:00Z", avg_visit_duration_min: 15 } as PersonDetail),
    listSessions: async () => [],
    ...overrides,
  };
}

describe("GET /api/persons", () => {
  test("default sem query params: limit=50 offset=0 sem filtros", async () => {
    let receivedParams: unknown;
    const app = mountWith(defaultDeps({
      list: async (params) => {
        receivedParams = params;
        return { items: [stubPerson], total: 1 };
      },
    }));
    const res = await app.request("/api/persons");
    expect(res.status).toBe(200);
    expect(receivedParams).toEqual({ limit: 50, offset: 0 });
  });

  test("aceita ?type=client&search=ana&limit=10&offset=20", async () => {
    let receivedParams: unknown;
    const app = mountWith(defaultDeps({
      list: async (params) => { receivedParams = params; return { items: [], total: 0 }; },
    }));
    const res = await app.request("/api/persons?type=client&search=ana&limit=10&offset=20");
    expect(res.status).toBe(200);
    expect(receivedParams).toEqual({ type: "client", search: "ana", limit: 10, offset: 20 });
  });

  test("rejeita ?type=outro com 400", async () => {
    const app = mountWith(defaultDeps());
    const res = await app.request("/api/persons?type=outro");
    expect(res.status).toBe(400);
  });

  test("clampa limit em [1, 200]", async () => {
    let receivedParams: unknown = null;
    const app = mountWith(defaultDeps({
      list: async (p) => { receivedParams = p; return { items: [], total: 0 }; },
    }));
    await app.request("/api/persons?limit=999");
    expect((receivedParams as { limit: number }).limit).toBe(200);
    await app.request("/api/persons?limit=0");
    expect((receivedParams as { limit: number }).limit).toBe(1);
  });
});

describe("GET /api/persons/:id", () => {
  test("retorna 200 com PersonDetail quando achado", async () => {
    const app = mountWith(defaultDeps());
    const res = await app.request(`/api/persons/${stubPerson.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PersonDetail;
    expect(body.id).toBe(stubPerson.id);
    expect(body.avg_dominant_emotion).toBe("happy");
  });

  test("retorna 404 quando getById devolve null", async () => {
    const app = mountWith(defaultDeps({ getById: async () => null }));
    const res = await app.request(`/api/persons/${stubPerson.id}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/persons/:id/sessions", () => {
  test("default limit=20, retorna { items }", async () => {
    let receivedLimit: number | undefined;
    const stubSession: SessionWithDetections = {
      id: "22222222-2222-2222-2222-222222222222",
      started_at: "2026-05-12T10:00:00Z",
      ended_at: null,
      detection_count: 5,
      dominant_emotion: "happy",
      linked_erp_checkin_id: null,
      detections: [],
    };
    const app = mountWith(defaultDeps({
      listSessions: async (_id, limit) => { receivedLimit = limit; return [stubSession]; },
    }));
    const res = await app.request(`/api/persons/${stubPerson.id}/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: SessionWithDetections[] };
    expect(receivedLimit).toBe(20);
    expect(body.items).toHaveLength(1);
  });

  test("aceita ?limit= explicit", async () => {
    let receivedLimit: number | undefined;
    const app = mountWith(defaultDeps({
      listSessions: async (_id, limit) => { receivedLimit = limit; return []; },
    }));
    await app.request(`/api/persons/${stubPerson.id}/sessions?limit=5`);
    expect(receivedLimit).toBe(5);
  });
});
```

- [ ] **Step 2: Rodar e ver RED**

```bash
bun test packages/edge/tests/unit/api/routes/persons.test.ts 2>&1 | tail -10
```

Expected: erro `Cannot find module '../../../../src/api/routes/persons.js'`.

- [ ] **Step 3: Implementar `routes/persons.ts`**

```typescript
import { Hono } from "hono";
import { z } from "zod";
import type { PaginatedResponse, PersonDetail, PersonSummary, SessionWithDetections } from "@vipcam/shared";

export interface PersonsDeps {
  list: (params: {
    type?: "client" | "employee";
    search?: string;
    limit: number;
    offset: number;
  }) => Promise<PaginatedResponse<PersonSummary>>;
  getById: (id: string) => Promise<PersonDetail | null>;
  listSessions: (id: string, limit: number) => Promise<SessionWithDetections[]>;
}

const listQuery = z.object({
  type: z.enum(["client", "employee"]).optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().optional().default(50),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
});

const sessionsQuery = z.object({
  limit: z.coerce.number().int().positive().optional().default(20),
});

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function createPersonsRoutes(deps: PersonsDeps): Hono {
  const r = new Hono();

  r.get("/", async (c) => {
    const parsed = listQuery.safeParse({
      type: c.req.query("type"),
      search: c.req.query("search"),
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    });
    if (!parsed.success) {
      return c.json({ error: "invalid_query", issues: parsed.error.issues }, 400);
    }
    const params: Parameters<PersonsDeps["list"]>[0] = {
      limit: clamp(parsed.data.limit, 1, 200),
      offset: parsed.data.offset,
    };
    if (parsed.data.type !== undefined) params.type = parsed.data.type;
    if (parsed.data.search !== undefined) params.search = parsed.data.search;
    const result = await deps.list(params);
    return c.json(result);
  });

  r.get("/:id", async (c) => {
    const id = c.req.param("id");
    const person = await deps.getById(id);
    if (!person) return c.json({ error: "not_found" }, 404);
    return c.json(person);
  });

  r.get("/:id/sessions", async (c) => {
    const id = c.req.param("id");
    const parsed = sessionsQuery.safeParse({ limit: c.req.query("limit") });
    if (!parsed.success) return c.json({ error: "invalid_query" }, 400);
    const items = await deps.listSessions(id, clamp(parsed.data.limit, 1, 100));
    return c.json({ items });
  });

  return r;
}
```

- [ ] **Step 4: Rodar e ver GREEN**

```bash
bun test packages/edge/tests/unit/api/routes/persons.test.ts 2>&1 | tail -10
```

Expected: 7 pass.

- [ ] **Step 5: Typecheck + lint + commit**

```bash
cd packages/edge && bun run typecheck && cd ../.. && bun run lint:fix
git add packages/edge/src/api/routes/persons.ts packages/edge/tests/unit/api/routes/persons.test.ts
git commit -m "feat(api): GET /api/persons/* routes (list/findById/sessions) with Zod validation"
```

---

### Task 3.1.6: Route `/api/sessions/:id/detections` (TDD unit)

**Goal:** Endpoint pra hidratar fotos de uma sessão específica (caso UI precise mais que 20 inicialmente embedded). Pode reutilizar `sessionsRepo.listByPerson` lógica? Não — esse precisa de `detectionsRepo` direto. Mais simples assim.

**Files:**
- Create: `packages/edge/src/api/routes/sessions.ts`
- Create: `packages/edge/tests/unit/api/routes/sessions.test.ts`
- Modify: `packages/edge/src/persistence/repositories/detections.repo.ts` (add `listBySession`)
- Test: `packages/edge/tests/integration/persistence/detections.repo.test.ts` (extend)

- [ ] **Step 1: Test integration pra `detectionsRepo.listBySession` (RED)**

Adicionar em `detections.repo.test.ts`:

```typescript
test("listBySession retorna detections ordered by detected_at desc com cap 100", async () => {
  const cam = await camerasRepo.create({ name: "c", ip_address: "10.0.0.70" });
  const sess = await sessionsRepo.create({
    camera_id: cam.id,
    started_at: new Date("2026-05-01T10:00:00Z"),
    last_seen_at: new Date("2026-05-01T10:00:00Z"),
    detection_count: 0,
  });
  for (let i = 0; i < 3; i++) {
    await detectionsRepo.create({
      camera_id: cam.id,
      session_id: sess.id,
      detected_at: new Date(`2026-05-01T10:0${i}:00Z`),
      raw_event: {},
      face_attrs: {},
    });
  }

  const result = await detectionsRepo.listBySession(sess.id);
  expect(result).toHaveLength(3);
  // Newest first
  expect(result[0]?.detected_at.toISOString()).toBe("2026-05-01T10:02:00.000Z");
});
```

- [ ] **Step 2: Implementar `listBySession`**

Em `detections.repo.ts`:

```typescript
async listBySession(sessionId: string, limit = 100): Promise<Detection[]> {
  return getDb()
    .select()
    .from(detections)
    .where(eq(detections.session_id, sessionId))
    .orderBy(desc(detections.detected_at))
    .limit(limit);
},
```

- [ ] **Step 3: Test unit da rota (RED)**

```typescript
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { type SessionsDeps, createSessionsRoutes } from "../../../../src/api/routes/sessions.js";
import type { DetectionThumbnail } from "@vipcam/shared";

function mountWith(deps: SessionsDeps): Hono {
  const app = new Hono();
  app.route("/api/sessions", createSessionsRoutes(deps));
  return app;
}

const SESS_ID = "33333333-3333-3333-3333-333333333333";
const CAM_ID = "44444444-4444-4444-4444-444444444444";

const stubDet: DetectionThumbnail = {
  id: "55555555-5555-5555-5555-555555555555",
  detected_at: "2026-05-01T10:00:00Z",
  snapshot_path: "/var/lib/vipcam/snapshots/det.jpg",
  face_attrs: {},
  dominant_emotion: "happy",
  emotion_confidence: 0.8,
  session_id: SESS_ID,
  camera_id: CAM_ID,
};

describe("GET /api/sessions/:id/detections", () => {
  test("retorna { items: DetectionThumbnail[] }", async () => {
    const app = mountWith({ listDetections: async () => [stubDet] });
    const res = await app.request(`/api/sessions/${SESS_ID}/detections`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: DetectionThumbnail[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.id).toBe(stubDet.id);
  });

  test("retorna { items: [] } quando sessão sem detections (deps decide; sem 404)", async () => {
    const app = mountWith({ listDetections: async () => [] });
    const res = await app.request(`/api/sessions/${SESS_ID}/detections`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });
});
```

- [ ] **Step 4: Implementar `routes/sessions.ts`**

```typescript
import { Hono } from "hono";
import type { DetectionThumbnail } from "@vipcam/shared";

export interface SessionsDeps {
  listDetections: (sessionId: string) => Promise<DetectionThumbnail[]>;
}

export function createSessionsRoutes(deps: SessionsDeps): Hono {
  const r = new Hono();

  r.get("/:id/detections", async (c) => {
    const id = c.req.param("id");
    const items = await deps.listDetections(id);
    return c.json({ items });
  });

  return r;
}
```

- [ ] **Step 5: Verify GREEN + commit**

```bash
DATABASE_URL="postgres://vipcam:${DB_PASS}@127.0.0.1:5432/vipcam_test" API_KEY=$KEY \
  bun test packages/edge/tests/integration/persistence/detections.repo.test.ts 2>&1 | tail -5
bun test packages/edge/tests/unit/api/routes/sessions.test.ts 2>&1 | tail -5
cd packages/edge && bun run typecheck && cd ../.. && bun run lint:fix
git add packages/edge/src/persistence/repositories/detections.repo.ts packages/edge/tests/integration/persistence/detections.repo.test.ts packages/edge/src/api/routes/sessions.ts packages/edge/tests/unit/api/routes/sessions.test.ts
git commit -m "feat(api): GET /api/sessions/:id/detections + repo listBySession"
```

---

### Task 3.1.7: Route `/api/dashboard/summary` (TDD unit)

**Goal:** Endpoint que agrega counts pra topbar (badge de matches pendentes principalmente). Reusa queries existentes (matches.findPending, etc) ou cria queries dedicadas.

**Files:**
- Create: `packages/edge/src/api/routes/dashboard.ts`
- Create: `packages/edge/tests/unit/api/routes/dashboard.test.ts`

- [ ] **Step 1: Test unit com mocked deps (RED)**

```typescript
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { type DashboardDeps, createDashboardRoutes } from "../../../../src/api/routes/dashboard.js";
import type { DashboardSummary } from "@vipcam/shared";

const stubSummary: DashboardSummary = {
  pending_matches: 2,
  last_detection_at: "2026-05-14T13:00:00Z",
  detections_today: 47,
  persons_total: { client: 30, employee: 369 },
};

describe("GET /api/dashboard/summary", () => {
  test("retorna DashboardSummary do deps", async () => {
    let called = 0;
    const app = new Hono();
    app.route("/api/dashboard", createDashboardRoutes({
      summary: async () => { called += 1; return stubSummary; },
    }));
    const res = await app.request("/api/dashboard/summary");
    expect(res.status).toBe(200);
    expect(called).toBe(1);
    const body = (await res.json()) as DashboardSummary;
    expect(body).toEqual(stubSummary);
  });
});
```

- [ ] **Step 2: Implementar `routes/dashboard.ts`**

```typescript
import { Hono } from "hono";
import type { DashboardSummary } from "@vipcam/shared";

export interface DashboardDeps {
  summary: () => Promise<DashboardSummary>;
}

export function createDashboardRoutes(deps: DashboardDeps): Hono {
  const r = new Hono();
  r.get("/summary", async (c) => c.json(await deps.summary()));
  return r;
}
```

- [ ] **Step 3: Verify GREEN + commit**

```bash
bun test packages/edge/tests/unit/api/routes/dashboard.test.ts
cd packages/edge && bun run typecheck && cd ../.. && bun run lint:fix
git add packages/edge/src/api/routes/dashboard.ts packages/edge/tests/unit/api/routes/dashboard.test.ts
git commit -m "feat(api): GET /api/dashboard/summary endpoint (factory pattern)"
```

---

### Task 3.1.8: Refactor `/api/matches/pending` para `MatchPendingEnriched` (TDD)

**Goal:** Mudar shape do response de `MatchAttempt[]` cru pra `MatchPendingEnriched[]` com checkin info + candidate detections embedded.

**Files:**
- Modify: `packages/edge/src/api/routes/matches.ts` (interface MatchDeps + GET /pending handler)
- Modify: `packages/edge/src/api/server.ts` (deps.listPending vai ter que fazer JOIN)
- Test: `packages/edge/tests/unit/api/routes/matches.test.ts` (atualizar `stubAttempt` pra novo shape)

- [ ] **Step 1: Atualizar tests da rota (RED)**

**Antes de editar:** Read `packages/edge/tests/unit/api/routes/matches.test.ts` por inteiro pra entender quais tests existentes referenciam `MatchAttempt` cru. Identifique TODOS os asserts que usam `body.items[0]?.id`, `?.detection_id`, `?.decision`, etc — eles precisam ser atualizados pra `body.items[0]?.match_attempt_id`, `?.candidates`, etc. Os tests POST resolve/reject não dependem do shape do GET; só atualizar o que pertence ao `describe("GET /api/matches/pending")`.

Substituir `stubAttempt: MatchAttempt` pra:

```typescript
import type { MatchPendingEnriched } from "@vipcam/shared";

const stubEnriched: MatchPendingEnriched = {
  match_attempt_id: "11111111-1111-1111-1111-111111111111",
  decided_at: "2026-05-12T12:00:00Z",
  notes: "3 candidates",
  checkin: {
    erp_id: "erp-1",
    client_name: "Ana Costa",
    client_phone: "11999",
    erp_client_id: "100",
    person_id: "99999999-9999-9999-9999-999999999999",
    occurred_at: "2026-05-12T11:58:00Z",
    event_type: "appointment_confirmed",
  },
  candidates: [],
};
```

E nos tests do GET /pending, mudar `body.items[0]?.id` pra `body.items[0]?.match_attempt_id`.

Mudar tipo de `listPending` no `defaultDeps` pra retornar `MatchPendingEnriched[]`.

- [ ] **Step 2: Atualizar interface MatchDeps em `routes/matches.ts`**

```typescript
import type { MatchPendingEnriched } from "@vipcam/shared";

export interface MatchDeps {
  listPending: (limit: number) => Promise<MatchPendingEnriched[]>;
  resolve: (id: string, chosenDetectionId: string, chosenPersonId: string) => Promise<void>;
  reject: (id: string, reason?: string) => Promise<void>;
}
```

(Resto da rota fica igual — apenas o shape do dado mudou.)

- [ ] **Step 3: Atualizar wire-up em `server.ts`**

Substituir o `listPending: (limit) => matchAttemptsRepo.findPending(limit)` por implementação que faz JOIN. Estratégia: query Drizzle direta no handler do server.ts (igual ERP status).

```typescript
// Em server.ts, dentro do createMatchRoutes deps:
listPending: async (limit) => {
  const db = getDb();
  // 1. busca match_attempts ambíguos
  const attempts = await matchAttemptsRepo.findPending(limit);
  if (attempts.length === 0) return [];

  const checkinIds = attempts.map((a) => a.erp_checkin_id).filter((x): x is string => x !== null);
  const checkinRows = checkinIds.length > 0
    ? await db
        .select({
          erp_id: erpCheckins.erp_id,
          erp_client_id: erpCheckins.erp_client_id,
          occurred_at: erpCheckins.occurred_at,
          event_type: erpCheckins.event_type,
          client_name: erpClients.name,
          client_phone: erpClients.phone,
          person_id: persons.id,        // Person.id resolvido via erp_client_id
        })
        .from(erpCheckins)
        .leftJoin(erpClients, eq(erpCheckins.erp_client_id, erpClients.erp_id))
        .leftJoin(persons, eq(persons.erp_client_id, erpCheckins.erp_client_id))
        .where(inArray(erpCheckins.erp_id, checkinIds))
    : [];
  const checkinsById = new Map(checkinRows.map((c) => [c.erp_id, c]));

  // 2. pra cada attempt, busca detections candidates da window
  const env = getEnv();
  const enriched: MatchPendingEnriched[] = [];
  for (const a of attempts) {
    if (!a.erp_checkin_id) continue;
    const checkin = checkinsById.get(a.erp_checkin_id);
    if (!checkin) continue;
    const window = computeWindow(checkin.occurred_at, env.MATCH_WINDOW_SECONDS);
    const candidatesDet = await db
      .select({
        id: detections.id,
        detected_at: detections.detected_at,
        snapshot_path: detections.snapshot_path,
        face_attrs: detections.face_attrs,
        dominant_emotion: detections.dominant_emotion,
        emotion_confidence: detections.emotion_confidence,
        session_id: detections.session_id,
        camera_id: detections.camera_id,
      })
      .from(detections)
      .where(
        and(
          isNull(detections.person_id),
          between(detections.detected_at, window.start, window.end),
        ),
      )
      .orderBy(asc(detections.detected_at));

    enriched.push({
      match_attempt_id: a.id,
      decided_at: a.decided_at.toISOString(),
      notes: a.notes,
      checkin: {
        erp_id: checkin.erp_id,
        client_name: checkin.client_name,
        client_phone: checkin.client_phone,
        erp_client_id: checkin.erp_client_id,
        person_id: checkin.person_id,
        occurred_at: checkin.occurred_at.toISOString(),
        event_type: checkin.event_type,
      },
      candidates: candidatesDet.map((d) => ({
        id: d.id,
        detected_at: d.detected_at.toISOString(),
        snapshot_path: d.snapshot_path,
        face_attrs: d.face_attrs as Record<string, unknown>,
        dominant_emotion: d.dominant_emotion,
        emotion_confidence: d.emotion_confidence,
        session_id: d.session_id,
        camera_id: d.camera_id,
      })),
    });
  }
  return enriched;
},
```

(Imports a adicionar: `and`, `asc`, `between`, `inArray`, `isNull` from drizzle-orm; `detections`, `erpClients`, `persons` schemas; `computeWindow` from match-temp.)

- [ ] **Step 4: Verify tests GREEN + commit**

```bash
bun test packages/edge/tests/unit/api/routes/matches.test.ts 2>&1 | tail -5
cd packages/edge && bun run typecheck && cd ../.. && bun run lint:fix
git add packages/edge/src/api/routes/matches.ts packages/edge/src/api/server.ts packages/edge/tests/unit/api/routes/matches.test.ts
git commit -m "refactor(api): /api/matches/pending returns MatchPendingEnriched (BREAKING)"
```

---

### Task 3.1.9: Helper dashboard.queries + wire-up `server.ts`

**Goal:** Extrair lógica de agregação do dashboard pra módulo dedicado (mantém server.ts magro). Mountar `/api/persons/*`, `/api/sessions/*`, `/api/dashboard/*` com `apiKeyMiddleware`.

**Files:**
- Create: `packages/edge/src/api/dashboard.queries.ts` (helper agregando counts)
- Modify: `packages/edge/src/api/server.ts`

- [ ] **Step 1: Criar `api/dashboard.queries.ts`**

```typescript
import { eq, gte, sql } from "drizzle-orm";
import type { DashboardSummary } from "@vipcam/shared";
import { getDb } from "../persistence/db.js";
import { detections } from "../persistence/schema/detections.js";
import { matchAttempts } from "../persistence/schema/match-attempts.js";
import { persons } from "../persistence/schema/persons.js";

export async function fetchDashboardSummary(): Promise<DashboardSummary> {
  const db = getDb();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [[pending], [lastDet], [todayCount], personCounts] = await Promise.all([
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(matchAttempts)
      .where(eq(matchAttempts.decision, "ambiguous")),
    db
      .select({ at: sql<Date | null>`max(${detections.detected_at})` })
      .from(detections),
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
```

- [ ] **Step 2: Atualizar imports em `server.ts`**

Adicionar (ou consolidar):

```typescript
import { detectionsRepo, personsRepo } from "../persistence/repositories/index.js";
import { fetchDashboardSummary } from "./dashboard.queries.js";
import { createDashboardRoutes } from "./routes/dashboard.js";
import { createPersonsRoutes } from "./routes/persons.js";
import { createSessionsRoutes } from "./routes/sessions.js";
```

(`sessionsRepo` já está importado da Onda 2.)

- [ ] **Step 3: Adicionar middleware blocks**

No bloco que tem `app.use("/api/discovery/*", requireKey)` etc, adicionar:

```typescript
app.use("/api/persons/*", requireKey);
app.use("/api/sessions/*", requireKey);
app.use("/api/dashboard/*", requireKey);
```

- [ ] **Step 4: Mount routes (após `/api/matches`)**

```typescript
app.route(
  "/api/persons",
  createPersonsRoutes({
    list: (params) => personsRepo.listWithFilters(params),
    getById: (id) => personsRepo.findByIdWithStats(id),
    listSessions: (id, limit) => sessionsRepo.listByPerson(id, limit),
  }),
);

app.route(
  "/api/sessions",
  createSessionsRoutes({
    listDetections: async (sessionId) => {
      const dets = await detectionsRepo.listBySession(sessionId);
      return dets.map((d) => ({
        id: d.id,
        detected_at: d.detected_at.toISOString(),
        snapshot_path: d.snapshot_path,
        face_attrs: d.face_attrs as Record<string, unknown>,
        dominant_emotion: d.dominant_emotion,
        emotion_confidence: d.emotion_confidence,
        session_id: d.session_id,
        camera_id: d.camera_id,
      }));
    },
  }),
);

app.route(
  "/api/dashboard",
  createDashboardRoutes({ summary: fetchDashboardSummary }),
);
```

- [ ] **Step 5: Verify typecheck + lint + tests + commit**

```bash
cd packages/edge && bun run typecheck
cd ../.. && bun run lint:fix
bun test packages/edge/tests/unit 2>&1 | tail -5
git add packages/edge/src/api/server.ts packages/edge/src/api/dashboard.queries.ts
git commit -m "feat(api): mount /persons /sessions /dashboard routes + dashboard.queries helper"
```

---

### Task 3.1.10: Verificação final do Chunk 3.1

- [ ] **Step 1: Suite completa**

```bash
DB_PASS=$(grep '^DATABASE_URL=' /etc/vipcam/edge.env | sed -E 's|.*://[^:]+:([^@]+)@.*|\1|')
KEY=$(grep '^API_KEY=' /etc/vipcam/edge.env | cut -d= -f2- | tr -d '"' | tr -d "'")

# Unit
bun test packages/edge/tests/unit 2>&1 | tail -5
# Integration (sequencial)
sudo -u vipcam DATABASE_URL="postgres://vipcam:${DB_PASS}@127.0.0.1:5432/vipcam_test" API_KEY=$KEY \
  bun --filter '@vipcam/edge' test:integration 2>&1 | tail -10
```

Expected: 0 failures em ambos.

- [ ] **Step 2: Typecheck + lint root**

```bash
bun run typecheck && bun run lint
```

Expected: zero errors, lint só com warning pré-existente.

- [ ] **Step 3: Smoke test manual contra edge dev (no VPS, opcional local)**

```bash
# Em outro terminal: cd packages/edge && bun run dev
# Depois neste terminal:
KEY=$(grep '^API_KEY=' /etc/vipcam/edge.env 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'") || KEY=$(grep '^API_KEY=' packages/edge/.env | cut -d= -f2-)
curl -fs -H "X-API-Key: $KEY" http://localhost:4000/api/persons | jq '.total'
curl -fs -H "X-API-Key: $KEY" http://localhost:4000/api/dashboard/summary | jq
curl -fs -H "X-API-Key: $KEY" http://localhost:4000/api/matches/pending | jq '.[] | {match_attempt_id, candidates_count: (.candidates | length)}'
```

Expected: 3 endpoints respondendo corretamente.

- [ ] **Step 4: Final commit (se houver pendências)**

Se a verificação encontrou ajustes pequenos, agrupar num único commit:

```bash
git add -A
git commit -m "chore(chunk-3.1): verification fixes"
```

**Checkpoint Chunk 3.1 atingido:** Edge expõe todos os endpoints REST que o frontend vai precisar pra People/Profile/Matches/Dashboard. Falta SSE + snapshots (Chunk 3.2) e o frontend em si (Chunks 3.3-3.5).

---

## Chunk 3.2 — Snapshots + SSE infrastructure

**Goal:** 2 features ortogonais consolidadas em 1 chunk: (a) endpoint estático `/snapshots/:filename` pra servir JPGs; (b) `/api/events/stream` SSE pra Live feed + event bus + publish do pipeline.

**Files affected:**
- Create: `packages/edge/src/api/routes/snapshots.ts`, `packages/edge/src/api/routes/events.ts`, `packages/edge/src/api/events/event-bus.ts`
- Modify: `packages/edge/src/api/middleware/api-key.ts` (extender pra `?api_key=` no SSE), `packages/edge/src/api/server.ts` (mount), `packages/edge/src/ingest/pipeline.ts` (publish detection)
- Test: `packages/edge/tests/unit/api/routes/snapshots.test.ts`, `packages/edge/tests/unit/api/events/event-bus.test.ts`, `packages/edge/tests/unit/api/middleware/api-key.test.ts` (extend)

---

### Task 3.2.1: Estender `apiKeyMiddleware` pra aceitar `?api_key=` SOMENTE em `/api/events/stream`

**Goal:** EventSource browser não passa headers — precisamos de query-param exclusivo pro SSE path. NUNCA aceitar query param em endpoints mutativos (segurança).

**Files:**
- Modify: `packages/edge/src/api/middleware/api-key.ts`
- Modify: `packages/edge/tests/unit/api/middleware/api-key.test.ts`

- [ ] **Step 1: Test (RED)**

Adicionar tests ao final do describe existente:

```typescript
describe("apiKeyMiddleware — query param exception (SSE only)", () => {
  const key = "valid-secret-123";
  function appAllowingQueryOn(pathSuffix: string): Hono {
    const app = new Hono();
    app.use("/api/*", apiKeyMiddleware(key, { allowQueryOn: pathSuffix }));
    app.get("/api/events/stream", (c) => c.text("ok"));
    app.post("/api/erp/sync/employees", (c) => c.text("danger"));
    return app;
  }

  test("aceita ?api_key= em /api/events/stream", async () => {
    const app = appAllowingQueryOn("/api/events/stream");
    const res = await app.request(`/api/events/stream?api_key=${key}`);
    expect(res.status).toBe(200);
  });

  test("REJEITA ?api_key= em endpoint mutativo (mesma config)", async () => {
    const app = appAllowingQueryOn("/api/events/stream");
    const res = await app.request(`/api/erp/sync/employees?api_key=${key}`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("ainda aceita header X-API-Key normal em qualquer rota", async () => {
    const app = appAllowingQueryOn("/api/events/stream");
    const res = await app.request("/api/erp/sync/employees", {
      method: "POST",
      headers: { "X-API-Key": key },
    });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Rodar e ver RED**

```bash
bun test packages/edge/tests/unit/api/middleware/api-key.test.ts 2>&1 | tail -10
```

Expected: 3 fails (`allowQueryOn is not a valid option`).

- [ ] **Step 3: Estender middleware**

Atualizar `api-key.ts`:

```typescript
import type { MiddlewareHandler } from "hono";

export interface ApiKeyMiddlewareOptions {
  /**
   * Path EXATO onde aceitar `?api_key=` query param ao invés do header
   * `X-API-Key`. Único caso de uso legítimo: `/api/events/stream` (SSE com
   * EventSource browser que NÃO suporta headers customizados).
   *
   * Manter restrito a 1 path — query params vazam pra access logs e
   * referers, então NUNCA habilitar em endpoints mutativos.
   */
  allowQueryOn?: string;
}

export function apiKeyMiddleware(
  expectedKey: string,
  options: ApiKeyMiddlewareOptions = {},
): MiddlewareHandler {
  return async (c, next) => {
    const headerKey = c.req.header("X-API-Key");
    if (headerKey === expectedKey) {
      await next();
      return;
    }

    // Exceção: aceitar query param SOMENTE em path explicitamente whitelisted
    if (options.allowQueryOn && c.req.path === options.allowQueryOn) {
      const queryKey = c.req.query("api_key");
      if (queryKey === expectedKey) {
        await next();
        return;
      }
    }

    return c.json({ error: "unauthorized" }, 401);
  };
}
```

- [ ] **Step 4: Rodar e ver GREEN**

Expected: 8 pass (5 antigos + 3 novos).

- [ ] **Step 5: Atualizar chamadas em `server.ts`**

A invocação atual `apiKeyMiddleware(env.API_KEY)` continua válida (`options.allowQueryOn` é opcional). Mas pra `/api/events/*` precisaremos passar a opção — isso será feito no Task 3.2.5 quando mountar SSE.

- [ ] **Step 6: Commit**

```bash
cd packages/edge && bun run typecheck && cd ../.. && bun run lint:fix
git add packages/edge/src/api/middleware/api-key.ts packages/edge/tests/unit/api/middleware/api-key.test.ts
git commit -m "feat(middleware): apiKeyMiddleware accepts ?api_key= on whitelisted path (SSE)"
```

---

### Task 3.2.2: Route `/snapshots/:filename` (TDD unit)

**Goal:** Serve arquivos `.jpg` do diretório `/var/lib/vipcam/snapshots/`. Anti path-traversal via validação de filename. Cache headers pra browser cachear.

**Files:**
- Create: `packages/edge/src/api/routes/snapshots.ts`
- Create: `packages/edge/tests/unit/api/routes/snapshots.test.ts`

- [ ] **Step 1: Test (RED)**

```typescript
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { type SnapshotsDeps, createSnapshotsRoutes } from "../../../../src/api/routes/snapshots.js";

function mountWith(deps: SnapshotsDeps): Hono {
  const app = new Hono();
  app.route("/snapshots", createSnapshotsRoutes(deps));
  return app;
}

describe("GET /snapshots/:filename", () => {
  test("retorna 200 com bytes + content-type quando file existe", async () => {
    const fakeBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic
    const app = mountWith({
      readSnapshot: async (filename) => {
        expect(filename).toBe("abc123.jpg");
        return fakeBytes;
      },
    });
    const res = await app.request("/snapshots/abc123.jpg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toContain("max-age=86400");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes[0]).toBe(0xff);
  });

  test("retorna 404 quando readSnapshot devolve null (file não existe)", async () => {
    const app = mountWith({ readSnapshot: async () => null });
    const res = await app.request("/snapshots/missing.jpg");
    expect(res.status).toBe(404);
  });

  test("rejeita filename com path traversal (`..`)", async () => {
    let called = false;
    const app = mountWith({ readSnapshot: async () => { called = true; return null; } });
    const res = await app.request("/snapshots/..%2F..%2Fetc%2Fpasswd");
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });

  test("rejeita filename com slash literal", async () => {
    const app = mountWith({ readSnapshot: async () => null });
    // Hono trataria como path component; mas se entrar como parametrizado, regex valida
    const res = await app.request("/snapshots/subdir/file.jpg");
    // Esse pode dar 404 do router (path diferente). Vale notar e ajustar regex/rota.
    expect([400, 404]).toContain(res.status);
  });

  test("rejeita filename sem extensão .jpg", async () => {
    const app = mountWith({ readSnapshot: async () => null });
    const res = await app.request("/snapshots/file.png");
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Implementar `routes/snapshots.ts`**

```typescript
import { Hono } from "hono";

export interface SnapshotsDeps {
  /** Lê bytes do filesystem. Retorna null se file não existe. */
  readSnapshot: (filename: string) => Promise<Uint8Array | null>;
}

// Anti path traversal: aceita SÓ filenames simples [a-z0-9_.-]+.jpg, sem barras.
const VALID_FILENAME = /^[a-zA-Z0-9_.-]+\.jpg$/;

export function createSnapshotsRoutes(deps: SnapshotsDeps): Hono {
  const r = new Hono();

  r.get("/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (!VALID_FILENAME.test(filename) || filename.includes("..")) {
      return c.json({ error: "invalid_filename" }, 400);
    }
    const bytes = await deps.readSnapshot(filename);
    if (!bytes) return c.json({ error: "not_found" }, 404);
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "public, max-age=86400, immutable",
      },
    });
  });

  return r;
}
```

- [ ] **Step 3: GREEN check + commit**

```bash
bun test packages/edge/tests/unit/api/routes/snapshots.test.ts 2>&1 | tail -5
cd packages/edge && bun run typecheck && cd ../.. && bun run lint:fix
git add packages/edge/src/api/routes/snapshots.ts packages/edge/tests/unit/api/routes/snapshots.test.ts
git commit -m "feat(api): GET /snapshots/:filename with anti-traversal + cache headers"
```

---

### Task 3.2.3: Event bus singleton (TDD unit)

**Goal:** `EventEmitter` interno que `ingest/pipeline.ts` usa pra publicar detections e `routes/events.ts` subscribe pra empurrar via SSE.

**Files:**
- Create: `packages/edge/src/api/events/event-bus.ts`
- Create: `packages/edge/tests/unit/api/events/event-bus.test.ts`

- [ ] **Step 1: Test (RED)**

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import type { LiveDetectionEvent } from "@vipcam/shared";
import { eventBus, _resetEventBus } from "../../../../src/api/events/event-bus.js";

afterEach(() => _resetEventBus());

const sampleEvent: LiveDetectionEvent = {
  type: "detection",
  detection: {
    id: "11111111-1111-1111-1111-111111111111",
    detected_at: "2026-05-14T13:00:00Z",
    snapshot_path: null,
    face_attrs: {},
    dominant_emotion: null,
    emotion_confidence: null,
    session_id: null,
    camera_id: "22222222-2222-2222-2222-222222222222",
  },
  person: null,
};

describe("eventBus", () => {
  test("subscribers recebem events publicados", async () => {
    const received: LiveDetectionEvent[] = [];
    eventBus.subscribe((e) => received.push(e));
    eventBus.publish(sampleEvent);
    expect(received).toHaveLength(1);
    expect(received[0]?.detection.id).toBe(sampleEvent.detection.id);
  });

  test("multiple subscribers todos recebem", () => {
    const a: LiveDetectionEvent[] = [];
    const b: LiveDetectionEvent[] = [];
    eventBus.subscribe((e) => a.push(e));
    eventBus.subscribe((e) => b.push(e));
    eventBus.publish(sampleEvent);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  test("unsubscribe remove o handler", () => {
    const received: LiveDetectionEvent[] = [];
    const unsub = eventBus.subscribe((e) => received.push(e));
    eventBus.publish(sampleEvent);
    unsub();
    eventBus.publish(sampleEvent);
    expect(received).toHaveLength(1);
  });

  test("publish sem subscribers não throwa (tolera zero listeners)", () => {
    expect(() => eventBus.publish(sampleEvent)).not.toThrow();
  });

  test("subscriberCount reflete listeners ativos", () => {
    expect(eventBus.subscriberCount()).toBe(0);
    const unsub = eventBus.subscribe(() => {});
    expect(eventBus.subscriberCount()).toBe(1);
    unsub();
    expect(eventBus.subscriberCount()).toBe(0);
  });
});
```

- [ ] **Step 2: Implementar**

```typescript
import { EventEmitter } from "node:events";
import type { LiveDetectionEvent } from "@vipcam/shared";

/**
 * Event bus interno do edge — produtor único (pipeline.ts) e múltiplos
 * subscribers (SSE clients). Singleton de módulo.
 *
 * Tolera zero subscribers (pipeline.publish nunca bloqueia ingest). Não há
 * buffer histórico — clientes que conectam só veem events futuros.
 *
 * Limite implícito: MaxListeners default do EventEmitter é 10. Subimos pra
 * 50 pra suportar múltiplos dashboards abertos simultaneamente.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(50);
const EVENT_NAME = "detection";

export const eventBus = {
  publish(event: LiveDetectionEvent): void {
    emitter.emit(EVENT_NAME, event);
  },
  subscribe(handler: (event: LiveDetectionEvent) => void): () => void {
    emitter.on(EVENT_NAME, handler);
    return () => emitter.off(EVENT_NAME, handler);
  },
  subscriberCount(): number {
    return emitter.listenerCount(EVENT_NAME);
  },
};

/** Reset interno só para testes — usar em afterEach. */
export function _resetEventBus(): void {
  emitter.removeAllListeners(EVENT_NAME);
}
```

- [ ] **Step 3: GREEN + commit**

```bash
bun test packages/edge/tests/unit/api/events/event-bus.test.ts 2>&1 | tail -5
cd packages/edge && bun run typecheck && cd ../.. && bun run lint:fix
git add packages/edge/src/api/events/event-bus.ts packages/edge/tests/unit/api/events/event-bus.test.ts
git commit -m "feat(events): singleton event-bus for live detection broadcasting"
```

---

### Task 3.2.4: Route `/api/events/stream` (SSE) (TDD unit com mocked bus)

**Goal:** Endpoint SSE que subscribe ao event bus e empurra eventos pro cliente. Heartbeat 15s.

**Files:**
- Create: `packages/edge/src/api/routes/events.ts`
- Create: `packages/edge/tests/unit/api/routes/events.test.ts`

- [ ] **Step 1: Test (RED) — handshake + subscribe wiring + abort cleanup**

```typescript
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { LiveDetectionEvent } from "@vipcam/shared";
import { createEventsRoutes } from "../../../../src/api/routes/events.js";

describe("GET /api/events/stream", () => {
  test("retorna 200 + headers SSE corretos", async () => {
    const app = new Hono();
    app.route("/api/events", createEventsRoutes({
      subscribe: () => () => {},
      heartbeatMs: 100_000,
    }));
    const res = await app.request("/api/events/stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    // Não consome stream — só handshake. Stream real é testado por integration.
  });

  test("registra subscriber assim que conexão abre", async () => {
    let subscribed = 0;
    let unsubscribed = 0;
    const app = new Hono();
    app.route("/api/events", createEventsRoutes({
      subscribe: (_handler) => {
        subscribed += 1;
        return () => { unsubscribed += 1; };
      },
      heartbeatMs: 100_000,
    }));

    // AbortController pra cortar o stream após handshake
    const ac = new AbortController();
    const resPromise = app.request("/api/events/stream", { signal: ac.signal });

    // Dá tempo do handler subscribed registrar
    await new Promise((r) => setTimeout(r, 50));
    expect(subscribed).toBe(1);

    ac.abort();
    // Ignora rejeição da promise abortada
    await resPromise.catch(() => undefined);
    // Cleanup pode ser síncrono ou assíncrono — pequena espera
    await new Promise((r) => setTimeout(r, 50));
    expect(unsubscribed).toBe(1);
  });

  test("eventos publicados pelo bus são empurrados via writeSSE", async () => {
    let captured: ((e: LiveDetectionEvent) => void) | null = null;
    const app = new Hono();
    app.route("/api/events", createEventsRoutes({
      subscribe: (handler) => {
        captured = handler;
        return () => {};
      },
      heartbeatMs: 100_000,
    }));

    const ac = new AbortController();
    const resPromise = app.request("/api/events/stream", { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 30));

    expect(captured).not.toBeNull();
    // Publish — não throwa, mesmo sem reader real (lossy aceitável)
    expect(() => captured!({
      type: "detection",
      detection: {
        id: "00000000-0000-0000-0000-000000000001",
        detected_at: "2026-05-14T13:00:00Z",
        snapshot_path: null, face_attrs: {}, dominant_emotion: null,
        emotion_confidence: null, session_id: null,
        camera_id: "00000000-0000-0000-0000-000000000099",
      },
      person: null,
    })).not.toThrow();

    ac.abort();
    await resPromise.catch(() => undefined);
  });
});
```

- [ ] **Step 2: Implementar `routes/events.ts`**

```typescript
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { LiveDetectionEvent } from "@vipcam/shared";

export interface EventsDeps {
  /**
   * Subscribe pro bus de eventos. Retorna função pra unsubscribe.
   * Em produção: `eventBus.subscribe`. Em test: mock.
   */
  subscribe: (handler: (event: LiveDetectionEvent) => void) => () => void;
  /** Intervalo do heartbeat em ms. Default 15s. */
  heartbeatMs?: number;
}

export function createEventsRoutes(deps: EventsDeps): Hono {
  const r = new Hono();
  const heartbeatMs = deps.heartbeatMs ?? 15_000;

  r.get("/stream", (c) => {
    return streamSSE(c, async (stream) => {
      // Fila local: enquanto stream.writeSSE() não termina (yield), próximos
      // events ficam pendentes. Como temos rate baixo (10-30/min), basta
      // empurrar direto.
      const unsubscribe = deps.subscribe((event) => {
        // writeSSE retorna Promise mas não awaitamos aqui (lossy mas OK pra ambient feed)
        void stream.writeSSE({
          data: JSON.stringify(event),
        });
      });

      // Heartbeat pra evitar timeout de proxy + detectar half-close
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: "" });
      }, heartbeatMs);

      // Cleanup on close (Hono detecta abort do client via signal)
      stream.onAbort(() => {
        clearInterval(heartbeat);
        unsubscribe();
      });

      // Mantém o handler vivo (await que nunca resolve até client desconectar)
      await new Promise<void>(() => {});
    });
  });

  return r;
}
```

- [ ] **Step 3: GREEN + commit**

```bash
bun test packages/edge/tests/unit/api/routes/events.test.ts 2>&1 | tail -5
cd packages/edge && bun run typecheck && cd ../.. && bun run lint:fix
git add packages/edge/src/api/routes/events.ts packages/edge/tests/unit/api/routes/events.test.ts
git commit -m "feat(api): GET /api/events/stream SSE endpoint with heartbeat"
```

---

### Task 3.2.5: Pipeline publica detection no event bus

**Goal:** Após `detectionsRepo.create()` succeed no pipeline.ts, publicar `LiveDetectionEvent` no bus. Não bloqueante (try/catch interno).

**Files:**
- Modify: `packages/edge/src/ingest/pipeline.ts`
- Test: extensão de integration test (`packages/edge/tests/integration/ingest/pipeline.test.ts`)

- [ ] **Step 1: Test integration (RED)**

**Antes de escrever:** Read `packages/edge/tests/integration/ingest/pipeline.test.ts` por inteiro pra ver o pattern de fixtures e a função real do pipeline (é `processEvent(raw, cameraId)`, não `processCapturedEvent`). Reaproveitar fixture `validFaceDetectStartEvent` ou similar já existente.

Adicionar imports no topo do arquivo (se não tiver):

```typescript
import { eventBus, _resetEventBus } from "../../../src/api/events/event-bus.js";
import type { LiveDetectionEvent } from "@vipcam/shared";
```

Adicionar test ao final do `describe`:

```typescript
test("pipeline publishes LiveDetectionEvent no event bus após create", async () => {
  const cam = await camerasRepo.create({ name: "c-bus", ip_address: "10.0.0.80" });

  const received: LiveDetectionEvent[] = [];
  const unsub = eventBus.subscribe((e) => received.push(e));

  // Reusa fixture do test acima (mesmo shape do validFaceDetectStartEvent
  // já testado em "auto_match: 1 detection"). Se não houver, copiar literal:
  const rawEvent = JSON.stringify({
    Code: "FaceDetect",
    Action: "Start",
    Data: {
      EventID: 1,
      Object: { Age: 30, Gender: "Female", Emotion: { Type: "Happy", Confidence: 80 } },
    },
  });

  await processEvent(rawEvent, cam.id);

  unsub();
  _resetEventBus();
  expect(received.length).toBeGreaterThanOrEqual(1);
  expect(received[0]?.type).toBe("detection");
  expect(received[0]?.detection.camera_id).toBe(cam.id);
});
```

- [ ] **Step 2: Importar event bus + LiveDetectionEvent type**

```typescript
import { eventBus } from "../api/events/event-bus.js";
import type { LiveDetectionEvent } from "@vipcam/shared";
```

- [ ] **Step 3: Publicar após `detectionsRepo.create(detection)`**

No bloco `try` do pipeline (depois da linha que chama `await detectionsRepo.create(detection)` e antes do `recalcDominantEmotion`):

```typescript
const created = await detectionsRepo.create(detection);

// Publish no event bus — não bloqueante; ignora erros pra não derrubar ingest
try {
  const liveEvent: LiveDetectionEvent = {
    type: "detection",
    detection: {
      id: created.id,
      detected_at: created.detected_at.toISOString(),
      snapshot_path: created.snapshot_path,
      face_attrs: created.face_attrs as Record<string, unknown>,
      dominant_emotion: created.dominant_emotion,
      emotion_confidence: created.emotion_confidence,
      session_id: created.session_id,
      camera_id: created.camera_id,
    },
    person: null, // person identification em onda futura (failover B)
  };
  eventBus.publish(liveEvent);
} catch (err) {
  logger.warn({ err }, "event bus publish failed — ingest continues");
}
```

**Atenção:** `detectionsRepo.create` atualmente retorna `Detection`. Confirmar e usar o retorno (`created`) — atualmente o pipeline NÃO usa o retorno. Atualizar a linha existente `await detectionsRepo.create(detection);` pra `const created = await detectionsRepo.create(detection);`.

- [ ] **Step 4: GREEN + commit**

```bash
DATABASE_URL="postgres://vipcam:${DB_PASS}@127.0.0.1:5432/vipcam_test" API_KEY=$KEY \
  bun test packages/edge/tests/integration/ingest/pipeline.test.ts 2>&1 | tail -5
cd packages/edge && bun run typecheck && cd ../.. && bun run lint:fix
git add packages/edge/src/ingest/pipeline.ts packages/edge/tests/integration/ingest/pipeline.test.ts
git commit -m "feat(ingest): publish detection event after persistence (live feed)"
```

---

### Task 3.2.6: Wire-up `server.ts` com snapshots + events + middleware exception

**Goal:** Mountar as 2 novas rotas + configurar `apiKeyMiddleware` com `allowQueryOn` específico.

**Files:**
- Modify: `packages/edge/src/api/server.ts`

- [ ] **Step 1: Atualizar imports**

```typescript
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { eventBus } from "./events/event-bus.js";
import { createEventsRoutes } from "./routes/events.js";
import { createSnapshotsRoutes } from "./routes/snapshots.js";
```

- [ ] **Step 2: Atualizar instanciação do middleware (allowQueryOn)**

Trocar:

```typescript
const requireKey = apiKeyMiddleware(env.API_KEY);
```

Por:

```typescript
const requireKey = apiKeyMiddleware(env.API_KEY, {
  allowQueryOn: "/api/events/stream",
});
```

- [ ] **Step 3: Adicionar middleware pra /api/events**

```typescript
app.use("/api/events/*", requireKey);
```

- [ ] **Step 4: Mount routes**

```typescript
// SSE
app.route(
  "/api/events",
  createEventsRoutes({
    subscribe: (handler) => eventBus.subscribe(handler),
  }),
);

// Snapshots (PÚBLICO — sem requireKey)
const SNAPSHOTS_DIR = "/var/lib/vipcam/snapshots";
app.route(
  "/snapshots",
  createSnapshotsRoutes({
    readSnapshot: async (filename) => {
      // path.join já é seguro porque filename foi validado pelo regex da rota
      const fullPath = path.join(SNAPSHOTS_DIR, filename);
      try {
        return await fs.readFile(fullPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
  }),
);
```

- [ ] **Step 5: Verify + commit**

```bash
cd packages/edge && bun run typecheck && cd ../.. && bun run lint:fix
bun test packages/edge/tests/unit 2>&1 | tail -5
git add packages/edge/src/api/server.ts
git commit -m "feat(api): mount /api/events SSE + /snapshots routes + middleware allowQueryOn"
```

---

### Task 3.2.7: Verificação final do Chunk 3.2

- [ ] **Step 1: Tests unit + integration**

```bash
bun test packages/edge/tests/unit 2>&1 | tail -5
sudo -u vipcam DATABASE_URL="postgres://vipcam:${DB_PASS}@127.0.0.1:5432/vipcam_test" API_KEY=$KEY \
  bun --filter '@vipcam/edge' test:integration 2>&1 | tail -10
```

Expected: 0 failures.

- [ ] **Step 2: Smoke test SSE manual**

```bash
KEY=$(grep '^API_KEY=' /etc/vipcam/edge.env | cut -d= -f2- | tr -d '"' | tr -d "'")
# Em outro terminal: cd packages/edge && bun run dev
# Inicia stream e exibe events; aborta com Ctrl-C:
curl -N "http://localhost:4000/api/events/stream?api_key=$KEY"
# Esperado: receber `: ping` a cada 15s + qualquer detection real que ocorrer.
```

- [ ] **Step 3: Smoke test snapshots**

```bash
# Lista snapshots existentes
ls /var/lib/vipcam/snapshots | head -3
# Baixa um direto (sem auth)
curl -fs -o /tmp/test.jpg "http://localhost:4000/snapshots/<filename-real>.jpg"
file /tmp/test.jpg  # deve dizer: JPEG image
# Anti-traversal
curl -fs -o /dev/null -w "%{http_code}\n" "http://localhost:4000/snapshots/..%2F..%2Fetc%2Fpasswd"
# Esperado: 400
```

**Checkpoint Chunk 3.2 atingido:** Edge agora suporta visualização ao vivo (SSE) e serve fotos (snapshots). Frontend tem todas as APIs necessárias.

---

## Chunk 3.3 — Frontend foundation

**Goal:** Setup do Next.js + shadcn/ui + React Query + topbar + roteamento. Sem telas de conteúdo ainda; só a fundação visual e o esqueleto que vai receber as 4 telas nos Chunks 3.4 e 3.5.

**Files affected:**
- Modify: `packages/web/package.json` (deps), `packages/web/tailwind.config.ts`, `packages/web/src/app/layout.tsx`, `packages/web/src/app/page.tsx`, `packages/web/src/app/globals.css`
- Create: `packages/web/components.json` (shadcn config), `packages/web/.env.example`, `packages/web/src/lib/env.ts`, `packages/web/src/lib/api-client.ts` (rewrite), `packages/web/src/app/providers.tsx`, `packages/web/src/components/topbar.tsx`, `packages/web/src/components/ui/*` (shadcn install), `packages/web/src/lib/queries/dashboard.ts`
- Test: `packages/web/tests/unit/lib/env.test.ts`, `packages/web/tests/unit/components/topbar.test.tsx`

---

### Task 3.3.1: Instalar deps + shadcn init

**Goal:** Adicionar shadcn/ui + React Query + Lucide icons ao packages/web.

**Files:**
- Modify: `packages/web/package.json`
- Create: `packages/web/components.json`

- [ ] **Step 1: Adicionar deps ao package.json**

```bash
cd packages/web
bun add @tanstack/react-query @tanstack/react-query-devtools lucide-react class-variance-authority clsx tailwind-merge tailwindcss-animate zod
bun add -D @types/node @testing-library/react @testing-library/jest-dom @happy-dom/global-registrator
```

`zod` é usado pelo `lib/env.ts` (Task 3.3.2). `@happy-dom/global-registrator` simula DOM no Bun test.

- [ ] **Step 2: Backup e init do shadcn**

⚠ **Backup primeiro:** o `shadcn init` REESCREVE `tailwind.config.ts` e `globals.css`. Se o projeto tem customizations existentes, perde.

```bash
cd packages/web
cp tailwind.config.ts tailwind.config.ts.bak
cp src/app/globals.css src/app/globals.css.bak
bunx shadcn@latest init -d -y
# -d = use defaults; -y = skip all confirmations (idempotente, não-interativo)
```

Defaults aplicados: TypeScript=yes, style=default, base color=slate, CSS vars=yes, alias `@/*`=`./src/*`.

Após init, conferir manualmente que `tailwind.config.ts` ainda inclui `content` apontando pra `./src/**/*.{ts,tsx}` (shadcn pode regenerar e perder paths custom). Se perdeu, mesclar com `.bak`.

- [ ] **Step 3: Verificar build**

```bash
cd packages/web && bun run typecheck && bun run build 2>&1 | tail -10
```

Expected: build OK. Se quebrar (ex: shadcn substituiu globals.css e a página `/discovery` perdeu styles), revisar diff do `.bak`.

- [ ] **Step 3: Verificar build ainda passa**

```bash
cd packages/web && bun run typecheck && bun run build 2>&1 | tail -10
```

Expected: build OK.

- [ ] **Step 4: Instalar componentes shadcn iniciais que vamos usar**

```bash
cd packages/web
bunx shadcn@latest add button table dialog input badge avatar card separator skeleton sonner select tabs
```

(Toast usa Sonner.)

- [ ] **Step 5: Commit**

```bash
git add packages/web/package.json packages/web/bun.lockb packages/web/components.json packages/web/tailwind.config.ts packages/web/src/app/globals.css packages/web/src/lib/utils.ts packages/web/src/components/ui
git commit -m "chore(web): init shadcn/ui + React Query + Lucide deps"
```

---

### Task 3.3.2: Env config + types

**Goal:** Validar `NEXT_PUBLIC_API_URL` e `NEXT_PUBLIC_API_KEY` no boot. Falhar cedo se ausentes.

**Files:**
- Create: `packages/web/src/lib/env.ts`, `packages/web/.env.example`
- Test: `packages/web/tests/unit/lib/env.test.ts`

- [ ] **Step 1: `.env.example`**

```
# URL base do edge agent (sem trailing slash)
NEXT_PUBLIC_API_URL=http://localhost:4000

# X-API-Key do edge. Compartilhada — vai pro bundle JS.
# Em produção, definir antes do build.
NEXT_PUBLIC_API_KEY=change-me-only-on-trusted-lan
```

- [ ] **Step 2: Test (RED)**

```typescript
import { describe, expect, test } from "bun:test";
import { parseClientEnv } from "../../../src/lib/env.js";

describe("parseClientEnv", () => {
  test("aceita env válido com defaults", () => {
    const env = parseClientEnv({
      NEXT_PUBLIC_API_URL: "http://localhost:4000",
      NEXT_PUBLIC_API_KEY: "secret",
    });
    expect(env.NEXT_PUBLIC_API_URL).toBe("http://localhost:4000");
    expect(env.NEXT_PUBLIC_API_KEY).toBe("secret");
  });

  test("rejeita API_URL sem protocolo", () => {
    expect(() =>
      parseClientEnv({ NEXT_PUBLIC_API_URL: "localhost:4000", NEXT_PUBLIC_API_KEY: "x" }),
    ).toThrow();
  });

  test("rejeita API_KEY vazia", () => {
    expect(() =>
      parseClientEnv({ NEXT_PUBLIC_API_URL: "http://l", NEXT_PUBLIC_API_KEY: "" }),
    ).toThrow();
  });
});
```

- [ ] **Step 3: Implementar `lib/env.ts`**

```typescript
import { z } from "zod";

const clientEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url(),
  NEXT_PUBLIC_API_KEY: z.string().min(1),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;

export function parseClientEnv(raw: Record<string, string | undefined>): ClientEnv {
  const r = clientEnvSchema.safeParse(raw);
  if (!r.success) {
    throw new Error(`Invalid client env: ${r.error.issues.map((i) => i.message).join(", ")}`);
  }
  return r.data;
}

// Lazy export. Next.js inlining substitui NEXT_PUBLIC_* em build time.
let _env: ClientEnv | undefined;
export function getClientEnv(): ClientEnv {
  if (!_env) {
    _env = parseClientEnv({
      NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
      NEXT_PUBLIC_API_KEY: process.env.NEXT_PUBLIC_API_KEY,
    });
  }
  return _env;
}
```

- [ ] **Step 4: GREEN + commit**

```bash
cd packages/web && bun test tests/unit/lib/env.test.ts && bun run typecheck
git add packages/web/.env.example packages/web/src/lib/env.ts packages/web/tests/unit/lib/env.test.ts
git commit -m "feat(web): env parsing + validation for NEXT_PUBLIC_API_URL/KEY"
```

---

### Task 3.3.3: Rewrite `lib/api-client.ts` para X-API-Key + erros tipados

**Goal:** Wrapper de fetch que injeta `X-API-Key`, parseia JSON, trata 401/404/500 com erros nomeados.

**Files:**
- Modify: `packages/web/src/lib/api-client.ts`

- [ ] **Step 1: Implementar wrapper**

```typescript
import { getClientEnv } from "./env.js";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? `${status} ${code}`);
    this.name = "ApiError";
  }
}

interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

export async function apiFetch<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const env = getClientEnv();
  const url = `${env.NEXT_PUBLIC_API_URL}${path}`;
  const headers: Record<string, string> = {
    "X-API-Key": env.NEXT_PUBLIC_API_KEY,
  };
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const init: RequestInit = { method: opts.method ?? "GET", headers };
  if (body !== undefined) init.body = body;
  if (opts.signal !== undefined) init.signal = opts.signal;
  const res = await fetch(url, init);

  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, errBody.error ?? "unknown_error");
  }
  // 204 no content
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

/** Constrói URL absoluta pra snapshot. */
export function snapshotUrl(snapshotPath: string | null): string | null {
  if (!snapshotPath) return null;
  const filename = snapshotPath.split("/").pop();
  if (!filename) return null;
  const env = getClientEnv();
  return `${env.NEXT_PUBLIC_API_URL}/snapshots/${filename}`;
}
```

- [ ] **Step 2: Atualizar usos existentes no `discovery/page.tsx`**

Read `packages/web/src/app/discovery/page.tsx` e `ProbeTable.tsx` — atualizar pra usar `apiFetch` em vez de `runDiscovery`/`getLastDiscoveryReport` direto. Pode manter as funções helper em `api-client.ts` exportadas, só re-implementar usando `apiFetch`:

```typescript
import type { DiscoveryReport } from "@vipcam/shared";

export async function getLastDiscoveryReport(): Promise<DiscoveryReport | null> {
  try {
    const r = await apiFetch<{ report: DiscoveryReport }>("/api/discovery/last-report");
    return r.report;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export async function runDiscovery(captureSeconds?: number): Promise<DiscoveryReport> {
  const r = await apiFetch<{ report: DiscoveryReport }>("/api/discovery/probe", {
    method: "POST",
    body: captureSeconds !== undefined ? { capture_seconds: captureSeconds } : {},
  });
  return r.report;
}
```

- [ ] **Step 3: Verify typecheck + build**

```bash
cd packages/web && bun run typecheck && bun run build 2>&1 | tail -10
```

Expected: build OK.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/lib/api-client.ts
git commit -m "refactor(web): apiFetch wrapper with X-API-Key + typed ApiError"
```

---

### Task 3.3.4: Providers + Query Client + Toaster

**Goal:** Setup do React Query no app + Toaster (sonner) pra notificações globais.

**Files:**
- Create: `packages/web/src/app/providers.tsx`
- Modify: `packages/web/src/app/layout.tsx`

- [ ] **Step 1: Criar `app/providers.tsx`**

```typescript
"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { useState } from "react";
import { Toaster } from "@/components/ui/sonner";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30 * 1000, // 30s default
            refetchOnWindowFocus: true,
            retry: 1,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster richColors position="top-right" />
      {process.env.NODE_ENV === "development" && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  );
}
```

- [ ] **Step 2: Atualizar `app/layout.tsx`**

```typescript
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Providers } from "./providers";
import { Topbar } from "@/components/topbar";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "VipCam Dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className={inter.className}>
        <Providers>
          <div className="min-h-screen flex flex-col">
            <Topbar />
            <main className="flex-1 bg-slate-50">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
```

- [ ] **Step 3: Verify build (com Topbar como placeholder ainda)**

Vamos criar Topbar no próximo step. Por enquanto, criar stub vazio.

```bash
mkdir -p packages/web/src/components
cat > packages/web/src/components/topbar.tsx <<'EOF'
export function Topbar() {
  return <header className="h-12 border-b bg-slate-900 text-white flex items-center px-4">VipCam (placeholder)</header>;
}
EOF
cd packages/web && bun run typecheck && bun run build 2>&1 | tail -10
```

Expected: build OK.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/app/providers.tsx packages/web/src/app/layout.tsx packages/web/src/components/topbar.tsx
git commit -m "feat(web): React Query + Toaster providers + layout shell"
```

---

### Task 3.3.5: Topbar real com dashboard summary

**Goal:** Implementar o topbar (B do mockup) com tabs Live/People/Matches + badge count de pending matches.

**Files:**
- Modify: `packages/web/src/components/topbar.tsx`
- Create: `packages/web/src/lib/queries/dashboard.ts`
- Test: `packages/web/tests/unit/components/topbar.test.tsx`

- [ ] **Step 1: Criar `lib/queries/dashboard.ts`**

```typescript
import { useQuery } from "@tanstack/react-query";
import type { DashboardSummary } from "@vipcam/shared";
import { apiFetch } from "../api-client";

export function useDashboardSummary() {
  return useQuery<DashboardSummary>({
    queryKey: ["dashboard", "summary"],
    queryFn: ({ signal }) => apiFetch<DashboardSummary>("/api/dashboard/summary", { signal }),
    refetchInterval: 30 * 1000, // poll a cada 30s pra badge ficar atualizado
  });
}
```

- [ ] **Step 2: Implementar topbar real**

```typescript
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Users, AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useDashboardSummary } from "@/lib/queries/dashboard";

const TABS = [
  { href: "/live", label: "Live", icon: Activity },
  { href: "/people", label: "Pessoas", icon: Users },
  { href: "/matches", label: "Matches", icon: AlertCircle },
] as const;

export function Topbar() {
  const pathname = usePathname();
  const { data } = useDashboardSummary();
  const pendingMatches = data?.pending_matches ?? 0;

  return (
    <header className="h-12 border-b bg-slate-900 text-white flex items-center px-4 gap-6">
      <div className="font-bold text-yellow-400">VipCam</div>
      <nav className="flex gap-1">
        {TABS.map((tab) => {
          const active = pathname?.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 text-sm rounded transition-colors",
                active ? "bg-slate-700" : "hover:bg-slate-800 text-slate-200",
              )}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
              {tab.label === "Matches" && pendingMatches > 0 && (
                <Badge variant="destructive" className="ml-1 h-5 px-1.5">
                  {pendingMatches}
                </Badge>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="ml-auto text-xs text-slate-400">
        {data?.last_detection_at ? `última detecção: ${new Date(data.last_detection_at).toLocaleTimeString()}` : "sem detecções"}
      </div>
    </header>
  );
}
```

- [ ] **Step 3: Test do topbar (RED) — atenção a JSX, mock ordering, imports**

⚠ **Ordering crítico:** `mock.module()` deve rodar ANTES do import que resolve o módulo. Em Bun isso é hoisted automaticamente, MAS pra ser explícito vamos usar dynamic import do Topbar pra garantir.

```typescript
import { describe, expect, test, mock } from "bun:test";
import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";

// Mock ANTES do import dinâmico do Topbar
mock.module("../../../src/lib/api-client", () => ({
  apiFetch: async () => ({
    pending_matches: 3,
    last_detection_at: "2026-05-14T13:00:00Z",
    detections_today: 47,
    persons_total: { client: 30, employee: 369 },
  }),
  ApiError: class extends Error { status = 0; code = ""; },
  snapshotUrl: () => null,
}));

// Mock pra usePathname (next/navigation só funciona em Next runtime)
mock.module("next/navigation", () => ({
  usePathname: () => "/live",
}));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("Topbar", () => {
  test("renderiza tabs e badge de matches", async () => {
    // Dynamic import pós-mock pra garantir mock aplicado
    const { Topbar } = await import("../../../src/components/topbar");
    render(wrap(<Topbar />));
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByText("Pessoas")).toBeTruthy();
    expect(screen.getByText("Matches")).toBeTruthy();
    // Badge aparece após a query resolver
    const badge = await screen.findByText("3");
    expect(badge).toBeTruthy();
  });
});
```

Observações:
- Removido `@testing-library/jest-dom` matchers (`.toBeInTheDocument()`) — Bun test não vem com eles. Use `expect(node).toBeTruthy()` ou checks manuais.
- Mock do `next/navigation.usePathname` necessário pra evitar erro "useContext outside Next runtime".

- [ ] **Step 4: Setup test runner pra DOM**

Bun test precisa do `happy-dom` registrado (já adicionado como dev dep no Step 1 do Task 3.3.1). Configurar:

`packages/web/bunfig.toml`:

```toml
[test]
preload = ["./tests/preload.ts"]
```

`packages/web/tests/preload.ts`:

```typescript
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
```

- [ ] **Step 5: GREEN + commit**

```bash
cd packages/web && bun test tests/unit/components/topbar.test.tsx 2>&1 | tail -5
git add packages/web/src/components/topbar.tsx packages/web/src/lib/queries/dashboard.ts packages/web/tests/unit/components/topbar.test.tsx packages/web/tests/preload.ts packages/web/bunfig.toml packages/web/package.json packages/web/bun.lockb
git commit -m "feat(web): real topbar with dashboard summary query + matches badge"
```

---

### Task 3.3.6: Roteamento + redirect home → /live + page placeholders

**Goal:** Definir as 4 rotas (live, people, people/[id], matches). Cada page é um placeholder mostrando "em construção" — o conteúdo real vem nos Chunks 3.4 e 3.5.

**Files:**
- Modify: `packages/web/src/app/page.tsx` (redirect)
- Create: `packages/web/src/app/live/page.tsx`, `packages/web/src/app/people/page.tsx`, `packages/web/src/app/people/[id]/page.tsx`, `packages/web/src/app/matches/page.tsx`

- [ ] **Step 1: Redirect home → /live**

`app/page.tsx`:

```typescript
import { redirect } from "next/navigation";

export default function HomePage() {
  redirect("/live");
}
```

- [ ] **Step 2: Placeholders**

`app/live/page.tsx`:

```typescript
export default function LivePage() {
  return (
    <div className="container mx-auto p-6">
      <h1 className="text-2xl font-semibold mb-4">Live feed</h1>
      <p className="text-slate-500">Em construção — Chunk 3.5.</p>
    </div>
  );
}
```

Análogo pra `people/page.tsx`, `people/[id]/page.tsx`, `matches/page.tsx` (mudando o texto).

- [ ] **Step 3: Build + commit**

```bash
cd packages/web && bun run build 2>&1 | tail -10
# Esperado: 6 rotas total (/, /live, /people, /people/[id], /matches, /discovery)
# Note: / é redirect → não aparece no static output, só as 5 páginas reais
git add packages/web/src/app
git commit -m "feat(web): route shell — /live /people /people/[id] /matches placeholders"
```

---

### Task 3.3.7: Verificação final do Chunk 3.3

- [ ] **Step 1: Tests + build**

```bash
cd packages/web && bun test && bun run build 2>&1 | tail -10
```

Expected: tests pass, build OK.

- [ ] **Step 2: Smoke manual**

```bash
# Em outro terminal (no host de dev ou via bun run dev no VPS)
cd packages/web && bun run dev
# Browser em http://localhost:3000 — deve redirect pra /live e mostrar topbar
```

Verificar visualmente: topbar renderiza, badge de matches mostra contagem real, tabs navegam.

**Checkpoint Chunk 3.3 atingido:** Frontend tem topbar funcional + roteamento. Próximos chunks preenchem as 4 telas com conteúdo real.

---

## Chunk 3.4 — People & Profile

**Goal:** Telas `/people` (tabela densa) e `/people/[id]` (stack de visitas). Operador pode buscar pessoas e ver histórico completo.

**Files affected:**
- Create: `packages/web/src/lib/queries/persons.ts`, `packages/web/src/components/person-table.tsx`, `packages/web/src/components/visit-card.tsx`
- Modify: `packages/web/src/app/people/page.tsx`, `packages/web/src/app/people/[id]/page.tsx`
- Test: `packages/web/tests/unit/components/person-table.test.tsx`, `packages/web/tests/unit/components/visit-card.test.tsx`

---

### Task 3.4.1: React Query hooks pra persons + sessions

**Goal:** Wrappers tipados pra os endpoints `/api/persons*` + `/api/sessions/*/detections`.

**Files:**
- Create: `packages/web/src/lib/queries/persons.ts`

- [ ] **Step 1: Implementar `lib/queries/persons.ts`**

```typescript
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { PaginatedResponse, PersonDetail, PersonSummary, SessionWithDetections } from "@vipcam/shared";
import { apiFetch } from "../api-client";

export interface UsePeopleParams {
  type?: "client" | "employee";
  search?: string;
  limit?: number;
  offset?: number;
}

export function usePeople(params: UsePeopleParams) {
  const search = new URLSearchParams();
  if (params.type) search.set("type", params.type);
  if (params.search) search.set("search", params.search);
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.offset !== undefined) search.set("offset", String(params.offset));
  const qs = search.toString();

  return useQuery<PaginatedResponse<PersonSummary>>({
    queryKey: ["persons", "list", params],
    queryFn: ({ signal }) =>
      apiFetch<PaginatedResponse<PersonSummary>>(`/api/persons${qs ? `?${qs}` : ""}`, { signal }),
    placeholderData: keepPreviousData, // mantém UI estável durante search rápido
  });
}

export function usePerson(id: string) {
  return useQuery<PersonDetail>({
    queryKey: ["persons", "detail", id],
    queryFn: ({ signal }) => apiFetch<PersonDetail>(`/api/persons/${id}`, { signal }),
    enabled: !!id,
  });
}

export function usePersonSessions(id: string, limit = 20) {
  return useQuery<SessionWithDetections[]>({
    queryKey: ["persons", "sessions", id, limit],
    queryFn: async ({ signal }) => {
      const r = await apiFetch<{ items: SessionWithDetections[] }>(
        `/api/persons/${id}/sessions?limit=${limit}`,
        { signal },
      );
      return r.items;
    },
    enabled: !!id,
  });
}
```

- [ ] **Step 2: Verify typecheck + commit**

```bash
cd packages/web && bun run typecheck
git add packages/web/src/lib/queries/persons.ts
git commit -m "feat(web): React Query hooks for persons + sessions endpoints"
```

---

### Task 3.4.2: Componente `<PersonTable>` (TDD unit)

**Goal:** Tabela densa shadcn com search input + filtro tipo + paginação. Reusable em `/people` e potencialmente outras telas.

**Files:**
- Create: `packages/web/src/components/person-table.tsx`
- Create: `packages/web/tests/unit/components/person-table.test.tsx`

- [ ] **Step 1: Test (RED)**

```typescript
import { describe, expect, test, mock } from "bun:test";
import * as React from "react";
import { render, screen } from "@testing-library/react";
import type { PersonSummary } from "@vipcam/shared";

const samples: PersonSummary[] = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    display_name: "Ana Costa",
    person_type: "client",
    photo_path: null,
    last_seen_at: "2026-05-14T13:00:00Z",
    total_visits: 14,
    erp_client_id: "100",
    erp_employee_id: null,
    phone: "11999",
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    display_name: "João Silva",
    person_type: "employee",
    photo_path: null,
    last_seen_at: null,
    total_visits: 1,
    erp_client_id: null,
    erp_employee_id: "10",
    phone: null,
  },
];

mock.module("../../../src/lib/queries/persons", () => ({
  usePeople: () => ({ data: { items: samples, total: 2 }, isLoading: false }),
}));

describe("<PersonTable>", () => {
  test("renderiza linhas com nome, tipo, telefone, total_visits", async () => {
    const { PersonTable } = await import("../../../src/components/person-table");
    render(<PersonTable />);
    expect(screen.getByText("Ana Costa")).toBeTruthy();
    expect(screen.getByText("João Silva")).toBeTruthy();
    expect(screen.getByText("11999")).toBeTruthy();
    expect(screen.getByText("14")).toBeTruthy();
  });

  test("renderiza search input + select de tipo", async () => {
    const { PersonTable } = await import("../../../src/components/person-table");
    render(<PersonTable />);
    expect(screen.getByPlaceholderText(/buscar/i)).toBeTruthy();
    expect(screen.getByRole("combobox")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Implementar `components/person-table.tsx`**

```typescript
"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { usePeople, type UsePeopleParams } from "@/lib/queries/persons";
import { snapshotUrl } from "@/lib/api-client";
import { formatDistanceToNow } from "@/lib/dates";

export function PersonTable() {
  const [search, setSearch] = useState("");
  const [type, setType] = useState<"all" | "client" | "employee">("all");
  const [page, setPage] = useState(0);
  const limit = 50;

  const params: UsePeopleParams = { limit, offset: page * limit };
  if (type !== "all") params.type = type;
  if (search) params.search = search;
  const { data, isLoading, isFetching } = usePeople(params);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const maxPage = Math.max(0, Math.ceil(total / limit) - 1);

  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center">
        <Input
          placeholder="🔍 Buscar nome ou telefone…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          className="max-w-md"
        />
        <Select value={type} onValueChange={(v) => { setType(v as never); setPage(0); }}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            <SelectItem value="client">Clientes</SelectItem>
            <SelectItem value="employee">Funcionários</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-sm text-slate-500 ml-auto">
          {isFetching ? "atualizando…" : `${total} pessoa${total === 1 ? "" : "s"}`}
        </span>
      </div>

      <div className="border rounded-md bg-white">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pessoa</TableHead>
              <TableHead className="w-32">Tipo</TableHead>
              <TableHead className="w-40">Última visita</TableHead>
              <TableHead className="w-24 text-right">Visitas</TableHead>
              <TableHead className="w-40">Telefone</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={5}><Skeleton className="h-6" /></TableCell>
                </TableRow>
              ))
            ) : items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-slate-500 py-8">
                  Nenhuma pessoa encontrada
                </TableCell>
              </TableRow>
            ) : (
              items.map((p) => (
                <TableRow key={p.id} className="hover:bg-slate-50">
                  <TableCell>
                    <Link href={`/people/${p.id}`} className="flex items-center gap-2">
                      <Avatar className="w-8 h-8">
                        <AvatarFallback>{(p.display_name ?? "?").slice(0, 2)}</AvatarFallback>
                      </Avatar>
                      <span className="font-medium">{p.display_name ?? "Anônimo"}</span>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={p.person_type === "client" ? "default" : "secondary"}>
                      {p.person_type === "client" ? "Cliente" : p.person_type === "employee" ? "Funcionário" : "Anônimo"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-slate-600">
                    {p.last_seen_at ? formatDistanceToNow(p.last_seen_at) : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono">{p.total_visits}</TableCell>
                  <TableCell className="text-slate-600">{p.phone ?? "—"}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {total > limit && (
        <div className="flex justify-end items-center gap-2 text-sm">
          <span className="text-slate-500">
            Página {page + 1} de {maxPage + 1}
          </span>
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
            ‹
          </Button>
          <Button variant="outline" size="sm" disabled={page >= maxPage} onClick={() => setPage(page + 1)}>
            ›
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Criar helper `lib/dates.ts`**

```typescript
const RTF = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });

export function formatDistanceToNow(iso: string): string {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return "agora";
  if (abs < 3600) return RTF.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return RTF.format(Math.round(diff / 3600), "hour");
  return RTF.format(Math.round(diff / 86400), "day");
}
```

- [ ] **Step 4: GREEN + commit**

```bash
cd packages/web && bun test tests/unit/components/person-table.test.tsx
git add packages/web/src/components/person-table.tsx packages/web/src/lib/dates.ts packages/web/tests/unit/components/person-table.test.tsx
git commit -m "feat(web): <PersonTable> with search/filter/pagination"
```

---

### Task 3.4.3: Page `/people` final

**Files:**
- Modify: `packages/web/src/app/people/page.tsx`

- [ ] **Step 1: Substituir placeholder**

```typescript
import { PersonTable } from "@/components/person-table";

export default function PeoplePage() {
  return (
    <div className="container mx-auto p-6">
      <h1 className="text-2xl font-semibold mb-4">Pessoas</h1>
      <PersonTable />
    </div>
  );
}
```

- [ ] **Step 2: Build + commit**

```bash
cd packages/web && bun run build 2>&1 | tail -10
git add packages/web/src/app/people/page.tsx
git commit -m "feat(web): /people page wired with PersonTable"
```

---

### Task 3.4.4: Componente `<VisitCard>` + page `/people/[id]`

**Goal:** Cada session = 1 card grande com timestamp, duração, fotos, breakdown de emoção, evento ERP.

**Files:**
- Create: `packages/web/src/components/visit-card.tsx`
- Create: `packages/web/tests/unit/components/visit-card.test.tsx`
- Modify: `packages/web/src/app/people/[id]/page.tsx`

- [ ] **Step 1: Test do VisitCard (RED)**

```typescript
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { render, screen } from "@testing-library/react";
import type { SessionWithDetections } from "@vipcam/shared";
import { VisitCard } from "../../../src/components/visit-card";

const sampleSession: SessionWithDetections = {
  id: "11111111-1111-1111-1111-111111111111",
  started_at: "2026-05-14T13:00:00Z",
  ended_at: "2026-05-14T13:42:00Z",
  detection_count: 18,
  dominant_emotion: "happy",
  linked_erp_checkin_id: "chk-1",
  detections: [
    {
      id: "22222222-2222-2222-2222-222222222222",
      detected_at: "2026-05-14T13:00:30Z",
      snapshot_path: "/var/lib/vipcam/snapshots/abc.jpg",
      face_attrs: { age: 30 },
      dominant_emotion: "happy",
      emotion_confidence: 0.85,
      session_id: "11111111-1111-1111-1111-111111111111",
      camera_id: "33333333-3333-3333-3333-333333333333",
    },
  ],
};

describe("<VisitCard>", () => {
  test("mostra duração calculada (start → end)", () => {
    render(<VisitCard session={sampleSession} />);
    expect(screen.getByText(/42 min/)).toBeTruthy();
  });

  test("mostra detection_count + dominant_emotion", () => {
    render(<VisitCard session={sampleSession} />);
    expect(screen.getByText(/18 detec/)).toBeTruthy();
    expect(screen.getByText(/happy/i)).toBeTruthy();
  });

  test("renderiza thumbnails das detections com snapshot", () => {
    render(<VisitCard session={sampleSession} />);
    const imgs = screen.getAllByRole("img");
    expect(imgs.length).toBeGreaterThanOrEqual(1);
  });

  test("session sem ended_at mostra 'em andamento'", () => {
    render(<VisitCard session={{ ...sampleSession, ended_at: null }} />);
    expect(screen.getByText(/em andamento/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Implementar `components/visit-card.tsx`**

```typescript
import * as React from "react";
import type { SessionWithDetections } from "@vipcam/shared";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { snapshotUrl } from "@/lib/api-client";
import { formatDistanceToNow } from "@/lib/dates";

const EMOTION_EMOJI: Record<string, string> = {
  happy: "😊", neutral: "😐", sad: "😟", angry: "😠", surprised: "😮", fear: "😨",
};

function durationMin(start: string, end: string | null): string {
  if (!end) return "em andamento";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const min = Math.round(ms / 60_000);
  return `${min} min`;
}

export function VisitCard({ session }: { session: SessionWithDetections }) {
  const visible = session.detections.slice(0, 5);
  const overflow = session.detections.length - visible.length;
  const startedDate = new Date(session.started_at);

  return (
    <Card className="mb-3">
      <CardContent className="p-4">
        <div className="flex justify-between items-start mb-3 pb-2 border-b">
          <div>
            <div className="font-semibold">
              {startedDate.toLocaleString("pt-BR")}
            </div>
            <div className="text-xs text-slate-500">{formatDistanceToNow(session.started_at)}</div>
          </div>
          <div className="text-right text-sm text-slate-600">
            {durationMin(session.started_at, session.ended_at)} · {session.detection_count} detecções
          </div>
        </div>

        {visible.length > 0 && (
          <div className="flex gap-2 mb-3">
            {visible.map((d) => {
              const url = snapshotUrl(d.snapshot_path);
              return (
                <div key={d.id} className="w-12 h-12 rounded bg-slate-200 overflow-hidden flex items-center justify-center text-xs text-slate-400">
                  {url ? (
                    <img
                      src={url}
                      alt=""
                      className="w-full h-full object-cover"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                  ) : "—"}
                </div>
              );
            })}
            {overflow > 0 && (
              <div className="w-12 h-12 rounded bg-slate-700 text-white flex items-center justify-center text-xs">
                +{overflow}
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2 text-xs text-slate-600">
          {session.dominant_emotion && (
            <Badge variant="outline">
              {EMOTION_EMOJI[session.dominant_emotion] ?? ""} {session.dominant_emotion}
            </Badge>
          )}
          {session.linked_erp_checkin_id && (
            <Badge variant="outline">checkin: {session.linked_erp_checkin_id}</Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Page `/people/[id]/page.tsx`**

```typescript
"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { VisitCard } from "@/components/visit-card";
import { usePerson, usePersonSessions } from "@/lib/queries/persons";

// Next 14 + React 18: params é objeto direto (não Promise).
// React 19 / Next 15+ mudaria pra Promise<{id}> + use(params).
export default function PersonProfilePage({ params }: { params: { id: string } }) {
  const { id } = params;
  const { data: person, isLoading: loadingPerson, error } = usePerson(id);
  const { data: sessions, isLoading: loadingSessions } = usePersonSessions(id, 30);

  if (loadingPerson) return <div className="container mx-auto p-6"><Skeleton className="h-32" /></div>;
  if (error || !person) return <div className="container mx-auto p-6 text-red-600">Pessoa não encontrada</div>;

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      {/* Header */}
      <div className="flex gap-4 mb-6 pb-4 border-b">
        <Avatar className="w-20 h-20">
          <AvatarFallback className="text-xl">{(person.display_name ?? "?").slice(0, 2)}</AvatarFallback>
        </Avatar>
        <div className="flex-1">
          <h1 className="text-2xl font-semibold">{person.display_name ?? "Anônimo"}</h1>
          <div className="text-sm text-slate-600">
            {person.person_type === "client" ? "Cliente" : person.person_type === "employee" ? "Funcionário" : "Anônimo"}
            {" · "}{person.total_visits} visita{person.total_visits === 1 ? "" : "s"}
            {person.first_seen_at && ` · primeira em ${new Date(person.first_seen_at).toLocaleDateString("pt-BR")}`}
          </div>
          {person.phone && <div className="text-sm text-slate-500">📞 {person.phone}</div>}
          <div className="flex gap-2 mt-2">
            {person.avg_dominant_emotion && (
              <Badge variant="outline">😊 Geralmente {person.avg_dominant_emotion}</Badge>
            )}
            {person.avg_visit_duration_min !== null && (
              <Badge variant="outline">~{Math.round(person.avg_visit_duration_min)} min/visita</Badge>
            )}
          </div>
        </div>
      </div>

      {/* Visits stack */}
      <div>
        <h2 className="text-lg font-semibold mb-3 text-slate-700">Histórico de visitas</h2>
        {loadingSessions ? (
          <Skeleton className="h-40" />
        ) : !sessions || sessions.length === 0 ? (
          <div className="text-slate-500 italic">Nenhuma visita registrada ainda.</div>
        ) : (
          sessions.map((s) => <VisitCard key={s.id} session={s} />)
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Build + tests + commit**

```bash
cd packages/web && bun run typecheck && bun test && bun run build 2>&1 | tail -10
git add packages/web/src/components/visit-card.tsx packages/web/src/app/people/[id]/page.tsx packages/web/tests/unit/components/visit-card.test.tsx
git commit -m "feat(web): /people/[id] profile with VisitCard stack"
```

---

### Task 3.4.5: Verificação Chunk 3.4

- [ ] **Step 1: Tests + build**

```bash
cd packages/web && bun test && bun run build
```

Expected: 0 fail.

- [ ] **Step 2: Smoke manual no dev**

Browser em /people: tabela renderiza com 369 funcionários (após o sync do Chunk 3.1 já estar deployado). Search "Ana" filtra. Click em linha → /people/<id> mostra perfil sem visitas (employees não têm session histórico).

**Checkpoint Chunk 3.4 atingido:** Operador navega lista de pessoas + vê perfis com histórico.

---

## Chunk 3.5 — Matches & Live

**Goal:** Telas `/matches` (inbox split — sidebar lista + detail panel) e `/live` (stream vertical via SSE).

**Files affected:**
- Create: `packages/web/src/lib/queries/matches.ts`, `packages/web/src/hooks/use-sse.ts`, `packages/web/src/hooks/use-live-feed.ts`, `packages/web/src/components/match-list-item.tsx`, `packages/web/src/components/match-detail.tsx`, `packages/web/src/components/detection-card.tsx`, `packages/web/src/components/live-feed.tsx`
- Modify: `packages/web/src/app/matches/page.tsx`, `packages/web/src/app/live/page.tsx`
- Test: `packages/web/tests/unit/hooks/use-sse.test.ts`, `packages/web/tests/unit/components/match-detail.test.tsx`, `packages/web/tests/unit/components/detection-card.test.tsx`

---

### Task 3.5.1: React Query hooks pra matches + mutations resolve/reject

**Files:**
- Create: `packages/web/src/lib/queries/matches.ts`

- [ ] **Step 1: Implementar**

```typescript
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { MatchPendingEnriched } from "@vipcam/shared";
import { ApiError, apiFetch } from "../api-client";

export function useMatchesPending() {
  return useQuery<MatchPendingEnriched[]>({
    queryKey: ["matches", "pending"],
    queryFn: async ({ signal }) => {
      const r = await apiFetch<{ items: MatchPendingEnriched[] } | MatchPendingEnriched[]>(
        "/api/matches/pending",
        { signal },
      );
      // Backend retorna `{ items }` na rota wrapper; adaptar se mudar
      return Array.isArray(r) ? r : r.items;
    },
    refetchInterval: 30 * 1000, // poll
  });
}

export function useResolveMatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string; chosen_detection_id: string; chosen_person_id: string }) => {
      await apiFetch<{ ok: true }>(`/api/matches/${params.id}/resolve`, {
        method: "POST",
        body: { chosen_detection_id: params.chosen_detection_id, chosen_person_id: params.chosen_person_id },
      });
    },
    onSuccess: () => {
      toast.success("Match resolvido");
      void qc.invalidateQueries({ queryKey: ["matches"] });
      void qc.invalidateQueries({ queryKey: ["dashboard", "summary"] });
    },
    onError: (e) => {
      const msg = e instanceof ApiError ? `${e.status} ${e.code}` : String(e);
      toast.error(`Erro ao resolver: ${msg}`);
    },
  });
}

export function useRejectMatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string; reason?: string }) => {
      await apiFetch<{ ok: true }>(`/api/matches/${params.id}/reject`, {
        method: "POST",
        body: params.reason ? { reason: params.reason } : {},
      });
    },
    onSuccess: () => {
      toast.success("Match rejeitado");
      void qc.invalidateQueries({ queryKey: ["matches"] });
      void qc.invalidateQueries({ queryKey: ["dashboard", "summary"] });
    },
  });
}
```

- [ ] **Step 2: Verify typecheck + commit**

```bash
cd packages/web && bun run typecheck
git add packages/web/src/lib/queries/matches.ts
git commit -m "feat(web): React Query hooks for matches (list + resolve + reject mutations)"
```

---

### Task 3.5.2: Componente `<MatchDetail>` (TDD unit)

**Files:**
- Create: `packages/web/src/components/match-detail.tsx`
- Create: `packages/web/tests/unit/components/match-detail.test.tsx`

- [ ] **Step 1: Test (RED)**

```typescript
import { describe, expect, test, mock } from "bun:test";
import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import type { MatchPendingEnriched } from "@vipcam/shared";

let resolveCalls = 0;
let rejectCalls = 0;
mock.module("../../../src/lib/queries/matches", () => ({
  useResolveMatch: () => ({ mutate: () => { resolveCalls += 1; }, isPending: false }),
  useRejectMatch: () => ({ mutate: () => { rejectCalls += 1; }, isPending: false }),
}));
mock.module("../../../src/lib/api-client", () => ({
  apiFetch: async () => ({}),
  snapshotUrl: () => null,
  ApiError: class extends Error { status = 0; code = ""; },
}));

const sample: MatchPendingEnriched = {
  match_attempt_id: "11111111-1111-1111-1111-111111111111",
  decided_at: "2026-05-14T13:00:00Z",
  notes: "3 candidates",
  checkin: {
    erp_id: "chk-1",
    client_name: "Ana Costa",
    client_phone: "11999",
    erp_client_id: "100",
    person_id: "99999999-9999-9999-9999-999999999999",
    occurred_at: "2026-05-14T12:58:00Z",
    event_type: "appointment_confirmed",
  },
  candidates: [
    {
      id: "22222222-2222-2222-2222-222222222222",
      detected_at: "2026-05-14T12:57:30Z",
      snapshot_path: null, face_attrs: { age: 32, gender: "Female" },
      dominant_emotion: "happy", emotion_confidence: 0.8,
      session_id: "ss1", camera_id: "cam-1",
    },
  ],
};

describe("<MatchDetail>", () => {
  test("renderiza checkin info + candidates", async () => {
    const { MatchDetail } = await import("../../../src/components/match-detail");
    render(<MatchDetail match={sample} />);
    expect(screen.getByText("Ana Costa")).toBeTruthy();
    expect(screen.getByText(/11999/)).toBeTruthy();
    expect(screen.getByText(/3 candidates/i)).toBeTruthy();
  });

  test("clique 'É essa pessoa' chama useResolveMatch", async () => {
    resolveCalls = 0;
    const { MatchDetail } = await import("../../../src/components/match-detail");
    render(<MatchDetail match={sample} />);
    const btn = screen.getAllByText(/é essa pessoa/i)[0]!;
    fireEvent.click(btn);
    expect(resolveCalls).toBe(1);
  });

  test("clique 'Rejeitar' chama useRejectMatch", async () => {
    rejectCalls = 0;
    const { MatchDetail } = await import("../../../src/components/match-detail");
    render(<MatchDetail match={sample} />);
    fireEvent.click(screen.getByText(/rejeitar/i));
    expect(rejectCalls).toBe(1);
  });
});
```

- [ ] **Step 2: Implementar `components/match-detail.tsx`**

```typescript
"use client";

import type { DetectionThumbnail, MatchPendingEnriched } from "@vipcam/shared";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { snapshotUrl } from "@/lib/api-client";
import { useRejectMatch, useResolveMatch } from "@/lib/queries/matches";

export function MatchDetail({ match }: { match: MatchPendingEnriched }) {
  const resolve = useResolveMatch();
  const reject = useRejectMatch();

  const handleResolve = (det: DetectionThumbnail) => {
    // person_id vem JÁ resolvido pelo backend (Chunk 3.1 Task 3.1.8 faz JOIN
    // persons WHERE erp_client_id = checkin.erp_client_id).
    // Se for null, cliente não tem Person registrada — bloquear com toast.
    if (!match.checkin.person_id) {
      toast.error("Cliente sem Person registrada — sync ERP precisa rodar primeiro.");
      return;
    }
    resolve.mutate({
      id: match.match_attempt_id,
      chosen_detection_id: det.id,
      chosen_person_id: match.checkin.person_id,
    });
  };

  return (
    <div className="p-4 space-y-3">
      <div className="border-b pb-2">
        <div className="font-semibold text-lg">{match.checkin.client_name ?? "Cliente sem nome"}</div>
        <div className="text-sm text-slate-600">
          📞 {match.checkin.client_phone ?? "—"} · checkin {match.checkin.event_type}{" "}
          {new Date(match.checkin.occurred_at).toLocaleTimeString("pt-BR")}
        </div>
        {match.notes && (
          <Badge variant="outline" className="mt-1 text-xs">{match.notes}</Badge>
        )}
      </div>

      {match.candidates.length === 0 ? (
        <div className="text-slate-500 italic py-4">Nenhuma candidata visível na janela. Apenas rejeite.</div>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {match.candidates.map((det) => {
            const url = snapshotUrl(det.snapshot_path);
            return (
              <div key={det.id} className="border rounded-md p-2 text-center">
                <div className="h-24 bg-slate-200 rounded mb-2 overflow-hidden flex items-center justify-center text-slate-400 text-xs">
                  {url ? <img src={url} alt="" className="w-full h-full object-cover" /> : "sem foto"}
                </div>
                <div className="text-xs text-slate-600 mb-1">
                  {new Date(det.detected_at).toLocaleTimeString("pt-BR")}
                </div>
                <div className="text-[10px] text-slate-500 mb-2">
                  {(det.face_attrs.gender as string ?? "?")} · {(det.face_attrs.age as number ?? "?")} · {det.dominant_emotion ?? "—"}
                </div>
                <Button
                  size="sm"
                  className="w-full text-xs"
                  disabled={resolve.isPending}
                  onClick={() => handleResolve(det)}
                >
                  É essa pessoa
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2 border-t">
        <Button
          variant="outline"
          size="sm"
          disabled={reject.isPending}
          onClick={() => reject.mutate({ id: match.match_attempt_id, reason: "operator rejection" })}
        >
          Rejeitar
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: GREEN + commit**

```bash
cd packages/web && bun test tests/unit/components/match-detail.test.tsx
git add packages/web/src/components/match-detail.tsx packages/web/tests/unit/components/match-detail.test.tsx
git commit -m "feat(web): <MatchDetail> resolve/reject with person_id from checkin enrichment"
```

---

### Task 3.5.3: Page `/matches` com inbox split

**Files:**
- Create: `packages/web/src/components/match-list-item.tsx`
- Modify: `packages/web/src/app/matches/page.tsx`

- [ ] **Step 1: Componente list item**

```typescript
"use client";

import type { MatchPendingEnriched } from "@vipcam/shared";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/dates";

export function MatchListItem({
  match,
  active,
  onClick,
}: {
  match: MatchPendingEnriched;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left p-2 border-b hover:bg-slate-100 transition",
        active && "bg-blue-50 border-l-4 border-l-slate-900",
      )}
    >
      <div className="font-semibold text-sm">{match.checkin.client_name ?? "?"}</div>
      <div className="text-xs text-slate-600">
        {match.candidates.length} candidata{match.candidates.length === 1 ? "" : "s"} · {formatDistanceToNow(match.decided_at)}
      </div>
    </button>
  );
}
```

- [ ] **Step 2: Page matches**

```typescript
"use client";

import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { MatchDetail } from "@/components/match-detail";
import { MatchListItem } from "@/components/match-list-item";
import { useMatchesPending } from "@/lib/queries/matches";

export default function MatchesPage() {
  const { data: matches, isLoading } = useMatchesPending();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = matches ?? [];
  const selected = list.find((m) => m.match_attempt_id === selectedId) ?? list[0];

  return (
    <div className="container mx-auto p-6">
      <h1 className="text-2xl font-semibold mb-4">Matches pendentes</h1>

      <div className="bg-white border rounded-md flex" style={{ minHeight: 500 }}>
        <aside className="w-72 border-r overflow-y-auto" style={{ maxHeight: 600 }}>
          <div className="p-2 font-semibold border-b text-sm">
            {isLoading ? "carregando…" : `${list.length} pendente${list.length === 1 ? "" : "s"}`}
          </div>
          {isLoading ? (
            <div className="p-2"><Skeleton className="h-12" /></div>
          ) : list.length === 0 ? (
            <div className="p-4 text-slate-500 text-sm text-center">
              Nenhum match pendente — tudo resolvido!
            </div>
          ) : (
            list.map((m) => (
              <MatchListItem
                key={m.match_attempt_id}
                match={m}
                active={selected?.match_attempt_id === m.match_attempt_id}
                onClick={() => setSelectedId(m.match_attempt_id)}
              />
            ))
          )}
        </aside>

        <section className="flex-1">
          {selected ? (
            <MatchDetail match={selected} />
          ) : (
            <div className="p-8 text-slate-500 italic text-center">
              Selecione um match na lista
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Build + commit**

```bash
cd packages/web && bun run typecheck && bun run build
git add packages/web/src/components/match-list-item.tsx packages/web/src/app/matches/page.tsx
git commit -m "feat(web): /matches inbox split with MatchListItem + MatchDetail"
```

---

### Task 3.5.4: Hook `use-sse` (TDD unit)

**Files:**
- Create: `packages/web/src/hooks/use-sse.ts`
- Create: `packages/web/tests/unit/hooks/use-sse.test.ts`

- [ ] **Step 1: Implementar `use-sse.ts`**

```typescript
"use client";

import { useEffect, useRef, useState } from "react";

type ConnState = "connecting" | "open" | "error" | "closed";

export interface UseSseOptions<T> {
  url: string;
  onMessage: (data: T) => void;
  onError?: (err: Event) => void;
  /** Backoff inicial em ms. Default 3000. */
  initialBackoffMs?: number;
  /** Backoff máximo em ms. Default 30000. */
  maxBackoffMs?: number;
}

/**
 * Hook SSE com auto-reconnect (exponential backoff). Cancela on unmount.
 */
export function useSse<T>({ url, onMessage, onError, initialBackoffMs = 3000, maxBackoffMs = 30_000 }: UseSseOptions<T>) {
  const [state, setState] = useState<ConnState>("connecting");
  const onMsgRef = useRef(onMessage);
  onMsgRef.current = onMessage;

  useEffect(() => {
    let backoff = initialBackoffMs;
    let cancelled = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      setState("connecting");
      es = new EventSource(url);
      es.onopen = () => {
        if (cancelled) return;
        setState("open");
        backoff = initialBackoffMs;
      };
      es.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(ev.data) as T;
          onMsgRef.current(parsed);
        } catch (err) {
          console.warn("SSE parse error", err);
        }
      };
      es.onerror = (err) => {
        if (cancelled) return;
        setState("error");
        onError?.(err);
        es?.close();
        reconnectTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, maxBackoffMs);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
      setState("closed");
    };
  }, [url, initialBackoffMs, maxBackoffMs, onError]);

  return { state };
}
```

- [ ] **Step 2: Test (RED→GREEN)**

```typescript
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderHook } from "@testing-library/react";

// Mock EventSource global pra Bun test
class MockEventSource {
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    setTimeout(() => this.onopen?.(), 5);
  }
  close() { this.closed = true; }
}
(globalThis as { EventSource: typeof MockEventSource }).EventSource = MockEventSource;

import { useSse } from "../../../src/hooks/use-sse";

describe("useSse", () => {
  test("conecta e atualiza state pra 'open'", async () => {
    const { result, unmount } = renderHook(() =>
      useSse({ url: "http://x/api/events/stream", onMessage: () => {} }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.state).toBe("open");
    unmount();
  });
});
```

- [ ] **Step 3: GREEN + commit**

```bash
cd packages/web && bun test tests/unit/hooks/use-sse.test.ts
git add packages/web/src/hooks/use-sse.ts packages/web/tests/unit/hooks/use-sse.test.ts
git commit -m "feat(web): useSse hook with auto-reconnect (exponential backoff)"
```

---

### Task 3.5.5: Componente `<DetectionCard>` + page `/live`

**Files:**
- Create: `packages/web/src/components/detection-card.tsx`
- Create: `packages/web/src/components/live-feed.tsx`
- Modify: `packages/web/src/app/live/page.tsx`

- [ ] **Step 1: DetectionCard**

```typescript
import type { LiveDetectionEvent } from "@vipcam/shared";
import { Badge } from "@/components/ui/badge";
import { snapshotUrl } from "@/lib/api-client";
import { formatDistanceToNow } from "@/lib/dates";

const EMOJI: Record<string, string> = { happy: "😊", neutral: "😐", sad: "😟", angry: "😠", surprised: "😮" };

export function DetectionCard({ event, fresh }: { event: LiveDetectionEvent; fresh?: boolean }) {
  const url = snapshotUrl(event.detection.snapshot_path);
  const personLabel = event.person?.display_name ?? "Anônimo";
  const personType = event.person?.person_type;
  return (
    <div className={`bg-white border rounded-md p-3 flex gap-3 mb-2 ${fresh ? "border-green-500" : ""}`}>
      {/* fresh=true só destaca borda verde por 3s; animação custom seria animate-pulse infinita — overkill */}
      <div className="w-16 h-16 rounded bg-slate-200 overflow-hidden flex items-center justify-center text-xs text-slate-400">
        {url ? <img src={url} alt="" className="w-full h-full object-cover" /> : "—"}
      </div>
      <div className="flex-1">
        <div className="flex justify-between">
          <div className="font-semibold text-sm">
            {personLabel}{" "}
            {personType && (
              <Badge variant={personType === "client" ? "default" : "secondary"} className="text-[10px]">
                {personType}
              </Badge>
            )}
          </div>
          <div className="text-xs text-slate-500">{formatDistanceToNow(event.detection.detected_at)}</div>
        </div>
        <div className="text-xs text-slate-600 mt-1">
          {(event.detection.face_attrs.gender as string ?? "?")} · {(event.detection.face_attrs.age as number ?? "?")} ·
          {" "}{EMOJI[event.detection.dominant_emotion ?? ""]} {event.detection.dominant_emotion ?? "—"}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: LiveFeed container com ring buffer**

```typescript
"use client";

import { useCallback, useRef, useState } from "react";
import type { LiveDetectionEvent } from "@vipcam/shared";
import { Button } from "@/components/ui/button";
import { DetectionCard } from "@/components/detection-card";
import { useSse } from "@/hooks/use-sse";
import { getClientEnv } from "@/lib/env";

const MAX_EVENTS = 50;

export function LiveFeed() {
  const env = getClientEnv();
  const url = `${env.NEXT_PUBLIC_API_URL}/api/events/stream?api_key=${encodeURIComponent(env.NEXT_PUBLIC_API_KEY)}`;
  const [events, setEvents] = useState<LiveDetectionEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  const onMessage = useCallback((data: LiveDetectionEvent) => {
    if (pausedRef.current) return;
    if (data.type !== "detection") return;
    setEvents((prev) => [data, ...prev].slice(0, MAX_EVENTS));
  }, []);

  const { state } = useSse<LiveDetectionEvent>({ url, onMessage });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 bg-white border rounded-md p-3">
        <div className="text-sm">
          <span className={state === "open" ? "text-green-600" : "text-red-600"}>●</span>{" "}
          {state === "open" ? "conectado" : state}
        </div>
        <div className="text-sm text-slate-500">
          {events.length} detec{events.length === 1 ? "ção" : "ções"} no buffer
        </div>
        <Button
          variant="outline"
          size="sm"
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
          events.map((e, i) => (
            <DetectionCard key={`${e.detection.id}-${i}`} event={e} fresh={i === 0} />
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Page /live**

```typescript
import { LiveFeed } from "@/components/live-feed";

export default function LivePage() {
  return (
    <div className="container mx-auto p-6 max-w-3xl">
      <h1 className="text-2xl font-semibold mb-4">Live feed</h1>
      <LiveFeed />
    </div>
  );
}
```

- [ ] **Step 4: Test componente DetectionCard (RED)**

```typescript
import { describe, expect, test, mock } from "bun:test";
import * as React from "react";
import { render, screen } from "@testing-library/react";
import type { LiveDetectionEvent } from "@vipcam/shared";

mock.module("../../../src/lib/api-client", () => ({
  snapshotUrl: () => null,
  apiFetch: async () => ({}),
  ApiError: class extends Error { status = 0; code = ""; },
}));

const event: LiveDetectionEvent = {
  type: "detection",
  detection: {
    id: "11111111-1111-1111-1111-111111111111",
    detected_at: new Date().toISOString(),
    snapshot_path: null,
    face_attrs: { age: 30, gender: "Female" },
    dominant_emotion: "happy",
    emotion_confidence: 0.85,
    session_id: null,
    camera_id: "22222222-2222-2222-2222-222222222222",
  },
  person: {
    id: "33333333-3333-3333-3333-333333333333",
    display_name: "Ana",
    person_type: "client",
    photo_path: null, last_seen_at: null, total_visits: 1,
    erp_client_id: "100", erp_employee_id: null, phone: null,
  },
};

describe("<DetectionCard>", () => {
  test("mostra nome da person + emoção", async () => {
    const { DetectionCard } = await import("../../../src/components/detection-card");
    render(<DetectionCard event={event} />);
    expect(screen.getByText("Ana")).toBeTruthy();
    expect(screen.getByText(/happy/)).toBeTruthy();
  });

  test("anônimo quando person é null", async () => {
    const { DetectionCard } = await import("../../../src/components/detection-card");
    render(<DetectionCard event={{ ...event, person: null }} />);
    expect(screen.getByText("Anônimo")).toBeTruthy();
  });
});
```

- [ ] **Step 5: GREEN + build + commit**

```bash
cd packages/web && bun test tests/unit/components/detection-card.test.tsx && bun run build
git add packages/web/src/components/detection-card.tsx packages/web/src/components/live-feed.tsx packages/web/src/app/live/page.tsx packages/web/tests/unit/components/detection-card.test.tsx
git commit -m "feat(web): /live page with SSE stream + ring buffer + pause"
```

---

### Task 3.5.6: Verificação Chunk 3.5

- [ ] **Step 1: Tests + build**

```bash
cd packages/web && bun test && bun run build
```

- [ ] **Step 2: Smoke E2E manual**

Browser:
- /matches: lista mostra ambíguos pendentes; click numa item carrega detail; resolve/reject funcionam (refetch automático)
- /live: stream conecta (●verde); pausar funciona; cards aparecem ao real-time

**Checkpoint Chunk 3.5 atingido:** Sistema operacional completo. Operador resolve ambíguos via UI + observa atividade ao vivo.

---

## Chunk 3.6 — Polish + deploy

**Goal:** Acabamentos de UX (a11y, error boundaries, loading states finais), deploy ao VPS, smoke test em produção.

**Files affected:**
- Create: `packages/web/src/app/error.tsx`, `packages/web/src/app/not-found.tsx`
- Modify: vários componentes pra a11y (aria-labels, focus rings)
- Modify: `scripts/deploy.sh` se precisar (talvez NEXT_PUBLIC_* envs)

---

### Task 3.6.1: Error boundary + 404 global

**Files:**
- Create: `packages/web/src/app/error.tsx`, `packages/web/src/app/not-found.tsx`

**TDD nota:** convention files do Next.js (`error.tsx`, `not-found.tsx`) são acionados pelo router framework — testá-los isoladamente requer setup pesado. **Skip TDD aqui** (validação visual via smoke test em 3.6.4).

- [ ] **Step 1: Implementar**

```typescript
// app/error.tsx
"use client";
export default function ErrorBoundary({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="container mx-auto p-12 text-center">
      <h2 className="text-xl font-semibold mb-2">Algo deu errado</h2>
      <p className="text-slate-600 mb-4">{error.message}</p>
      <button onClick={reset} className="px-4 py-2 bg-slate-900 text-white rounded">Tentar de novo</button>
    </div>
  );
}
```

```typescript
// app/not-found.tsx
import Link from "next/link";
export default function NotFound() {
  return (
    <div className="container mx-auto p-12 text-center">
      <h2 className="text-xl font-semibold mb-2">Página não encontrada</h2>
      <Link href="/live" className="text-blue-600">← Voltar pro Live</Link>
    </div>
  );
}
```

- [ ] **Step 2: Build + commit**

```bash
cd packages/web && bun run build
git add packages/web/src/app/error.tsx packages/web/src/app/not-found.tsx
git commit -m "feat(web): global error boundary + 404 page"
```

---

### Task 3.6.2: A11y básico — aria-labels + focus rings

**Files:**
- Modify: `packages/web/src/components/topbar.tsx`, `match-list-item.tsx`, `person-table.tsx`

- [ ] **Step 1: Adicionar aria-label nos botões/links sem texto óbvio**

- Topbar: `<Link aria-label={tab.label}>`
- match-list-item button: já é text — OK
- Botões de paginação: `aria-label="Página anterior" / "Próxima página"`
- Pause button: `aria-label="Pausar/Retomar live feed"`

- [ ] **Step 2: Verificar focus rings via Tailwind**

shadcn/ui já vem com `focus-visible:ring-2 focus-visible:ring-offset-2` por default. Verificar visualmente que tab key funciona em todas as telas.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/topbar.tsx packages/web/src/components/match-list-item.tsx packages/web/src/components/person-table.tsx packages/web/src/components/live-feed.tsx
git commit -m "chore(web): a11y polish — aria-labels + focus rings"
```

---

### Task 3.6.3: Deploy script update

**Files:**
- Modify: `scripts/deploy.sh` (se necessário)

- [ ] **Step 1: Verificar se deploy.sh precisa ajuste**

Read `scripts/deploy.sh`. O `next build` precisa das envs `NEXT_PUBLIC_*` em build time (inlining). 2 caminhos:

**Opção A (recomendado):** envs em `/etc/vipcam/web.env` (separado do edge.env). deploy.sh sourceia antes do `bun run build`:

```bash
# Em scripts/deploy.sh, antes de "next build":
WEB_ENV="/etc/vipcam/web.env"
if [[ -f "$WEB_ENV" ]]; then
  log "carregando $WEB_ENV pra build do Next"
  sudo -u "$SERVICE_USER" bash -c "
    cd packages/web
    set -a; source $WEB_ENV; set +a
    bun run build
  "
else
  warn "$WEB_ENV não existe — Next vai buildar com defaults (NEXT_PUBLIC_* faltantes vão quebrar runtime)"
fi
```

**Opção B (mais simples):** reusar `/etc/vipcam/edge.env` mas adicionar `NEXT_PUBLIC_API_URL` e `NEXT_PUBLIC_API_KEY` lá. Risco: misturar config edge com web.

Decisão: **A**. Cria arquivo separado.

- [ ] **Step 2: Aplicar mudanças no deploy.sh + criar `/etc/vipcam/web.env.example`**

```bash
# /etc/vipcam/web.env (no VPS — não commitado, criar manualmente)
NEXT_PUBLIC_API_URL=https://monitoramento.franquiabv.com.br
NEXT_PUBLIC_API_KEY=<mesma chave do edge.env>
```

- [ ] **Step 3: Commit**

```bash
git add scripts/deploy.sh
git commit -m "chore(deploy): source /etc/vipcam/web.env before next build for NEXT_PUBLIC_* vars"
```

---

### Task 3.6.4: Deploy + smoke test no VPS

- [ ] **Step 1: Operador no VPS cria web.env**

```bash
sudo cp /etc/vipcam/web.env.example /etc/vipcam/web.env  # se houver example commitado
sudo nano /etc/vipcam/web.env  # editar valores
sudo chmod 640 /etc/vipcam/web.env && sudo chown root:vipcam /etc/vipcam/web.env
```

- [ ] **Step 2: Deploy**

```bash
sudo bash /opt/vipcamv2/scripts/deploy.sh master
```

Expected output:
- `bun install` OK
- `db:migrate` skipa (sem migrations novas no Onda 3 backend... ou apenas roll forward se houver)
- `next build` OK + 6 rotas
- `systemctl restart vipcam-edge vipcam-web` OK
- Healthcheck OK

- [ ] **Step 3: Smoke E2E**

```bash
KEY=$(grep '^API_KEY=' /etc/vipcam/edge.env | cut -d= -f2- | tr -d '"' | tr -d "'")

# Backend smoke
curl -fs https://monitoramento.franquiabv.com.br/api/health | jq
curl -fs -H "X-API-Key: $KEY" https://monitoramento.franquiabv.com.br/api/dashboard/summary | jq
curl -fs -H "X-API-Key: $KEY" https://monitoramento.franquiabv.com.br/api/persons?limit=3 | jq '.items[0].display_name'

# Frontend acessível (aceita 200 ou 308 — Next pode redirect com trailing slash)
curl -fsLI -o /dev/null -w "%{http_code}\n" https://monitoramento.franquiabv.com.br/live
```

- [ ] **Step 4: Validação visual no browser**

Acessar `https://monitoramento.franquiabv.com.br` no kiosk:
- Redirect → /live ✓
- Topbar com badge de matches pendentes ✓
- Navegar /people: tabela com 369+ pessoas ✓
- Click em pessoa: perfil abre ✓
- /matches: ambíguo aparece, resolve/reject funciona ✓
- /live: SSE conectado, eventos aparecem em real-time ✓

**Checkpoint Onda 3 atingido:** Dashboard completo em produção. Operador tem visibilidade total + UI pra resolver ambíguos. Pendente Ondas futuras: failover B (re-id local), métricas agregadas, retention/LGPD.

---

## Apêndice A — Backlog conhecido (NÃO implementar nessa onda)

Capturado durante implementação ou previsto no spec:

- **Failover B (InsightFace + pgvector ANN):** próxima onda dedicada. Requer sidecar Python.
- **Mobile responsive:** kiosk-only por ora.
- **Internacionalização:** pt-BR hardcoded.
- **Retention job:** snapshots > 30d. Onda 4 (LGPD).
- **Métricas agregadas (gráficos):** após uso real informar quais métricas valem.
- **E2E tests (Playwright):** se houver dor real.
- **Auth real (NextAuth):** se expandir além de kiosk.
- **Shadcn theme customization:** vibe atual default-slate é OK pra v1.


