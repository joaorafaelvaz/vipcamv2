# Onda 10 — Identificação Manual de Funcionários Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operador identifica anônimos frequentes como funcionários ("esse é o X") →
merge transfere os rostos da câmera pro funcionário → reid passa a reconhecê-lo →
staff some das janelas do /matches.

**Architecture:** Fila de curadoria (anônimos ordenados por detecções) servida por
`personsRepo.listIdentifyQueue`; 3 rotas novas deps-injected em `createPersonsRoutes`;
merge reusa `personsRepo.mergeInto` (já transfere face_records/detections/sessions e
audita). Web: página `/identify` + dialog reusável no perfil. **Sem migration**
(dismiss em `persons.metadata` jsonb, update atômico via `||`).

**Tech Stack:** edge Bun+Hono+Drizzle+Postgres; web Next 14+React Query+shadcn/ui; bun:test.

**Spec:** `docs/superpowers/specs/2026-06-03-onda-10-identify-staff-design.md` (26d20d8)

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `packages/shared/src/types/index.ts` | `+IdentifyQueueItem` |
| `packages/edge/src/persistence/repositories/persons.repo.ts` | `+listIdentifyQueue(limit)`, `+dismissIdentify(id)` |
| `packages/edge/src/api/routes/persons.ts` | `+GET /identify/queue`, `+POST /:id/identify`, `+POST /:id/identify/dismiss` (deps) |
| `packages/edge/src/api/server.ts:217-224` | wire das novas deps |
| `packages/web/src/lib/queries/identify.ts` (**novo**) | hooks (queue + mutations) |
| `packages/web/src/components/identify-employee-dialog.tsx` (**novo**) | dialog "É funcionário…" (reusável) |
| `packages/web/src/components/identify-queue.tsx` (**novo**) | lista da fila + ações |
| `packages/web/src/app/identify/page.tsx` (**novo**) | página |
| `packages/web/src/app/people/[id]/page.tsx` | botão p/ anônimos |
| `packages/web/src/components/topbar.tsx:11-16` | tab "Identificar" |

**Padrões confirmados:** rotas deps-injected (unit-testáveis com stubs, sem DB);
`snapshotUrl()` de `@/lib/api-client` p/ fotos; mutations com toast+invalidate
(`lib/queries/matches.ts`); web tests happy-dom em `tests/unit/components/`.

**Ordem de merge:** `mergeInto(srcId=anonId, dstId=employeePersonId, "user")` — o
funcionário SOBREVIVE e herda tudo. FIFO cap 5 nos face_records mantém os mais
recentes (crops da câmera); o seed morto do ERP acaba evictado naturalmente.

---

## Chunk 1: Shared type + repo (edge)

### Task 1: `IdentifyQueueItem` no shared

**Files:**
- Modify: `packages/shared/src/types/index.ts` (após PersonDetail, ~linha 38)

- [ ] **Step 1: Adicionar o tipo**

```ts
/** Onda 10 — item da fila de curadoria "identificar funcionário".
 * Anônimo frequente + amostras de fotos pra o operador reconhecer. */
export interface IdentifyQueueItem {
  person_id: UUID;
  detection_count: number;
  last_seen_at: ISO8601 | null;
  /** Até 3 snapshot_paths recentes (relativos — web resolve via snapshotUrl). */
  snapshots: string[];
}
```

- [ ] **Step 2: Typecheck do shared**

