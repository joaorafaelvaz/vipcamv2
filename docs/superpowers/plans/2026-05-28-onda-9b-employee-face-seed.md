# Onda 9-B — Employee Face Seed Implementation Plan

> **For agentic workers:** REQUIRED: Use **superpowers:subagent-driven-development** (if subagents available) or **superpowers:executing-plans** to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quando employee aparece na câmera, reid reconhece automaticamente e linka à `Person(person_type=employee, erp_employee_id=<id>)` em vez de criar `Person(anonymous)` duplicada — fechando o gap pós-Onda 7 onde `syncEmployees()` criava Person mas não populava `face_records`.

**Architecture:** Estender `syncEmployees()` pra após criar/atualizar Person, chamar novo `seedEmployeeFace()` que baixa foto do ERP via URL pública, manda pro sidecar reid `/embed` com **bbox oversize trick** (x=0,y=0,w=99999,h=99999) que cai no `frame_fallback` path do sidecar, decodifica `crop_jpeg_b64` do response e persiste em `face_records`. Cache-buster do ERP (`avatar_<id>.jpg?<4chars>`) usado como versão via nova coluna `persons.last_embedded_image_token`.

**Tech Stack:**
- Edge: Bun + Hono + Drizzle ORM + Postgres + pgvector (sem mudança no sidecar reid Python)
- Deploy: systemd unit `vipcam-edge` restart pega migrations no startup automático

**Spec base:** `docs/superpowers/specs/2026-05-28-onda-9b-employee-face-seed-design.md` (commit `fd12570`, approved 3-round review)

**Branch:** `onda-9b-employee-face-seed` (já existe; 4 commits do spec).

---

## File Structure

### Edge (`packages/edge/`)

**Modify:**
- `src/persistence/schema/persons.ts` — adicionar `last_embedded_image_token` (text nullable)
- `src/persistence/schema/face-records.ts` — adicionar `source` (text NOT NULL default `'live_detection'`)
- `src/persistence/repositories/face-records.repo.ts` — adicionar `countByPerson()` helper
- `src/ingest/pipeline.ts:178-186` — passar `source: "live_detection"` explicit no `insertAndEvict` (defensive/explícito)
- `src/erp-sync/employees.ts` — após `personsRepo.create/update`, chamar `seedEmployeeFace`; ampliar `SyncResult` com counters novos; per-employee try/catch
- `src/config/env.ts` — adicionar `ERP_PHOTO_URL_PREFIX` (z.string().url(), default `https://www.franquiabv.com.br/img/usuarios/`)

**Create:**
- `src/erp-sync/employee-face-seeder.ts` — `seedEmployeeFace`, `isPlaceholder`, `sanitizeToken`, `SeedResult` type
- `src/persistence/migrations/0009_<adj>_<noun>.sql` — drizzle-kit gera

**Test (create):**
- `tests/unit/persistence/schema-employee-face-seed.test.ts` — schema invariants pra ambas colunas novas
- `tests/unit/erp-sync/employee-face-seeder.test.ts` — 6 cenários do `SeedResult` + `isPlaceholder` predicate + `sanitizeToken` helper
- `tests/unit/erp-sync/employees.test.ts` (extend if exists, create if not) — regression: syncEmployees ainda faz upsert+create igual antes, agora + 1 call ao seeder por row, falhas do seeder não interrompem o loop
- `tests/integration/erp-sync/employee-face-seeder-integration.test.ts` (create — DB-deferred) — happy path c/ fixture HTTP server local + frame_fallback contract validation

---

## Chunk 1: Schema + Repo helpers + pipeline.ts source

Foundational changes que destravam o seeder mas não habilitam comportamento novo ainda. Após chunk 1: todas as packages typecheck verdes, schema novo aplicado, pipeline.ts passa source explicit.

**Tasks:** 1-3.
**Sequência:** 1 (schema) → 2 (pipeline source) → 3 (countByPerson helper).

---

### Task 1: Schema migration 0009 — persons.last_embedded_image_token + face_records.source

**Spec ref:** §3.1, §3.2, §3.4.

**Files:**
- Modify: `packages/edge/src/persistence/schema/persons.ts`
- Modify: `packages/edge/src/persistence/schema/face-records.ts`
- Generated: `packages/edge/src/persistence/migrations/0009_<adj>_<noun>.sql`
- Test: `packages/edge/tests/unit/persistence/schema-employee-face-seed.test.ts` (create)

- [ ] **Step 1: Failing test**

`packages/edge/tests/unit/persistence/schema-employee-face-seed.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { faceRecords } from "../../../src/persistence/schema/face-records.js";
import { persons } from "../../../src/persistence/schema/persons.js";

describe("Onda 9-B schema additions", () => {
  test("persons has last_embedded_image_token (nullable text)", () => {
    const col = (persons as unknown as { last_embedded_image_token?: { notNull?: boolean } })
      .last_embedded_image_token;
    expect(col).toBeDefined();
    expect(col?.notNull).not.toBe(true);
  });

  test("face_records has source (NOT NULL, default live_detection)", () => {
    const col = (faceRecords as unknown as {
      source?: { notNull?: boolean; default?: unknown };
    }).source;
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(true);
    expect(col?.default).toBe("live_detection");
  });
});
```

- [ ] **Step 2: Run test (fail)**

`cd packages/edge && bun test tests/unit/persistence/schema-employee-face-seed.test.ts`
Expected: 2 fails (columns undefined).

- [ ] **Step 3: Add columns to Drizzle schemas**

Em `packages/edge/src/persistence/schema/persons.ts`, dentro do `pgTable("persons", { ... })`, adicionar após o último campo existente (provavelmente `metadata`):
```typescript
// Onda 9-B: cache-buster do ERP (ex: "avatar_1966.jpg?p8yr") da última
// foto seedada via /embed do sidecar. NULL = nunca tentou seedar.
// String equality contra usuarios.imagem decide skip no próximo sync.
last_embedded_image_token: text("last_embedded_image_token"),
```

Em `packages/edge/src/persistence/schema/face-records.ts`, dentro do `pgTable("face_records", { ... })`, adicionar após o último campo do bloco principal (provavelmente `created_at`):
```typescript
// Onda 9-B: discrimina origem do embedding. Default "live_detection"
// backfilla automaticamente rows existentes (Onda 7 pipeline). Seeder
// novo (erp-sync/employee-face-seeder.ts) usa "erp_seed".
source: text("source").notNull().default("live_detection"),
```

`text` já está nos imports de `drizzle-orm/pg-core` em ambos arquivos. Confirme via grep antes de salvar.

- [ ] **Step 4: Run test (pass)**

`cd packages/edge && bun test tests/unit/persistence/schema-employee-face-seed.test.ts` → 2 PASS.

- [ ] **Step 5: Generate migration**

`cd packages/edge && bun run db:generate`
Expected: cria `0009_<adj>_<noun>.sql` (drizzle-kit auto-suffix, tipo `0008_bizarre_randall.sql`) contendo:
- `ALTER TABLE "persons" ADD COLUMN "last_embedded_image_token" text;`
- `ALTER TABLE "face_records" ADD COLUMN "source" text DEFAULT 'live_detection' NOT NULL;`

> **Verificar:** abrir o `0009_*.sql` gerado e confirmar:
> 1. Apenas os 2 ALTER esperados — NADA mais (drizzle às vezes recria índices ou enums sem motivo aparente)
> 2. `face_records.source` está com `DEFAULT 'live_detection' NOT NULL` (necessário pro backfill automático dos rows existentes)
>
> Se houver SQL inesperado, comparar com `migrations/meta/0008_snapshot.json` vs `0009_snapshot.json` pra entender o diff.

- [ ] **Step 6: Apply migration locally (DB-deferred OK)**

`cd packages/edge && bun run db:migrate`
Se Postgres local não-disponível (esperado neste dev — vide Onda 9-A), marcar como DB-deferred (VPS aplica no startup do edge pós-deploy).

- [ ] **Step 7: Commit**