Run: `cd packages/shared && bun run typecheck` → limpo.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types/index.ts
git commit -m "feat(shared): Onda 10 — IdentifyQueueItem"
```

### Task 2: `personsRepo.listIdentifyQueue` + `dismissIdentify`

**Files:**
- Modify: `packages/edge/src/persistence/repositories/persons.repo.ts`
- Test: `packages/edge/tests/integration/persistence/persons-identify-queue.test.ts` (**novo**)

- [ ] **Step 1: Write the failing test (integração — roda onde há Postgres)**

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getDb } from "../../../src/persistence/db.js";
import { detectionsRepo } from "../../../src/persistence/repositories/detections.repo.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";

let cameraId: string;
const pids: string[] = [];

beforeEach(async () => {
  const [cam] = await getDb().execute<{ id: string }>(sql`
    INSERT INTO cameras (id, name) VALUES (gen_random_uuid(), 'cam-iq') RETURNING id`);
  if (!cam) throw new Error("no cam");
  cameraId = cam.id;
  pids.length = 0;
});

afterEach(async () => {
  await getDb().execute(sql`DELETE FROM detections WHERE camera_id = ${cameraId}`);
  for (const id of pids) await getDb().execute(sql`DELETE FROM persons WHERE id = ${id}`);
  await getDb().execute(sql`DELETE FROM cameras WHERE id = ${cameraId}`);
});

async function anon(nDets: number): Promise<string> {
  const p = await personsRepo.create({ person_type: "anonymous" });
  pids.push(p.id);
  for (let i = 0; i < nDets; i++) {
    await detectionsRepo.create({
      camera_id: cameraId, person_id: p.id, session_id: null, face_attrs: {},
      detected_at: new Date(Date.now() - i * 60_000),
      snapshot_path: `2026-06-03/${p.id}-${i}.jpg`, raw_event: {},
    });
  }
  return p.id;
}

describe("personsRepo.listIdentifyQueue", () => {
  test("ordena por detection_count desc; ≤3 snapshots recentes; exclui 0 detecções", async () => {
    const heavy = await anon(5);
    const light = await anon(2);
    await anon(0); // sem detecções — fora

    const q = await personsRepo.listIdentifyQueue(10);
    const ids = q.map((i) => i.person_id);
    expect(ids.indexOf(heavy)).toBeLessThan(ids.indexOf(light));
    const h = q.find((i) => i.person_id === heavy);
    expect(h?.detection_count).toBe(5);
    expect(h?.snapshots.length).toBe(3); // cap 3
    expect(q.some((i) => i.detection_count === 0)).toBe(false);
  });

  test("exclui dismissed; dismissIdentify não clobra metadata existente", async () => {
    const p = await anon(3);
    await personsRepo.update(p, { metadata: { foo: "bar" } });
    await personsRepo.dismissIdentify(p);

    const q = await personsRepo.listIdentifyQueue(10);
    expect(q.some((i) => i.person_id === p)).toBe(false);

    const reloaded = await personsRepo.findById(p);
    const md = reloaded?.metadata as Record<string, unknown>;
    expect(md.identify_dismissed).toBe(true);
    expect(md.foo).toBe("bar"); // não clobrou
  });

  test("não lista clients/employees", async () => {
    const emp = await personsRepo.create({ person_type: "employee", display_name: "F" });
    pids.push(emp.id);
    await detectionsRepo.create({
      camera_id: cameraId, person_id: emp.id, session_id: null, face_attrs: {},
      detected_at: new Date(), raw_event: {},
    });
    const q = await personsRepo.listIdentifyQueue(10);
    expect(q.some((i) => i.person_id === emp.id)).toBe(false);
  });
});
```

- [ ] **Step 2: Verify red** — `cd packages/edge && bun run typecheck` → erro (métodos não existem).

- [ ] **Step 3: Implement no persons.repo.ts** (após `isStaffLike`)

```ts
  /**
   * Onda 10 — fila de curadoria "identificar funcionário": anônimos com ≥1
   * detecção, não-dispensados, ordenados por nº de detecções desc (mais visto
   * = mais provável staff). 2 queries (agregado + snapshots) + agrupamento em
   * memória — pattern Onda 4 D1.
   */
  async listIdentifyQueue(limit: number): Promise<
    Array<{
      person_id: string;
      detection_count: number;
      last_seen_at: Date | null;
      snapshots: string[];
    }>
  > {
    const rows = await getDb()
      .select({
        person_id: persons.id,
        detection_count: sql<number>`count(${detections.id})::int`,
        last_seen_at: persons.last_seen_at,
      })
      .from(persons)
      .innerJoin(detections, eq(detections.person_id, persons.id))
      .where(
        and(
          eq(persons.person_type, "anonymous"),
          sql`(${persons.metadata}->>'identify_dismissed') IS DISTINCT FROM 'true'`,
        ),
      )
      .groupBy(persons.id)
      .orderBy(sql`count(${detections.id}) DESC`)
      .limit(limit);

    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.person_id);
    const snaps = await getDb()
      .select({
        person_id: detections.person_id,
        snapshot_path: detections.snapshot_path,
        detected_at: detections.detected_at,
      })
      .from(detections)
      .where(and(inArray(detections.person_id, ids), isNotNull(detections.snapshot_path)))
      .orderBy(desc(detections.detected_at));

    const byPerson = new Map<string, string[]>();
    for (const s of snaps) {
      if (!s.person_id || !s.snapshot_path) continue;
      const arr = byPerson.get(s.person_id) ?? [];
      if (arr.length < 3) {
        arr.push(s.snapshot_path);
        byPerson.set(s.person_id, arr);
      }
    }
    return rows.map((r) => ({ ...r, snapshots: byPerson.get(r.person_id) ?? [] }));
  },

  /**
   * Onda 10 — marca anônimo como dispensado da fila (ex.: cliente frequente).
   * `||` jsonb: atômico, preserva chaves existentes (sem read-modify-write race).
   */
  async dismissIdentify(id: string): Promise<void> {
    await getDb()
      .update(persons)
      .set({
        metadata: sql`${persons.metadata} || '{"identify_dismissed":true}'::jsonb`,
        updated_at: sql`now()`,
      })
      .where(eq(persons.id, id));
  },
```

Imports a adicionar no topo: `desc`, `inArray`, `isNotNull` de drizzle-orm (já tem
`and, eq, sql`; `detections` já importado pela Task 4 da 9-D).

- [ ] **Step 4: Typecheck** → limpo. (Teste de integração roda na VPS.)

- [ ] **Step 5: Commit**

```bash
git add packages/edge/src/persistence/repositories/persons.repo.ts packages/edge/tests/integration/persistence/persons-identify-queue.test.ts
git commit -m "feat(edge): Onda 10 — listIdentifyQueue + dismissIdentify no personsRepo"
```

---

## Chunk 2: Rotas (edge)

### Task 3: 3 rotas novas em `createPersonsRoutes` (unit-testável com stubs)

**Files:**
- Modify: `packages/edge/src/api/routes/persons.ts`
- Test: `packages/edge/tests/unit/api/routes/persons-identify.test.ts` (**novo**)

- [ ] **Step 1: Write the failing test (unit, stub deps — SEM DB)**