```bash
git add packages/edge/src/persistence/schema/persons.ts \
        packages/edge/src/persistence/schema/face-records.ts \
        packages/edge/src/persistence/migrations/0009_*.sql \
        packages/edge/src/persistence/migrations/meta/0009_snapshot.json \
        packages/edge/src/persistence/migrations/meta/_journal.json \
        packages/edge/tests/unit/persistence/schema-employee-face-seed.test.ts
git commit -m "feat(edge): Onda 9-B — persons.last_embedded_image_token + face_records.source"
```

No Co-Authored-By trailer (project convention: só `docs(plan)` / `docs(spec)` têm trailer).

---

### Task 2: pipeline.ts passes source: "live_detection" explicit

**Spec ref:** §4.1 (tabela de modify), §3.2.

**Files:**
- Modify: `packages/edge/src/ingest/pipeline.ts:178-186`

Mudança puramente defensiva — o default da coluna já faz isso silenciosamente, mas explícito ajuda leitor + permite Task 5 do seeder usar `source: "erp_seed"` sem confundir.

- [ ] **Step 1: Verify current call shape**

`cd packages/edge && grep -nA8 "insertAndEvict" src/ingest/pipeline.ts`
Expected: call atual passa `person_id, embedding, snapshot_path, det_score, model_name, model_revision, is_primary`. Sem `source` (que ainda não existe na schema antes da Task 1).

> **Pré-requisito:** Task 1 deve ter sido committed antes (schema precisa ter `source` antes do call passá-lo).

- [ ] **Step 2: Add source field to the call**

Em `packages/edge/src/ingest/pipeline.ts` (linhas ~178-186), encontrar o bloco:
```typescript
await faceRecordsRepo.insertAndEvict({
  person_id: personId,
  embedding: reidOut.embedding.embedding,
  snapshot_path: snapshotPath,
  det_score: reidOut.embedding.det_score,
  model_name: reidOut.embedding.model_name,
  model_revision: reidOut.embedding.model_revision,
  is_primary: reidOut.status === "new_person",
});
```

Adicionar 1 linha (no final, antes do `});`):
```typescript
  source: "live_detection",
```

- [ ] **Step 3: Run existing pipeline tests pra confirmar zero regressão**

`cd packages/edge && bun test tests/unit/ingest/ tests/integration/ingest/`
Expected: tudo verde. Esses testes podem mockar `faceRecordsRepo.insertAndEvict` — se o mock não declara `source`, ainda passa porque é só novo campo passado pra mock que ignora.

- [ ] **Step 4: Run typecheck**

`cd packages/edge && bunx tsc --noEmit`
Expected: clean. `Omit<NewFaceRecord, "id" | "created_at">` ganha `source: string` automaticamente após Task 1 — TS valida.

- [ ] **Step 5: Commit**

```bash
git add packages/edge/src/ingest/pipeline.ts
git commit -m "feat(edge): Onda 9-B — pipeline.ts passa source: live_detection explicit"
```

---

### Task 3: face-records.repo.ts — countByPerson helper

**Spec ref:** §5.2 (skip-override condition).

**Files:**
- Modify: `packages/edge/src/persistence/repositories/face-records.repo.ts`
- Test: `packages/edge/tests/integration/persistence/face-records-repo.test.ts` (extend if exists; DB-deferred)

O seeder (Task 5) precisa `countByPerson(person_id) > 0` pra decidir "skip via token unchanged" vs "re-embed mesmo c/ token igual" (caso operador deletou face_records manualmente). Helper barato — 1 query COUNT(*) com index `face_records_person_idx` existente.

- [ ] **Step 1: Failing integration test (DB-deferred)**

`packages/edge/tests/integration/persistence/face-records-repo.test.ts` — adicionar ao `describe` existente (ou criar arquivo se não-existir):
```typescript
test("countByPerson retorna 0 quando vazio, N quando inseridos", async () => {
  const p = await personsRepo.create({ display_name: "test cnt", person_type: "anonymous" });
  expect(await faceRecordsRepo.countByPerson(p.id)).toBe(0);

  await faceRecordsRepo.insertAndEvict({
    person_id: p.id,
    embedding: new Array(512).fill(0.01),
    snapshot_path: "test/dummy.jpg",
    is_primary: true,
  });
  expect(await faceRecordsRepo.countByPerson(p.id)).toBe(1);

  await faceRecordsRepo.insertAndEvict({
    person_id: p.id,
    embedding: new Array(512).fill(0.02),
    snapshot_path: "test/dummy2.jpg",
    is_primary: false,
  });
  expect(await faceRecordsRepo.countByPerson(p.id)).toBe(2);

  // cleanup
  await getDb().execute(sql`DELETE FROM face_records WHERE person_id = ${p.id}`);
  await getDb().execute(sql`DELETE FROM persons WHERE id = ${p.id}`);
});
```

(Adicionar `sql`, `getDb` aos imports se ainda não tem.)

- [ ] **Step 2: Run test (DB-deferred — fail/skip locally)**

`bash packages/edge/scripts/run-integration-tests.sh tests/integration/persistence/face-records-repo.test.ts`
Sem Postgres local, falha com `DATABASE_URL not set` — DB-deferred, OK. Se DB disponível, esperado: fail c/ "countByPerson is not a function".

- [ ] **Step 3: Implement countByPerson**

Em `packages/edge/src/persistence/repositories/face-records.repo.ts`, dentro do `faceRecordsRepo` object, adicionar após `findPrimaryByPersonId`:
```typescript
  /**
   * Onda 9-B: count usado pelo employee-face-seeder pra decidir skip via
   * token-unchanged vs re-embed (caso operador deletou face_records manualmente
   * — token igual mas count=0 deve re-embeddar).
   */
  async countByPerson(personId: string): Promise<number> {
    const [row] = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(faceRecords)
      .where(eq(faceRecords.person_id, personId));
    return row?.n ?? 0;
  },
```

Imports necessários: `sql` já está no topo do arquivo (linha 1: `import { and, eq, sql } from "drizzle-orm"`). Sem mudança.

- [ ] **Step 4: Run test (pass — DB-available) OR DB-deferred**

`bash packages/edge/scripts/run-integration-tests.sh tests/integration/persistence/face-records-repo.test.ts` → 1 PASS (se DB) ou DB-deferred.

- [ ] **Step 5: Run typecheck**

`cd packages/edge && bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/edge/src/persistence/repositories/face-records.repo.ts \
        packages/edge/tests/integration/persistence/face-records-repo.test.ts
git commit -m "feat(edge): Onda 9-B — faceRecordsRepo.countByPerson helper"
```

---

## Chunk 2: Seeder logic (helpers + SeedResult + deps factory)

Lógica nova do seeder em camadas testáveis. Após chunk 2: seeder funciona end-to-end com mocks; ainda não integrado no `syncEmployees`. Edge typecheck verde.

**Tasks:** 4-6.
**Sequência:** 4 (helpers puros) → 5 (SeedResult + seedEmployeeFace mocked) → 6 (env var + deps factory production).
**Pré-requisito:** Chunk 1 mergeado.

---

### Task 4: isPlaceholder + sanitizeToken pure helpers

**Spec ref:** §4.1, §5.2 (snapshot path construction).

**Files:**
- Create: `packages/edge/src/erp-sync/employee-face-seeder.ts` (parcial — só helpers nesta task)
- Test: `packages/edge/tests/unit/erp-sync/employee-face-seeder.test.ts` (create)

Cria o arquivo do seeder mas só com 2 helpers puros + tests. O `seedEmployeeFace` em si vem na Task 5. Decompõe pra cada task ser pequena.

- [ ] **Step 1: Failing test (helpers)**

`packages/edge/tests/unit/erp-sync/employee-face-seeder.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { isPlaceholder, sanitizeToken } from "../../../src/erp-sync/employee-face-seeder.js";

describe("isPlaceholder", () => {
  test("true para padrao.png / padrao_masc.jpg / padrao_fem.jpg", () => {
    expect(isPlaceholder("padrao.png")).toBe(true);
    expect(isPlaceholder("padrao_masc.jpg")).toBe(true);
    expect(isPlaceholder("padrao_fem.jpg")).toBe(true);
  });

  test("false para foto real (avatar_<id>.jpg?<token>)", () => {
    expect(isPlaceholder("avatar_1966.jpg?p8yr")).toBe(false);
    expect(isPlaceholder("avatar_2587.jpg?PtZD")).toBe(false);
  });

  test("false para empty / undefined-like fallbacks", () => {
    // Defensive — ERP nunca devolve '' (default 'padrao.png'), mas se vier
    // achamos que NÃO é placeholder; fetch vai falhar e seeder loga warn.
    expect(isPlaceholder("")).toBe(false);
  });
});

describe("sanitizeToken", () => {
  test("substitui ? por _ p/ filesystem-safety", () => {
    expect(sanitizeToken("avatar_1966.jpg?p8yr")).toBe("avatar_1966.jpg_p8yr");
  });

  test("idempotente em string sem ?", () => {
    expect(sanitizeToken("avatar_1966.jpg")).toBe("avatar_1966.jpg");
  });

  test("path traversal defensiva — slashes e .. são rejeitados via replace", () => {
    // ERP imagem é nome curto (~20 chars) sem path. Mas defensivo:
    expect(sanitizeToken("../../etc/passwd")).toBe("______etc_passwd");
    expect(sanitizeToken("a/b/c.jpg")).toBe("a_b_c.jpg");
  });
});
```

- [ ] **Step 2: Run test (fail — file/helpers não-existem)**

`cd packages/edge && bun test tests/unit/erp-sync/employee-face-seeder.test.ts`
Expected: fail c/ "Cannot find module".

- [ ] **Step 3: Implement helpers**

Criar `packages/edge/src/erp-sync/employee-face-seeder.ts`:
```typescript
/**
 * Onda 9-B — employee face seeder.
 *
 * Após syncEmployees criar/atualizar Person(employee), este módulo baixa
 * a foto do ERP, manda pro sidecar reid /embed (via bbox oversize trick →
 * frame_fallback path do sidecar), e persiste em face_records.
 *
 * Idempotente via persons.last_embedded_image_token: se imagem do ERP
 * não mudou desde o último seed, skip.
 *
 * HACK explícito: chamamos /embed com bbox (0,0,99999,99999) pra forçar
 * o sidecar a cair no `_embed_pil(full_frame)` (path documentado no
 * packages/reid/src/main.py:137 como "frame_fallback"). Sidecar v2+ pode
 * endurecer o guard "bbox deve caber no frame" — neste caso integration
 * test §6.3 cenário 2 falha como early-warning. Mitigação documentada em
 * spec §10 item #9: switch para opção B (/embed_image novo endpoint).
 */

const PLACEHOLDER_IMAGES: ReadonlySet<string> = new Set([
  "padrao.png",
  "padrao_masc.jpg",
  "padrao_fem.jpg",
]);

/** True quando o valor de `usuarios.imagem` é um placeholder do ERP
 * (não foto real). Set conhecido via probe 2026-05-28 (vide spec §2). */
export function isPlaceholder(photoUrl: string): boolean {
  return PLACEHOLDER_IMAGES.has(photoUrl);
}

/** Sanitiza o token do ERP pra filename safe — substitui `?` (query
 * string separator do cache-buster) e `/` (defensive path traversal)
 * por `_`. Tokens típicos do ERP: "avatar_1966.jpg?p8yr" → "avatar_1966.jpg_p8yr". */
export function sanitizeToken(token: string): string {
  return token.replace(/[?/]/g, "_");
}
```

- [ ] **Step 4: Run test (pass)**

`cd packages/edge && bun test tests/unit/erp-sync/employee-face-seeder.test.ts` → 6 PASS (3 isPlaceholder + 3 sanitizeToken).

- [ ] **Step 5: Run typecheck**

`cd packages/edge && bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/edge/src/erp-sync/employee-face-seeder.ts \
        packages/edge/tests/unit/erp-sync/employee-face-seeder.test.ts
git commit -m "feat(edge): Onda 9-B — isPlaceholder + sanitizeToken helpers"
```

---

### Task 5: SeedResult type + seedEmployeeFace orchestration (mocked)

**Spec ref:** §4.3 (SeedResult union), §5.2 (happy path), §5.3 (edge cases).

**Files:**
- Modify: `packages/edge/src/erp-sync/employee-face-seeder.ts` (adiciona SeedResult + seedEmployeeFace; deps injetadas)
- Modify: `packages/edge/tests/unit/erp-sync/employee-face-seeder.test.ts` (adiciona 6 cenários do SeedResult)

Esta é a tarefa "meatiest" do plano. Implementa a função principal com toda a logic decidida no spec, com mocks injetados pra cada dep (fetcher, reidClient, repos, fs). Cada cenário do SeedResult vira 1 unit test.

- [ ] **Step 1: Failing tests (6 SeedResult scenarios)**

Adicionar ao `packages/edge/tests/unit/erp-sync/employee-face-seeder.test.ts` (depois dos blocos `describe` de Task 4):

```typescript
import type { Person } from "../../../src/persistence/schema/persons.js";
import {
  type SeedResult,
  seedEmployeeFace,
} from "../../../src/erp-sync/employee-face-seeder.js";

// Person fixture mínimo — só os campos que o seeder lê
function makePerson(overrides?: Partial<Person>): Person {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    person_type: "employee",
    display_name: "Test Employee",
    erp_client_id: null,
    erp_employee_id: "999",
    thumbnail_path: null,
    first_seen_at: new Date(),
    last_seen_at: new Date(),
    total_visits: 0,
    avg_satisfaction: null,
    estimated_age: null,
    estimated_gender: null,
    notes: null,
    metadata: {},
    last_embedded_image_token: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as Person;
}

// Deps stubs — cada teste customiza o que importa
type Deps = Parameters<typeof seedEmployeeFace>[2];
function makeDeps(overrides?: Partial<Deps>): Deps {
  return {
    fetchPhoto: async () => ({ ok: true, jpegBuf: Buffer.from("fake-jpeg") }),
    embedFace: async () => ({
      embedding: new Array(512).fill(0.1),
      det_score: 0.95,
      crop_jpeg_b64: Buffer.from("fake-crop").toString("base64"),
      model_name: "buffalo_s",
      model_revision: "insightface-0.7.3",
      source: "frame_fallback",
    }),
    countFaceRecords: async () => 0,
    insertFaceRecord: async () => ({ id: "fr-123" }),
    updatePerson: async () => undefined,
    writeSnapshot: async () => undefined,
    photoUrlPrefix: "https://test/img/",
    snapshotsDir: "/tmp/test-snapshots",
    ...overrides,
  };
}

describe("seedEmployeeFace SeedResult scenarios", () => {
  test("placeholder → {status:'placeholder'}, ZERO side effects", async () => {
    const deps = makeDeps();
    const result = await seedEmployeeFace(makePerson(), "padrao_masc.jpg", deps);
    expect(result).toEqual({ status: "placeholder" });
  });

  test("token unchanged + count>0 → {status:'unchanged'}", async () => {
    const deps = makeDeps({ countFaceRecords: async () => 2 });
    const person = makePerson({ last_embedded_image_token: "avatar_999.jpg?abcd" });
    const result = await seedEmployeeFace(person, "avatar_999.jpg?abcd", deps);
    expect(result).toEqual({ status: "unchanged" });
  });

  test("token unchanged BUT count=0 → re-embed (status:'embedded')", async () => {
    const deps = makeDeps({ countFaceRecords: async () => 0 });
    const person = makePerson({ last_embedded_image_token: "avatar_999.jpg?abcd" });
    const result = await seedEmployeeFace(person, "avatar_999.jpg?abcd", deps);
    expect(result.status).toBe("embedded");
  });

  test("happy path → {status:'embedded', face_record_id}, snapshot saved, person updated", async () => {
    let writtenSnapshot: { path: string; bytes: Buffer } | null = null;
    let updatedPerson: { id: string; patch: Record<string, unknown> } | null = null;
    const deps = makeDeps({
      writeSnapshot: async (absPath, bytes) => {
        writtenSnapshot = { path: absPath, bytes };
      },
      updatePerson: async (id, patch) => {
        updatedPerson = { id, patch };
      },
    });
    const result = await seedEmployeeFace(makePerson(), "avatar_1966.jpg?p8yr", deps);

    expect(result.status).toBe("embedded");
    if (result.status === "embedded") expect(result.face_record_id).toBe("fr-123");

    expect(writtenSnapshot).not.toBeNull();
    expect(writtenSnapshot!.path).toContain("employee_seed/999_avatar_1966.jpg_p8yr.jpg");

    expect(updatedPerson).not.toBeNull();
    expect(updatedPerson!.patch.last_embedded_image_token).toBe("avatar_1966.jpg?p8yr");
    expect(updatedPerson!.patch.thumbnail_path).toContain("employee_seed/999_avatar_1966.jpg_p8yr.jpg");
  });

  test("fetch 404 → {status:'fetch_failed', reason:'http_4xx'}", async () => {
    const deps = makeDeps({
      fetchPhoto: async () => ({ ok: false, statusCode: 404 }),
    });
    const result = await seedEmployeeFace(makePerson(), "avatar_999.jpg?abcd", deps);
    expect(result).toEqual({ status: "fetch_failed", reason: "http_4xx" });
  });

  test("fetch timeout/dns → {status:'fetch_failed', reason}", async () => {
    const deps = makeDeps({
      fetchPhoto: async () => ({ ok: false, error: "timeout" as const }),
    });
    const result = await seedEmployeeFace(makePerson(), "avatar_999.jpg?abcd", deps);
    expect(result).toEqual({ status: "fetch_failed", reason: "timeout" });
  });

  test("sidecar 422 (no face) → {status:'no_face'}", async () => {
    const deps = makeDeps({
      embedFace: async () => {
        const err = new Error("reid /embed HTTP 422") as Error & { status?: number };
        err.status = 422;
        throw err;
      },
    });
    const result = await seedEmployeeFace(makePerson(), "avatar_999.jpg?abcd", deps);
    expect(result).toEqual({ status: "no_face" });
  });

  test("sidecar 5xx → {status:'sidecar_error', reason:'5xx'}", async () => {
    const deps = makeDeps({
      embedFace: async () => {
        const err = new Error("reid /embed HTTP 503") as Error & { status?: number };
        err.status = 503;
        throw err;
      },
    });
    const result = await seedEmployeeFace(makePerson(), "avatar_999.jpg?abcd", deps);
    expect(result.status).toBe("sidecar_error");
    if (result.status === "sidecar_error") expect(result.reason).toBe("5xx");
  });

  test("FK violation (Person sumiu) → {status:'sidecar_error', detail:'person_fk_violation'}", async () => {
    const deps = makeDeps({
      insertFaceRecord: async () => {
        const err = new Error('insert or update on table "face_records" violates foreign key') as Error & {
          code?: string;
        };
        err.code = "23503";
        throw err;
      },
    });
    const result = await seedEmployeeFace(makePerson(), "avatar_999.jpg?abcd", deps);
    expect(result.status).toBe("sidecar_error");
    if (result.status === "sidecar_error") {
      expect(result.detail).toBe("person_fk_violation");
    }
  });
});
```