```ts
import { describe, expect, test } from "bun:test";
import { type PersonsDeps, createPersonsRoutes } from "../../../../src/api/routes/persons.js";

const ANON = "11111111-1111-1111-1111-111111111111";
const EMP = "22222222-2222-2222-2222-222222222222";

function makeDeps(over?: Partial<PersonsDeps>): PersonsDeps {
  return {
    list: async () => ({ items: [], total: 0 }),
    getById: async () => null,
    listSessions: async () => [],
    listIdentifyQueue: async () => [
      { person_id: ANON, detection_count: 5, last_seen_at: null, snapshots: ["a.jpg"] },
    ],
    findPersonType: async (id) =>
      id === ANON ? "anonymous" : id === EMP ? "employee" : null,
    mergeIntoEmployee: async () => undefined,
    dismissIdentify: async () => undefined,
    ...over,
  };
}

function req(app: ReturnType<typeof createPersonsRoutes>, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });
}

describe("identify routes", () => {
  test("GET /identify/queue → itens", async () => {
    const app = createPersonsRoutes(makeDeps());
    const r = await req(app, "GET", "/identify/queue");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.items[0].person_id).toBe(ANON);
  });

  test("POST /:id/identify happy → 200 + mergeIntoEmployee(anon, emp)", async () => {
    let called: [string, string] | null = null;
    const app = createPersonsRoutes(
      makeDeps({ mergeIntoEmployee: async (a, e) => { called = [a, e]; } }),
    );
    const r = await req(app, "POST", `/${ANON}/identify`, { employee_person_id: EMP });
    expect(r.status).toBe(200);
    expect(called).toEqual([ANON, EMP]);
  });

  test("POST identify: :id não-anônimo → 400 not_anonymous", async () => {
    const app = createPersonsRoutes(makeDeps());
    const r = await req(app, "POST", `/${EMP}/identify`, { employee_person_id: EMP });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("not_anonymous");
  });

  test("POST identify: alvo não-employee → 400 not_employee", async () => {
    const app = createPersonsRoutes(makeDeps());
    const r = await req(app, "POST", `/${ANON}/identify`, { employee_person_id: ANON });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("not_employee");
  });

  test("POST identify: :id inexistente → 404", async () => {
    const app = createPersonsRoutes(makeDeps());
    const r = await req(app, "POST", "/33333333-3333-3333-3333-333333333333/identify", {
      employee_person_id: EMP,
    });
    expect(r.status).toBe(404);
  });

  test("POST identify: mergeIntoEmployee lança 'not found' → 409 concurrent_merge", async () => {
    const app = createPersonsRoutes(
      makeDeps({
        mergeIntoEmployee: async () => {
          throw new Error("mergeInto: person not found (x or y)");
        },
      }),
    );
    const r = await req(app, "POST", `/${ANON}/identify`, { employee_person_id: EMP });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("concurrent_merge");
  });

  test("POST identify: body inválido → 400 invalid_body", async () => {
    const app = createPersonsRoutes(makeDeps());
    const r = await req(app, "POST", `/${ANON}/identify`, { nope: 1 });
    expect(r.status).toBe(400);
  });

  test("POST /:id/identify/dismiss → 200 (e valida anônimo)", async () => {
    let dismissed: string | null = null;
    const app = createPersonsRoutes(
      makeDeps({ dismissIdentify: async (id) => { dismissed = id; } }),
    );
    const r = await req(app, "POST", `/${ANON}/identify/dismiss`);
    expect(r.status).toBe(200);
    expect(dismissed).toBe(ANON);
    const r2 = await req(app, "POST", `/${EMP}/identify/dismiss`);
    expect(r2.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run** → FAIL (deps/rotas não existem).
Run: `cd packages/edge && bun test tests/unit/api/routes/persons-identify.test.ts`

- [ ] **Step 3: Implement em `persons.ts`**

Estender `PersonsDeps`:

```ts
import type { IdentifyQueueItem, ... } from "@vipcam/shared";

export interface PersonsDeps {
  // ... existentes ...
  // Onda 10 — curadoria "identificar funcionário":
  listIdentifyQueue: (limit: number) => Promise<
    Array<{ person_id: string; detection_count: number; last_seen_at: Date | null; snapshots: string[] }>
  >;
  findPersonType: (id: string) => Promise<"client" | "employee" | "anonymous" | null>;
  /** mergeInto(anon → employee, 'user'). Lança /not found/ em race. */
  mergeIntoEmployee: (anonId: string, employeePersonId: string) => Promise<void>;
  dismissIdentify: (id: string) => Promise<void>;
}
```

Rotas (ANTES de `r.get("/:id")` — Hono casa rotas na ordem; `/identify/queue`
colidiria com `/:id`):

```ts
  const identifyBody = z.object({ employee_person_id: z.string().uuid() });

  // Onda 10 — fila de curadoria (anônimos frequentes, prováveis staff)
  r.get("/identify/queue", async (c) => {
    const limit = clamp(Number(c.req.query("limit") ?? 20), 1, 100);
    const rows = await deps.listIdentifyQueue(limit);
    const items: IdentifyQueueItem[] = rows.map((r) => ({
      person_id: r.person_id,
      detection_count: r.detection_count,
      last_seen_at: r.last_seen_at ? r.last_seen_at.toISOString() : null,
      snapshots: r.snapshots,
    }));
    return c.json({ items });
  });

  // Onda 10 — "esse anônimo é o funcionário X": merge anon → employee.
  r.post("/:id/identify", async (c) => {
    const id = c.req.param("id");
    const parsed = identifyBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    }
    const anonType = await deps.findPersonType(id);
    if (anonType === null) return c.json({ error: "not_found" }, 404);
    if (anonType !== "anonymous") return c.json({ error: "not_anonymous" }, 400);
    const empType = await deps.findPersonType(parsed.data.employee_person_id);
    if (empType !== "employee") return c.json({ error: "not_employee" }, 400);
    try {
      await deps.mergeIntoEmployee(id, parsed.data.employee_person_id);
    } catch (err) {
      // Race: anon já merged por outro caminho (auto-merge 9-D / outro operador).
      if (err instanceof Error && /not found/i.test(err.message)) {
        return c.json({ error: "concurrent_merge", message: err.message }, 409);
      }
      throw err;
    }
    return c.json({ ok: true });
  });

  // Onda 10 — "não é funcionário" (ex.: cliente frequente): sai da fila.
  r.post("/:id/identify/dismiss", async (c) => {
    const id = c.req.param("id");
    const t = await deps.findPersonType(id);
    if (t === null) return c.json({ error: "not_found" }, 404);
    if (t !== "anonymous") return c.json({ error: "not_anonymous" }, 400);
    await deps.dismissIdentify(id);
    return c.json({ ok: true });
  });