- [ ] **Step 2: Run tests (fail — types + function não-existem)**

`cd packages/edge && bun test tests/unit/erp-sync/employee-face-seeder.test.ts`
Expected: fail c/ "Cannot find name 'SeedResult'" / "seedEmployeeFace is not a function".

- [ ] **Step 3: Implement SeedResult + seedEmployeeFace**

Em `packages/edge/src/erp-sync/employee-face-seeder.ts`, adicionar (após os helpers de Task 4):

```typescript
import path from "node:path";
import { logger } from "../obs/logger.js";
import type { Person } from "../persistence/schema/persons.js";

/** Saída discriminada do seeder — define test matrix e log aggregation. */
export type SeedResult =
  | { status: "placeholder" }
  | { status: "unchanged" }
  | { status: "embedded"; face_record_id: string }
  | {
      status: "fetch_failed";
      reason: "http_4xx" | "http_5xx" | "timeout" | "dns" | "network";
      detail?: string;
    }
  | { status: "no_face" }
  | {
      status: "sidecar_error";
      reason: "timeout" | "5xx" | "network";
      detail?: string;
    };

/** Resultado do fetch da foto — abstrai HTTP pra permitir mock + classificação de erro. */
export type FetchResult =
  | { ok: true; jpegBuf: Buffer }
  | { ok: false; statusCode: number }
  | { ok: false; error: "timeout" | "dns" | "network"; detail?: string };

/** Saída do sidecar /embed conforme `EmbedResult` de @vipcam/shared, mas
 * restrito ao que o seeder lê (não acoplado ao tipo full do shared). */
export interface EmbedFaceResult {
  embedding: number[];
  det_score: number;
  crop_jpeg_b64: string;
  model_name: string;
  model_revision: string;
  source?: "bbox" | "frame_fallback";
}

/** Dependências injetadas — todas substituíveis em tests. */
export interface SeederDeps {
  fetchPhoto(absoluteUrl: string): Promise<FetchResult>;
  embedFace(jpegBuf: Buffer): Promise<EmbedFaceResult>;
  countFaceRecords(personId: string): Promise<number>;
  insertFaceRecord(input: {
    person_id: string;
    embedding: number[];
    snapshot_path: string;
    det_score: number;
    is_primary: boolean;
    source: "erp_seed";
    model_name: string;
    model_revision: string;
  }): Promise<{ id: string }>;
  updatePerson(id: string, patch: { last_embedded_image_token: string; thumbnail_path: string }): Promise<void>;
  writeSnapshot(absPath: string, jpegBuf: Buffer): Promise<void>;
  photoUrlPrefix: string;
  snapshotsDir: string;
}

/**
 * Orquestra o seed da face de 1 employee. Idempotente via
 * person.last_embedded_image_token + countFaceRecords(person.id) > 0 check.
 *
 * Retorna SeedResult discriminado — caller (syncEmployees) faz aggregate
 * + log estruturado. NUNCA throw: erros viram variantes do union.
 */
export async function seedEmployeeFace(
  person: Person,
  photoUrl: string,
  deps: SeederDeps,
): Promise<SeedResult> {
  if (isPlaceholder(photoUrl)) {
    return { status: "placeholder" };
  }

  const existingCount = await deps.countFaceRecords(person.id);
  if (person.last_embedded_image_token === photoUrl && existingCount > 0) {
    return { status: "unchanged" };
  }

  const absoluteUrl = `${deps.photoUrlPrefix}${photoUrl}`;
  const fetchRes = await deps.fetchPhoto(absoluteUrl);

  if (!fetchRes.ok) {
    if ("statusCode" in fetchRes) {
      const reason = fetchRes.statusCode >= 500 ? "http_5xx" : "http_4xx";
      logger.warn(
        { erp_employee_id: person.erp_employee_id, statusCode: fetchRes.statusCode, reason },
        "employee photo fetch failed (HTTP)",
      );
      return { status: "fetch_failed", reason };
    }
    logger.warn(
      { erp_employee_id: person.erp_employee_id, error: fetchRes.error, detail: fetchRes.detail },
      "employee photo fetch failed (network)",
    );
    const result: SeedResult = { status: "fetch_failed", reason: fetchRes.error };
    if (fetchRes.detail !== undefined) result.detail = fetchRes.detail;
    return result;
  }

  let embedResult: EmbedFaceResult;
  try {
    embedResult = await deps.embedFace(fetchRes.jpegBuf);
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 422) {
      logger.warn(
        { erp_employee_id: person.erp_employee_id },
        "sidecar /embed: no face detected",
      );
      return { status: "no_face" };
    }
    const reason: "5xx" | "timeout" | "network" =
      e.status !== undefined && e.status >= 500
        ? "5xx"
        : /timeout/i.test(e.message)
          ? "timeout"
          : "network";
    logger.error(
      { erp_employee_id: person.erp_employee_id, message: e.message, status: e.status, reason },
      "sidecar /embed call failed",
    );
    return { status: "sidecar_error", reason, detail: e.message };
  }

  // Defensive: crop_jpeg_b64 sempre presente em sidecar Onda 7+, mas
  // protege contra sidecar v0 (sem o campo).
  if (!embedResult.crop_jpeg_b64) {
    logger.error(
      { erp_employee_id: person.erp_employee_id },
      "sidecar /embed response missing crop_jpeg_b64 — sidecar version mismatch?",
    );
    return { status: "sidecar_error", reason: "network", detail: "missing_crop_jpeg_b64" };
  }

  // Snapshot persistence
  const snapshotRelPath = `employee_seed/${person.erp_employee_id}_${sanitizeToken(photoUrl)}.jpg`;
  const absSnapshotPath = path.join(deps.snapshotsDir, snapshotRelPath);
  await deps.writeSnapshot(absSnapshotPath, Buffer.from(embedResult.crop_jpeg_b64, "base64"));

  // Face record + FK violation defensive catch
  let fr: { id: string };
  try {
    fr = await deps.insertFaceRecord({
      person_id: person.id,
      embedding: embedResult.embedding,
      snapshot_path: snapshotRelPath,
      det_score: embedResult.det_score,
      is_primary: existingCount === 0,
      source: "erp_seed",
      model_name: embedResult.model_name,
      model_revision: embedResult.model_revision,
    });
  } catch (err) {
    const e = err as Error & { code?: string };
    if (e.code === "23503") {
      logger.warn(
        { erp_employee_id: person.erp_employee_id, person_id: person.id },
        "face_record FK violation — Person disappeared during seed (race c/ mergeInto?)",
      );
      return { status: "sidecar_error", reason: "network", detail: "person_fk_violation" };
    }
    throw err;
  }

  // Person update — token + thumbnail
  await deps.updatePerson(person.id, {
    last_embedded_image_token: photoUrl,
    thumbnail_path: snapshotRelPath,
  });

  return { status: "embedded", face_record_id: fr.id };
}
```

> **Verificar antes do commit:** types específicos do projeto — `Person` é exportado de `../persistence/schema/persons.js`? Confirmar via `grep "export type Person" packages/edge/src/persistence/schema/persons.ts`. Se for `import type { Person }`, OK; se for inferido (`typeof persons.$inferSelect`), criar local alias.

- [ ] **Step 4: Run tests (pass — 8 SeedResult cenários)**

`cd packages/edge && bun test tests/unit/erp-sync/employee-face-seeder.test.ts` → 14 PASS (6 do Task 4 + 8 SeedResult).

- [ ] **Step 5: Run typecheck**

`cd packages/edge && bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/edge/src/erp-sync/employee-face-seeder.ts \
        packages/edge/tests/unit/erp-sync/employee-face-seeder.test.ts
git commit -m "feat(edge): Onda 9-B — SeedResult + seedEmployeeFace c/ deps injetadas"
```

---

### Task 6: Env var + photo fetch + reid embed real implementations

**Spec ref:** §4.1 (env var), §5.1 (bbox oversize trick).

**Files:**
- Modify: `packages/edge/src/config/env.ts` — adicionar `ERP_PHOTO_URL_PREFIX`
- Create: `packages/edge/src/erp-sync/employee-face-seeder-deps.ts` — factory que monta `SeederDeps` produção (fetch, reid embed, repos)
- Test: `packages/edge/tests/unit/erp-sync/employee-face-seeder-deps.test.ts` (create — testa fetch classification de error)

Separa "logic" (Task 5, deps-injected, pure-ish) de "wiring" (Task 6, real HTTP + repo calls). Mantém o seeder testável sem mockar fetch global.

- [ ] **Step 1: Failing test — env var validation**

Adicionar ao test existente de env (provavelmente `packages/edge/tests/unit/config/env.test.ts` — se não-existir, criar inline no novo arquivo abaixo).

`packages/edge/tests/unit/erp-sync/employee-face-seeder-deps.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import {
  classifyFetchError,
  fetchPhotoLive,
} from "../../../src/erp-sync/employee-face-seeder-deps.js";

describe("classifyFetchError", () => {
  test("AbortError → timeout", () => {
    const err = new Error("aborted") as Error & { name?: string };
    err.name = "TimeoutError";
    expect(classifyFetchError(err)).toEqual({ kind: "timeout" });
  });

  test("ENOTFOUND → dns", () => {
    const err = new Error("getaddrinfo ENOTFOUND example.invalid") as Error & {
      code?: string;
    };
    err.code = "ENOTFOUND";
    expect(classifyFetchError(err)).toEqual({ kind: "dns" });
  });

  test("default → network c/ detail", () => {
    const err = new Error("ECONNREFUSED 127.0.0.1:80");
    expect(classifyFetchError(err)).toEqual({ kind: "network", detail: "ECONNREFUSED 127.0.0.1:80" });
  });
});

describe("fetchPhotoLive (integration-lite — uses local 127.0.0.1 unreachable port)", () => {
  test("connection refused → { ok: false, error: 'network' }", async () => {
    // Porta 1 quase sempre rejeita conexão
    const result = await fetchPhotoLive("http://127.0.0.1:1/no-such", 500);
    expect(result.ok).toBe(false);
    if (!result.ok && "error" in result) {
      expect(["network", "timeout"]).toContain(result.error);
    }
  });
});
```

- [ ] **Step 2: Run tests (fail — module + functions não-existem)**

`cd packages/edge && bun test tests/unit/erp-sync/employee-face-seeder-deps.test.ts`
Expected: fail c/ "Cannot find module".

- [ ] **Step 3: Implement env var**

Em `packages/edge/src/config/env.ts`, no `envSchema` (procurar onde outras `ERP_*` vars são definidas), adicionar:
```typescript
    ERP_PHOTO_URL_PREFIX: z
      .string()
      .url()
      .default("https://www.franquiabv.com.br/img/usuarios/"),
```

> **Verificar antes:** confirme via `grep "ERP_QUERY_EMPLOYEES" packages/edge/src/config/env.ts` que outras ERP_* vars existem (têm padrão de validação) e que o `envSchema` aceita esse formato. Override em produção via `/etc/vipcam/edge.env`.

- [ ] **Step 4: Implement employee-face-seeder-deps.ts**

Criar `packages/edge/src/erp-sync/employee-face-seeder-deps.ts`:
```typescript
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { embed as reidEmbed } from "../discovery/image-probe/reid-client.js";
import { faceRecordsRepo, personsRepo } from "../persistence/repositories/index.js";
import type {
  EmbedFaceResult,
  FetchResult,
  SeederDeps,
} from "./employee-face-seeder.js";

/** Classifica erro do fetch global pra mapear no FetchResult.error.
 * Exportada pra unit-testabilidade. */
export function classifyFetchError(err: Error & { name?: string; code?: string }): {
  kind: "timeout" | "dns" | "network";
  detail?: string;
} {
  if (err.name === "TimeoutError" || err.name === "AbortError") {
    return { kind: "timeout" };
  }
  if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") {
    return { kind: "dns" };
  }
  return { kind: "network", detail: err.message };
}

/**
 * Fetch real da foto via global fetch + AbortSignal.timeout. Defensive
 * timeout (10s default) — ERP web app geralmente responde <500ms.
 */
export async function fetchPhotoLive(absoluteUrl: string, timeoutMs = 10_000): Promise<FetchResult> {
  let response: Response;
  try {
    response = await fetch(absoluteUrl, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const { kind, detail } = classifyFetchError(err as Error & { name?: string; code?: string });
    const result: FetchResult =
      detail !== undefined
        ? { ok: false, error: kind, detail }
        : { ok: false, error: kind };
    return result;
  }
  if (!response.ok) {
    return { ok: false, statusCode: response.status };
  }
  const jpegBuf = Buffer.from(await response.arrayBuffer());
  return { ok: true, jpegBuf };
}

/**
 * Chama sidecar reid /embed com bbox oversize (HACK §5.1 spec) pra triggerar
 * frame_fallback path. Sidecar detecta + embeda no frame inteiro.
 *
 * Repassa ReidError lançada pelo reid-client — caller (seedEmployeeFace) trata
 * mapping 422 → no_face / 5xx → sidecar_error.
 */
export async function embedFaceLive(
  reidBaseUrl: string,
  jpegBuf: Buffer,
  timeoutMs = 5_000,
): Promise<EmbedFaceResult> {
  // HACK: bbox oversize força o sidecar a cair em `_embed_pil(full_frame)` —
  // path "frame_fallback" documentado em packages/reid/src/main.py:137.
  // Validado pelo integration test §6.3 cenário 2 (early-warning se sidecar
  // v2+ endurecer guard).
  const result = await reidEmbed(reidBaseUrl, jpegBuf, { x: 0, y: 0, w: 99_999, h: 99_999 }, timeoutMs);
  return result;
}

/**
 * Factory: monta o objeto SeederDeps c/ implementações produção.
 * Usado pelo syncEmployees.
 */
export function makeProductionDeps(env: {
  ERP_PHOTO_URL_PREFIX: string;
  SNAPSHOTS_DIR: string;
  REID_BASE_URL: string;
}): SeederDeps {
  return {
    fetchPhoto: (absUrl) => fetchPhotoLive(absUrl),
    embedFace: (jpegBuf) => embedFaceLive(env.REID_BASE_URL, jpegBuf),
    countFaceRecords: (personId) => faceRecordsRepo.countByPerson(personId),
    insertFaceRecord: (input) => faceRecordsRepo.insertAndEvict(input),
    updatePerson: async (id, patch) => {
      await personsRepo.update(id, patch);
    },
    writeSnapshot: async (absPath, bytes) => {
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, bytes);
    },
    photoUrlPrefix: env.ERP_PHOTO_URL_PREFIX,
    snapshotsDir: env.SNAPSHOTS_DIR,
  };
}
```