```

- [ ] **Step 4: Run tests** → PASS (9 tests). Typecheck vai acusar o wiring do
server.ts (deps novas faltando) — é a Task 4.

- [ ] **Step 5: Commit** (junto com Task 4, ou aqui se typecheck local do arquivo OK)

### Task 4: Wire no `server.ts`

**Files:**
- Modify: `packages/edge/src/api/server.ts:217-224`

- [ ] **Step 1: Implement**

```ts
  app.route(
    "/api/persons",
    createPersonsRoutes({
      list: (params) => personsRepo.listWithFilters(params),
      getById: (id) => personsRepo.findByIdWithStats(id),
      listSessions: (id, limit) => sessionsRepo.listByPerson(id, limit),
      // Onda 10 — curadoria identify
      listIdentifyQueue: (limit) => personsRepo.listIdentifyQueue(limit),
      findPersonType: async (id) => (await personsRepo.findById(id))?.person_type ?? null,
      mergeIntoEmployee: (anonId, empId) => personsRepo.mergeInto(anonId, empId, "user"),
      dismissIdentify: (id) => personsRepo.dismissIdentify(id),
    }),
  );
```

- [ ] **Step 2: Gates**

Run: `cd packages/edge && bun run typecheck && bun test tests/unit`
Expected: limpo + suíte verde.

- [ ] **Step 3: Commit**

```bash
git add packages/edge/src/api/routes/persons.ts packages/edge/src/api/server.ts packages/edge/tests/unit/api/routes/persons-identify.test.ts
git commit -m "feat(edge): Onda 10 — rotas identify (queue/identify/dismiss) + wire"
```

---

## Chunk 3: Web

### Task 5: Hooks React Query (`lib/queries/identify.ts`)

**Files:**
- Create: `packages/web/src/lib/queries/identify.ts`

- [ ] **Step 1: Implement** (padrão de `matches.ts`: toast + invalidate)

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IdentifyQueueItem } from "@vipcam/shared";
import { toast } from "sonner";
import { ApiError, apiFetch } from "../api-client";

export function useIdentifyQueue(limit = 20) {
  return useQuery<IdentifyQueueItem[]>({
    queryKey: ["identify", "queue", limit],
    queryFn: async ({ signal }) => {
      const r = await apiFetch<{ items: IdentifyQueueItem[] }>(
        `/api/persons/identify/queue?limit=${limit}`,
        { signal },
      );
      return r.items;
    },
  });
}

function invalidateAfterIdentify(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ["identify"] });
  void qc.invalidateQueries({ queryKey: ["persons"] });
  void qc.invalidateQueries({ queryKey: ["matches"] });
}

export function useIdentifyAsEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (p: { anonId: string; employeePersonId: string }) => {
      await apiFetch<{ ok: true }>(`/api/persons/${p.anonId}/identify`, {
        method: "POST",
        body: { employee_person_id: p.employeePersonId },
      });
    },
    onSuccess: () => {
      toast.success("Funcionário identificado");
      invalidateAfterIdentify(qc);
    },
    onError: (e) => {
      const msg = e instanceof ApiError ? `${e.status} ${e.code}` : String(e);
      toast.error(`Erro ao identificar: ${msg}`);
    },
  });
}

export function useDismissIdentify() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (anonId: string) => {
      await apiFetch<{ ok: true }>(`/api/persons/${anonId}/identify/dismiss`, {
        method: "POST",
        body: {},
      });
    },
    onSuccess: () => {
      toast.success("Removido da fila");
      void qc.invalidateQueries({ queryKey: ["identify"] });
    },
    onError: (e) => toast.error(`Erro: ${String(e)}`),
  });
}
```