- [ ] **Step 5: Run tests (pass)**

`cd packages/edge && bun test tests/unit/erp-sync/employee-face-seeder-deps.test.ts` → 4 PASS.

- [ ] **Step 6: Run typecheck**

`cd packages/edge && bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/edge/src/config/env.ts \
        packages/edge/src/erp-sync/employee-face-seeder-deps.ts \
        packages/edge/tests/unit/erp-sync/employee-face-seeder-deps.test.ts
git commit -m "feat(edge): Onda 9-B — ERP_PHOTO_URL_PREFIX + seeder deps factory"
```

---

---

## Chunk 3: Wiring + integration tests + smoke

Integra o seeder no `syncEmployees` (per-employee try/catch + aggregate counters), adiciona integration tests DB-deferred com fixture HTTP local, e fecha com smoke pré-deploy.

**Tasks:** 7-9.
**Sequência:** 7 (syncEmployees integration) → 8 (integration tests DB-deferred) → 9 (final smoke).
**Pré-requisito:** Chunks 1 + 2 mergeados.

---

### Task 7: Wire seeder into syncEmployees + per-employee try/catch + aggregate log

**Spec ref:** §4.2, §5.2 step 4 (aggregate counter), §5.4.

**Files:**
- Modify: `packages/edge/src/erp-sync/employees.ts` — chamada do seeder + counters expandidos + try/catch
- Modify: `packages/edge/tests/unit/erp-sync/employees.test.ts` (create se não-existir; extend)

- [ ] **Step 1: Failing regression test**

`packages/edge/tests/unit/erp-sync/employees.test.ts`:
```typescript
import { beforeEach, describe, expect, mock, test } from "bun:test";

let fetchedRows: Array<Record<string, unknown>> = [];
let upsertEmployeeCalls = 0;
let personsCreateCalls: Array<{ erp_employee_id: string; display_name: string }> = [];
let personsUpdateCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];
let seedCalls: Array<{ erpId: string | undefined; photoUrl: string }> = [];
let seedResult: { status: string; reason?: string } = { status: "embedded", face_record_id: "fr-1" };
let seedShouldThrow = false;

const installMocks = () => {
  mock.module("../../../src/erp-sync/queries.js", () => ({
    fetchErpEmployees: async () => fetchedRows,
  }));
  mock.module("../../../src/persistence/repositories/index.js", () => ({
    erpRepo: {
      findEmployeeByErpId: async () => null,  // sempre cria new
      upsertEmployee: async () => {
        upsertEmployeeCalls += 1;
      },
    },
    personsRepo: {
      create: async (data: { erp_employee_id: string; display_name: string }) => {
        personsCreateCalls.push(data);
        return { id: `p-${data.erp_employee_id}`, ...data };
      },
      update: async (id: string, patch: Record<string, unknown>) => {
        personsUpdateCalls.push({ id, patch });
        return { id, ...patch };
      },
      findByErpEmployeeId: async () => null,
    },
  }));
  mock.module("../../../src/erp-sync/employee-face-seeder.js", () => ({
    seedEmployeeFace: async (
      person: { erp_employee_id: string },
      photoUrl: string,
    ) => {
      seedCalls.push({ erpId: person.erp_employee_id, photoUrl });
      if (seedShouldThrow) throw new Error("seeder boom");
      return seedResult;
    },
  }));
  mock.module("../../../src/erp-sync/employee-face-seeder-deps.js", () => ({
    makeProductionDeps: () => ({}),
  }));
};
installMocks();

import { syncEmployees } from "../../../src/erp-sync/employees.js";

beforeEach(() => {
  fetchedRows = [];
  upsertEmployeeCalls = 0;
  personsCreateCalls = [];
  personsUpdateCalls = [];
  seedCalls = [];
  seedResult = { status: "embedded", face_record_id: "fr-1" };
  seedShouldThrow = false;
  installMocks();
});

describe("syncEmployees Onda 9-B integration", () => {
  test("para cada row chama upsertEmployee + Person.create + seedEmployeeFace", async () => {
    fetchedRows = [
      { id: 999, name: "Wagner", is_active: 1, photo_url: "avatar_999.jpg?p8yr" },
      { id: 998, name: "Maria", is_active: 1, photo_url: "padrao_fem.jpg" },
    ];
    const result = await syncEmployees();
    expect(upsertEmployeeCalls).toBe(2);
    expect(personsCreateCalls).toHaveLength(2);
    expect(seedCalls).toEqual([
      { erpId: "999", photoUrl: "avatar_999.jpg?p8yr" },
      { erpId: "998", photoUrl: "padrao_fem.jpg" },
    ]);
    expect(result.fetched).toBe(2);
    expect(result.created).toBe(2);
  });

  test("falha do seeder NÃO interrompe loop pros próximos employees", async () => {
    fetchedRows = [
      { id: 100, name: "A", is_active: 1, photo_url: "avatar_100.jpg?aaaa" },
      { id: 200, name: "B", is_active: 1, photo_url: "avatar_200.jpg?bbbb" },
    ];
    let callIdx = 0;
    seedShouldThrow = false;
    mock.module("../../../src/erp-sync/employee-face-seeder.js", () => ({
      seedEmployeeFace: async (person: { erp_employee_id: string }, photoUrl: string) => {
        seedCalls.push({ erpId: person.erp_employee_id, photoUrl });
        callIdx += 1;
        if (callIdx === 1) throw new Error("seeder boom for #1");
        return { status: "embedded", face_record_id: "fr-2" };
      },
    }));
    const result = await syncEmployees();
    expect(seedCalls).toHaveLength(2);  // ambos chamados, primeiro deu erro
    expect(result.fetched).toBe(2);
  });

  test("aggregate result tem counters por SeedResult status", async () => {
    fetchedRows = [
      { id: 1, name: "n", is_active: 1, photo_url: "padrao_masc.jpg" },
      { id: 2, name: "n", is_active: 1, photo_url: "avatar_2.jpg?xxxx" },
    ];
    let i = 0;
    mock.module("../../../src/erp-sync/employee-face-seeder.js", () => ({
      seedEmployeeFace: async () => {
        i += 1;
        return i === 1
          ? { status: "placeholder" }
          : { status: "embedded", face_record_id: "fr" };
      },
    }));
    const result = await syncEmployees();
    expect(result.embedded).toBe(1);
    expect(result.skipped_placeholder).toBe(1);
  });
});
```

- [ ] **Step 2: Run test (fail — syncEmployees ainda não chama seeder)**

`cd packages/edge && bun test tests/unit/erp-sync/employees.test.ts`
Expected: `seedCalls.length === 0` quando expected 2. Falha.

- [ ] **Step 3: Modify employees.ts**

Em `packages/edge/src/erp-sync/employees.ts`:

(a) Expandir `SyncResult` (substituir interface existente):
```typescript
export interface SyncResult {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  // Onda 9-B: per-employee seeder outcomes
  embedded: number;
  skipped_placeholder: number;
  skipped_unchanged: number;
  fetch_failed: number;
  no_face: number;
  sidecar_error: number;
  seeder_unexpected_error: number;
}
```

(b) No topo do arquivo, importar:
```typescript
import { getEnv } from "../config/env.js";
import { seedEmployeeFace } from "./employee-face-seeder.js";
import { makeProductionDeps } from "./employee-face-seeder-deps.js";
```

(c) Modificar a função pra chamar o seeder após cada `personsRepo.create/update`. Pseudo-diff:
```typescript
export async function syncEmployees(): Promise<SyncResult> {
  const rows = await fetchErpEmployees();
  const env = getEnv();
  const deps = makeProductionDeps(env);
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let embedded = 0;
  let skipped_placeholder = 0;
  let skipped_unchanged = 0;
  let fetch_failed = 0;
  let no_face = 0;
  let sidecar_error = 0;
  let seeder_unexpected_error = 0;

  for (const row of rows) {
    const erpId = String(row.id);
    const isActive = Boolean(row.is_active);
    const existing = await erpRepo.findEmployeeByErpId(erpId);
    let person: Awaited<ReturnType<typeof personsRepo.findByErpEmployeeId>> = null;

    if (!existing) {
      // ... código existente do branch create ...
      // (preservar inteiro — só captura o person retornado pra passar pro seeder)
      const newRow: NewErpEmployee = { erp_id: erpId, name: row.name, is_active: isActive };
      if (row.role !== undefined) newRow.role = row.role;
      if (row.photo_url !== undefined) newRow.photo_path = row.photo_url;
      if (row.photo_updated_at !== undefined) newRow.erp_updated_at = new Date(row.photo_updated_at);
      await erpRepo.upsertEmployee(newRow);
      person = await personsRepo.create({
        person_type: "employee",
        display_name: row.name,
        erp_employee_id: erpId,
      });
      created += 1;
    } else {
      // ... código existente do branch update (inalterado) ...
      const nameChanged = row.name !== existing.name;
      const activeChanged = isActive !== existing.is_active;
      const roleChanged = row.role !== undefined && existing.role !== row.role;
      const photoChanged = row.photo_url !== undefined && existing.photo_path !== row.photo_url;
      if (nameChanged || activeChanged || roleChanged || photoChanged) {
        const patch: NewErpEmployee = { ...existing, name: row.name, is_active: isActive };
        if (row.role !== undefined) patch.role = row.role;
        if (row.photo_url !== undefined) patch.photo_path = row.photo_url;
        if (row.photo_updated_at !== undefined) patch.erp_updated_at = new Date(row.photo_updated_at);
        await erpRepo.upsertEmployee(patch);
        if (nameChanged) {
          const p = await personsRepo.findByErpEmployeeId(erpId);
          if (p) await personsRepo.update(p.id, { display_name: row.name });
        }
        updated += 1;
      } else {
        skipped += 1;
      }
      person = await personsRepo.findByErpEmployeeId(erpId);
    }

    // Onda 9-B: seed face — falhas NÃO interrompem o loop
    if (person && row.photo_url !== undefined) {
      try {
        const result = await seedEmployeeFace(person, row.photo_url, deps);
        switch (result.status) {
          case "embedded": embedded += 1; break;
          case "placeholder": skipped_placeholder += 1; break;
          case "unchanged": skipped_unchanged += 1; break;
          case "fetch_failed": fetch_failed += 1; break;
          case "no_face": no_face += 1; break;
          case "sidecar_error": sidecar_error += 1; break;
        }
      } catch (err) {
        seeder_unexpected_error += 1;
        logger.error(
          { erp_employee_id: erpId, err },
          "seedEmployeeFace unexpected error",
        );
      }
    }
  }

  const result: SyncResult = {
    fetched: rows.length,
    created,
    updated,
    skipped,
    embedded,
    skipped_placeholder,
    skipped_unchanged,
    fetch_failed,
    no_face,
    sidecar_error,
    seeder_unexpected_error,
  };
  logger.info(result, "employee sync complete");
  return result;
}
```

> **Verificar antes:** o existing branch update do código atual NÃO atribuía `person` no fim — precisa adicionar `person = await personsRepo.findByErpEmployeeId(erpId)` no final do branch. Confirme via read do arquivo atual.

- [ ] **Step 4: Run tests (pass)**

`cd packages/edge && bun test tests/unit/erp-sync/employees.test.ts` → 3 PASS.

- [ ] **Step 5: Run typecheck**

`cd packages/edge && bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/edge/src/erp-sync/employees.ts \
        packages/edge/tests/unit/erp-sync/employees.test.ts
git commit -m "feat(edge): Onda 9-B — syncEmployees wire seedEmployeeFace + counters"
```

---

### Task 8: Integration tests (DB-deferred — happy path + frame_fallback contract)

**Spec ref:** §6.3.

**Files:**
- Create: `packages/edge/tests/integration/erp-sync/employee-face-seeder-integration.test.ts` (DB-deferred)
- Create: `packages/edge/tests/fixtures/employee-photos/test-face.jpg` (binary fixture)

Valida o seeder end-to-end com sidecar + DB reais. Usa fixture JPEG local servido por HTTP server in-process pra evitar dep da internet em CI.

- [ ] **Step 1: Get/generate face fixture**

Opções (escolha a mais barata):
- (a) Foto CC0 stock de face frontal (Pexels/Unsplash) — download manual + commit
- (b) Reusar 1 frame de teste do InsightFace samples (se já tem em outro test fixture path)
- (c) Capturar 1 frame real da câmera DH-IPC durante dev — JPEG ~50-100 KB

Salvar em `packages/edge/tests/fixtures/employee-photos/test-face.jpg`. Validar size <500KB.

```bash
ls -la packages/edge/tests/fixtures/employee-photos/test-face.jpg
# Expected: file existe, size razoável (50-200KB)
```

- [ ] **Step 2: Write integration test**

`packages/edge/tests/integration/erp-sync/employee-face-seeder-integration.test.ts`:
```typescript
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { seedEmployeeFace } from "../../../src/erp-sync/employee-face-seeder.js";
import { makeProductionDeps } from "../../../src/erp-sync/employee-face-seeder-deps.js";
import { getDb } from "../../../src/persistence/db.js";
import { faceRecordsRepo, personsRepo } from "../../../src/persistence/repositories/index.js";

let fixtureBytes: Buffer;
let server: ReturnType<typeof Bun.serve>;
let fixtureUrl: string;
let personId: string;

beforeAll(async () => {
  fixtureBytes = await readFile(
    join(import.meta.dir, "../../fixtures/employee-photos/test-face.jpg"),
  );
  server = Bun.serve({
    port: 0,  // random
    fetch(req) {
      if (new URL(req.url).pathname === "/test-face.jpg") {
        return new Response(fixtureBytes, { headers: { "content-type": "image/jpeg" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  fixtureUrl = `http://127.0.0.1:${server.port}/`;
});

afterAll(() => server.stop(true));

beforeEach(async () => {
  const p = await personsRepo.create({
    display_name: "Test Employee Seed",
    person_type: "employee",
    erp_employee_id: `test-9b-${Date.now()}`,
  });
  personId = p.id;
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`DELETE FROM face_records WHERE person_id = ${personId}`);
  await db.execute(sql`DELETE FROM persons WHERE id = ${personId}`);
});