(Conferir assinatura do `apiFetch` p/ POST — espelhar `matches.ts`.)

- [ ] **Step 2: Typecheck web** — `cd packages/web && bun run typecheck` (shared
precisa estar buildado: `cd packages/shared && bun run typecheck` antes).

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/lib/queries/identify.ts
git commit -m "feat(web): Onda 10 — hooks identify (queue + mutations)"
```

### Task 6: `identify-employee-dialog.tsx` (reusável) + teste

**Files:**
- Create: `packages/web/src/components/identify-employee-dialog.tsx`
- Test: `packages/web/tests/unit/components/identify-employee-dialog.test.tsx`

- [ ] **Step 1: Write the failing test** (padrão happy-dom dos testes existentes —
copiar setup de `person-table.test.tsx`: QueryClientProvider wrapper + mock de
`apiFetch`). Asserts: (a) abre dialog no clique do trigger; (b) Input filtra a lista
de funcionários (mock de `usePeople`/apiFetch retornando 2 employees); (c) clicar num
funcionário + "Confirmar" dispara POST pro endpoint certo.

- [ ] **Step 2: Run** → FAIL (componente não existe).

- [ ] **Step 3: Implement**

Estrutura (shadcn Dialog + Input filtro + lista — sem Command, não existe no projeto):

```tsx
"use client";
// Props: { anonId: string; trigger?: ReactNode }
// - Dialog (shadcn) com trigger default <Button variant="outline">É funcionário…</Button>
// - Dentro: <Input placeholder="Buscar funcionário…"> filtrando client-side a lista
//   de usePeople({ type: "employee", limit: 200 }) (148 funcionários — 1 fetch)
// - Lista: botões com nome (até ~8 visíveis, scroll); clique seleciona (highlight)
// - Footer: <Button disabled={!selected || isPending} onClick={confirm}>Confirmar</Button>
// - confirm: useIdentifyAsEmployee().mutate({ anonId, employeePersonId: selected });
//   onSuccess fecha o dialog (setOpen(false))
```

- [ ] **Step 4: Run** → PASS. Typecheck web limpo.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/identify-employee-dialog.tsx packages/web/tests/unit/components/identify-employee-dialog.test.tsx
git commit -m "feat(web): Onda 10 — IdentifyEmployeeDialog (combobox simples)"
```

### Task 7: Fila `/identify` (componente + página) + teste

**Files:**
- Create: `packages/web/src/components/identify-queue.tsx`
- Create: `packages/web/src/app/identify/page.tsx`
- Test: `packages/web/tests/unit/components/identify-queue.test.tsx`

- [ ] **Step 1: Write the failing test** — mock da queue com 2 itens; asserts:
renderiza contagem/fotos (via `snapshotUrl`), botão Ignorar dispara dismiss, dialog
presente por item; fila vazia → empty state "Nenhum anônimo frequente".

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

`identify-queue.tsx`: lista de Cards — esquerda: até 3 `<img src={snapshotUrl(s)}>`
(`w-20 h-20 object-cover rounded`); meio: `{detection_count} detecções`, "visto
{formatDistanceToNow(last_seen_at)}", link "ver perfil" → `/people/{person_id}`;
direita: `<IdentifyEmployeeDialog anonId={person_id} />` + `<Button variant="ghost"
onClick={dismiss}>Ignorar</Button>`. Skeleton no loading.

`app/identify/page.tsx` (espelha `people/page.tsx`):