describe("seedEmployeeFace end-to-end (DB + sidecar real)", () => {
  test("happy path: foto válida → face_record source='erp_seed' + Person.last_embedded_image_token", async () => {
    const env = (await import("../../../src/config/env.js")).getEnv();
    const deps = makeProductionDeps({
      ERP_PHOTO_URL_PREFIX: fixtureUrl,
      SNAPSHOTS_DIR: env.SNAPSHOTS_DIR,
      REID_BASE_URL: env.REID_BASE_URL,
    });

    const person = (await personsRepo.findById(personId))!;
    const result = await seedEmployeeFace(person, "test-face.jpg", deps);

    expect(result.status).toBe("embedded");

    // Assert face_record created with source='erp_seed'
    const [fr] = await getDb()
      .execute<{ source: string; det_score: number | null }>(sql`
        SELECT source, det_score FROM face_records WHERE person_id = ${personId}
      `);
    expect(fr?.source).toBe("erp_seed");
    expect(fr?.det_score).toBeGreaterThan(0);

    // Assert Person updated
    const updated = await personsRepo.findById(personId);
    expect(updated?.last_embedded_image_token).toBe("test-face.jpg");
    expect(updated?.thumbnail_path).toContain("employee_seed/");
  });

  test("frame_fallback contract — sidecar aceita bbox oversize (signals breakage se v2+ endurecer)", async () => {
    const env = (await import("../../../src/config/env.js")).getEnv();
    const deps = makeProductionDeps({
      ERP_PHOTO_URL_PREFIX: fixtureUrl,
      SNAPSHOTS_DIR: env.SNAPSHOTS_DIR,
      REID_BASE_URL: env.REID_BASE_URL,
    });

    const person = (await personsRepo.findById(personId))!;
    const result = await seedEmployeeFace(person, "test-face.jpg", deps);

    // Acessar embed result diretamente seria mais clean, mas seedEmployeeFace
    // não expõe — então afirma indiretamente: embed sucede SE o hack funciona.
    // status !== 'sidecar_error' E !== 'no_face' (rosto válido na fixture).
    expect(result.status).toBe("embedded");

    // Defensive: se sidecar v2+ adicionar source field e response, valida
    // (campo é opcional em EmbedResult conforme shared/types/reid.ts).
    // Este check vive no embedFaceLive — não verifica aqui pra evitar
    // coupling com internal call shape.
  });
});
```

- [ ] **Step 3: Run integration test (DB-deferred OR PASS)**

`bash packages/edge/scripts/run-integration-tests.sh tests/integration/erp-sync/employee-face-seeder-integration.test.ts`
- Sem DB local: DB-deferred (esperado neste dev — rodará no VPS pós-deploy)
- Com DB + sidecar: 2 PASS

- [ ] **Step 4: Commit**

```bash
git add packages/edge/tests/fixtures/employee-photos/test-face.jpg \
        packages/edge/tests/integration/erp-sync/employee-face-seeder-integration.test.ts
git commit -m "feat(edge): Onda 9-B — integration tests (happy path + frame_fallback contract)"
```

---

### Task 9: Final verification + smoke pré-deploy

**Spec ref:** §6.4, §8, §9.

**Files:** nenhum novo — só verificação.

- [ ] **Step 1: Offline gates completos**

```bash
bun --filter '*' typecheck       # 3/3 packages
bun run lint                     # warnings OK pre-existentes; ZERO error novo dos arquivos Onda 9-B
cd packages/edge && bun run test # baseline + ~14 unit tests novos
cd packages/web && bun test      # baseline (web não muda nesta onda)
cd packages/web && bun run build # confirma `/matches`, `/people`, etc compilam
```

Esperado:
- typecheck 3/3 ✓
- lint: sem erros novos nos arquivos `erp-sync/employee-face-seeder*.ts` (warnings pre-existentes de outros arquivos OK)
- edge unit: baseline + ~14 novos (schema:2, helpers:6, SeedResult:8, syncEmployees:3, deps:4 = +23 testes novos; descontados overlaps)
- web: passa idêntico ao baseline
- web build ✓

- [ ] **Step 2: DB-deferred tests inventory**

```
DB-deferred (rodam no VPS pós-deploy, requerem vipcam_test DB ou produção c/ guard):
- tests/integration/persistence/face-records-repo.test.ts (Task 3 — countByPerson)
- tests/integration/erp-sync/employee-face-seeder-integration.test.ts (Task 8 — happy + frame_fallback)
```

> **Nota:** integration tests só rodam quando `DATABASE_URL` aponta pra DB c/ "test" no nome OU `VIPCAM_TEST_DB_OK=yes-i-know-what-im-doing`. Vide chip aberto "Provisionar vipcam_test DB no VPS" (débito Onda 9-A).

- [ ] **Step 3: Pré-merge sanity**

```bash
git log --oneline master..HEAD
git diff master --stat | tail -15
```

Sequência esperada (8-10 commits Onda 9-B + 4 spec):
- spec (4): commit inicial + 3 reviewer rounds
- task 1: schema migration
- task 2: pipeline.ts source
- task 3: countByPerson
- task 4: helpers
- task 5: SeedResult + seedEmployeeFace
- task 6: env + deps
- task 7: syncEmployees integration
- task 8: integration tests + fixture

- [ ] **Step 4: Operational follow-up checklist (FOR HUMAN)**

Pós-merge no VPS:
```bash
cd /opt/vipcamv2
sudo -u vipcam git pull          # traz Onda 9-B
./deploy.sh                      # rebuild edge + migration 0009 auto via ExecStartPost
sudo systemctl restart vipcam-edge
sleep 5
sudo journalctl -u vipcam-edge -n 30 --no-pager | grep -E "scheduler started|employee sync complete"

# Smoke health (esperar 4 checks verdes igual hoje)
KEY=$(sudo grep '^API_KEY=' /etc/vipcam/edge.env | cut -d= -f2)
curl -s -H "X-API-Key: $KEY" 'https://monitoramento.franquiabv.com.br/api/health' | jq .

# Verificar colunas novas existem
sudo -u vipcam psql "$(sudo grep '^DATABASE_URL=' /etc/vipcam/edge.env | cut -d= -f2-)" -c "\d persons" | grep last_embedded_image_token
sudo -u vipcam psql "$(sudo grep '^DATABASE_URL=' /etc/vipcam/edge.env | cut -d= -f2-)" -c "\d face_records" | grep source

# Aguardar 1h (primeiro sync hourly de employees) + queries do spec §6.4
sudo -u vipcam psql "$(sudo grep '^DATABASE_URL=' /etc/vipcam/edge.env | cut -d= -f2-)" -c "
SELECT
  COUNT(*) AS employees_total,
  COUNT(p.id) FILTER (WHERE fr.id IS NOT NULL) AS with_face,
  COUNT(*) FILTER (WHERE p.last_embedded_image_token IS NULL) AS never_attempted
FROM persons p
LEFT JOIN face_records fr ON fr.person_id = p.id AND fr.source = 'erp_seed'
WHERE p.person_type = 'employee';
"

# Esperado após 1h: with_face ~180-300 (proporção real), never_attempted ~0
```

- [ ] **Step 5: Verdict + handoff pra finishing-a-development-branch**

Se todos gates verdes:
```
✅ Onda 9-B ready to ship.
- Offline gates: typecheck 3/3, edge unit ~baseline + 23, web build ✓
- DB-deferred (3 integration files) → VPS pós-deploy
- Migration 0009 forward-only, sem replay retroativo
- Spec compliance: 3 rounds spec-reviewer approved
```

Invocar `superpowers:finishing-a-development-branch` pra merge/PR.

---

## Calibração pós-deploy (7 dias)

Per spec §9, monitorar via SQL semanalmente:

```sql
-- Coverage de employees com face_records
SELECT
  COUNT(*) AS employees_total,
  COUNT(p.id) FILTER (WHERE fr.id IS NOT NULL) AS with_face,
  ROUND(100.0 * COUNT(p.id) FILTER (WHERE fr.id IS NOT NULL) / COUNT(*), 1) AS pct_with_face
FROM persons p
LEFT JOIN face_records fr ON fr.person_id = p.id AND fr.source = 'erp_seed'
WHERE p.person_type = 'employee';

-- match_attempts ambiguous rate (esperado cair vs baseline pré-Onda 9-B)
SELECT
  DATE_TRUNC('day', decided_at) AS dia,
  COUNT(*) FILTER (WHERE decision = 'ambiguous') AS ambig,
  COUNT(*) AS total,
  ROUND(100.0 * COUNT(*) FILTER (WHERE decision = 'ambiguous') / COUNT(*), 1) AS pct_ambig
FROM match_attempts
WHERE decided_at > now() - interval '14 days'
GROUP BY 1
ORDER BY 1;
```

Triggers de tuning:
- Se `pct_with_face < 70%`: investigar logs `fetch_failed` (URL prefix errada?) + `no_face` (foto ERP qualidade ruim?)
- Se `pct_ambig` não cair vs baseline pré-deploy: investigar se employees identificadas estão sendo filtradas corretamente pelo match-temp (Pass 2 da Onda 9-A)

Onda 9-B fechada após 7 dias estáveis + report em `2026-XX-XX-onda-9b-report.md`.