```tsx
import { IdentifyQueue } from "@/components/identify-queue";
export const dynamic = "force-dynamic";
export default function IdentifyPage() {
  return (
    <div className="container mx-auto p-6 max-w-3xl">
      <h1 className="text-2xl font-semibold mb-1">Identificar funcionários</h1>
      <p className="text-sm text-slate-500 mb-4">
        Pessoas vistas com frequência pela câmera, ainda sem identificação. Diga quem é
        funcionário — a câmera passa a reconhecê-lo e ele sai da revisão de matches.
      </p>
      <IdentifyQueue />
    </div>
  );
}
```

- [ ] **Step 4: Run** → PASS. Typecheck limpo.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/identify-queue.tsx packages/web/src/app/identify/page.tsx packages/web/tests/unit/components/identify-queue.test.tsx
git commit -m "feat(web): Onda 10 — página /identify (fila de curadoria)"
```

### Task 8: Botão no perfil + tab no Topbar

**Files:**
- Modify: `packages/web/src/app/people/[id]/page.tsx` (header, ~linha 60)
- Modify: `packages/web/src/components/topbar.tsx:11-16`
- Test: `packages/web/tests/unit/components/topbar.test.tsx` (estender: tab presente)

- [ ] **Step 1: Perfil** — no bloco do header, quando anônimo:

```tsx
{person.person_type === "anonymous" && (
  <div className="mt-2">
    <IdentifyEmployeeDialog anonId={person.id} />
  </div>
)}
```

- [ ] **Step 2: Topbar** — adicionar em TABS (UserCheck do lucide):

```ts
{ href: "/identify" as Route, label: "Identificar", icon: UserCheck },
```

Atualizar `topbar.test.tsx` pra esperar a nova tab.

- [ ] **Step 3: Gates web completos**

Run: `cd packages/web && bun run typecheck && bun test tests/unit`
Expected: tudo verde.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/app/people/[id]/page.tsx packages/web/src/components/topbar.tsx packages/web/tests/unit/components/topbar.test.tsx
git commit -m "feat(web): Onda 10 — botão no perfil de anônimo + tab Identificar"
```

---

## Chunk 4: Gates finais + deploy

### Task 9: Gates + finishing

- [ ] `cd packages/shared && bun run typecheck` → limpo
- [ ] `cd packages/edge && bun run typecheck && bun test tests/unit` → verde
- [ ] `cd packages/web && bun run typecheck && bun test tests/unit` → verde
- [ ] `bunx biome check <arquivos tocados>` → limpo (corrigir com `--write` se format)
- [ ] superpowers:finishing-a-development-branch → merge em master → push

### Task 10: Deploy + validação (VPS)

- [ ] `cd /opt/vipcamv2 && sudo ./scripts/deploy.sh` (sem mudança de env)
- [ ] Abrir `https://monitoramento.franquiabv.com.br/identify` — fila deve mostrar os
  anônimos mais frequentes com fotos (topo: ~36 detecções, o provável atendente).
- [ ] Identificar 1 funcionário óbvio → conferir:
  ```sql
  -- detecções migraram pro funcionário:
  SELECT count(*) FROM detections d JOIN persons p ON p.id=d.person_id WHERE p.person_type='employee';
  -- face_records do funcionário agora têm source='live_detection':
  SELECT source, count(*) FROM face_records fr JOIN persons p ON p.id=fr.person_id
   WHERE p.person_type='employee' GROUP BY 1;
  ```
- [ ] Nas próximas horas: `matched_strict` p/ esse funcionário sobe (reid reconhecendo);
  ambíguos novos contendo ele deixam de ser criados (excluído como employee).

---

## Notas de execução

- **Ordem das rotas no Hono importa:** `/identify/queue` deve ser registrada ANTES de
  `/:id` (senão `:id="identify"`). Os POSTs `/:id/identify*` não colidem (método+path).
- **Integração (Task 2) roda na VPS** (sem vipcam_test local) — gate local é typecheck.
- **Sem migration; sem mudança de env.**
- **mergeInto direção:** anon é src (some), employee é dst (sobrevive).
