# Onda 7 — Failover B (re-id local) + Snapshots no /live — Implementation Plan

> **For agentic workers:** REQUIRED: Use **superpowers:subagent-driven-development** (if subagents available) or **superpowers:executing-plans** to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconhecer anônimos recorrentes via InsightFace + pgvector e exibir o rosto recortado nos cards do `/live`, resolvendo simultaneamente o blank snapshots em produção e o Failover B prometido desde a Onda 2.

**Architecture:** Pipeline `processEvent` ganha 3 etapas síncronas (capture `snapshot.cgi` → crop+embedding via sidecar Python → ANN match pgvector). Dual-threshold (strict ≤0.35, loose ≤0.55, nova >0.55) decide se auto-link, vira borderline pra revisão humana, ou cria anonymous novo. Sidecar `vipcam-reid` ganha endpoint `/embed`. Schema ganha 3 deltas (face_records colunas novas, reid_match_attempts, person_merge_audit). UI `/matches` ganha aba "Reid borderline".

**Tech Stack:**
- Edge: Bun + Hono + Drizzle ORM + Postgres + pgvector (HNSW cosine)
- Sidecar: Python 3.11 + FastAPI + Pillow + InsightFace `buffalo_s`
- Web: Next.js 14 (App Router) + React Query + shadcn/ui + happy-dom (bun:test)
- Deploy: systemd units + `deploy.sh` no VPS (master branch); migrations via Drizzle no startup do edge

**Spec base:** `docs/superpowers/specs/2026-05-20-onda-7-failover-b-design.md` (commit `d132cb8`, approved 3-round review)

**Branch:** `onda-7-failover-b` (já existe; 3 commits do spec).

---

## File Structure

### Edge (`packages/edge/`)
**Create:**
- `src/persistence/schema/reid-match-attempts.ts` — Drizzle schema da nova tabela de borderline reid.
- `src/persistence/schema/person-merge-audit.ts` — Drizzle schema do audit trail de merges.
- `src/persistence/repositories/reid-match-attempts.repo.ts` — repo com `createAmbiguous`, `findPendingEnriched`, `resolve`.
- `src/api/reid/snapshot-store.ts` — helpers `saveCrop(buf, date, detectionId) → relativePath` + `pruneOlderThan(days)`.
- `src/api/reid/match-policy.ts` — `decideMatch(embedding, model) → {kind: "strict"|"borderline"|"new", candidate?, distance?}`.
- `src/api/reid/orchestrator.ts` — orquestra `resolvePersonIdViaReid(event, sessionId)` com graceful degrade + session-inheritance fallback.
- `src/api/reid/health.ts` — `pingReid() → HealthCheck` pra integrar em `/api/health`.
- `src/api/routes/matches-reid.ts` — `GET /pending` + `POST /:id/resolve`.
- `src/scheduler/snapshot-retention.ts` — job de retention 30d (registrado no scheduler junto com erp-sync).
- `tests/unit/api/reid/snapshot-store.test.ts`
- `tests/unit/api/reid/match-policy.test.ts`
- `tests/unit/api/reid/orchestrator.test.ts`
- `tests/unit/api/routes/matches-reid.test.ts`
- `tests/unit/scheduler/snapshot-retention.test.ts`
- `tests/integration/persistence/face-records-repo.test.ts` — DB-deferred (`insertAndEvict`, `transferToPerson`).
- `tests/integration/persistence/persons-merge.test.ts` — DB-deferred (`mergeInto` transacional).
- `tests/integration/persistence/reid-match-attempts-repo.test.ts` — DB-deferred.

**Modify:**
- `src/persistence/schema/face-records.ts` — adicionar `model_name`, `model_revision`, `det_score`; embedding NOT NULL.
- `src/persistence/schema/index.ts` — exportar novos schemas.
- `src/persistence/repositories/face-records.repo.ts` — adicionar `insertAndEvict(personId, payload)`, `transferToPerson(srcId, dstId)`.
- `src/persistence/repositories/persons.repo.ts` — adicionar `mergeInto(srcId, dstId, userId)` transacional.
- `src/persistence/repositories/index.ts` — exportar repo novo.
- `src/discovery/image-probe/reid-client.ts` — adicionar `embed(reidBaseUrl, frameBytes, bbox, timeout)`.
- `src/ingest/pipeline.ts` — rewrite `resolvePersonId` (chamar orchestrator); adicionar capture+write do snapshot; gravar `face_attrs.reid_status` + `face_attrs.reid_distance`.
- `src/erp-sync/scheduler.ts` — registrar job `snapshot_retention` (diário 03:00 BRT).
- `src/api/server.ts` — adicionar `checks.reid` no `/api/health`; mudar route `/snapshots/:filename` → `/snapshots/:date/:filename`; montar `/api/matches/reid/*`.
- `src/api/routes/snapshots.ts` — atualizar regex anti-traversal (date segment).
- `src/config/env.ts` — adicionar `REID_ENABLED`, `REID_DIST_STRICT`, `REID_DIST_LOOSE`.

**Migrations (`src/persistence/migrations/`):**
- `0005_*.sql` — face_records: ADD model_name/model_revision/det_score, embedding NOT NULL com guard.
- `0006_*.sql` — CREATE TABLE reid_match_attempts (+ índice partial `pending_idx`).
- `0007_*.sql` — CREATE TABLE person_merge_audit.

### Sidecar (`packages/reid/`)
**Create:**
- `tests/test_embed.py` — unit tests dos endpoints `/embed` + `/warmup` + `/health` (extensão) via FastAPI TestClient.

**Modify:**
- `src/main.py` — adicionar `POST /embed` (bbox crop em PIL) + `POST /warmup` (idempotente, dispara model load); bump version → `0.2.0`; expor `model_name`/`model_revision` em `/health` e `/embed`.

### Infra (`infra/`)
**Modify:**
- `systemd/vipcam-reid.service.example` — adicionar `ExecStartPost` apontando pra `POST /warmup` com `--fail` (validação real do pre-warm).

### Shared (`packages/shared/`)
**Create:**
- `src/types/reid.ts` — `EmbedResult`, `ReidStatus`, `ReidMatchAttemptEnriched`.

**Modify:**
- `src/index.ts` (ou equivalente) — export dos types novos.

### Web (`packages/web/`)
**Create:**
- `src/lib/queries/reid-matches.ts` — `useReidPending(limit?)`, `useResolveReid()`.
- `src/components/reid-match-card.tsx` — card side-by-side (snapshot detection vs candidate face_record).
- `tests/unit/lib/queries-reid-matches.test.tsx`
- `tests/unit/components/reid-match-card.test.tsx`

**Modify:**
- `src/app/matches/page.tsx` — adicionar tabs (Temporal / Reid borderline); container compartilhado.

---


## Chunk 1: Schema migrations + Sidecar contract

Fundação. Tudo nas chunks seguintes depende de: (a) schema novo migrado e (b) sidecar respondendo `/embed`. Sem isso, nem o cliente edge nem o pipeline conseguem evoluir com testes verdes.

**Tasks neste chunk:** 1-6
**Sequenciamento:** Tasks 1-3 (schemas + migrations) podem rodar em qualquer ordem, mas commits separados. Tasks 4-5 (sidecar Python) ortogonais ao 1-3. Task 6 (cliente TS) depende de 4 estar pronto.

---

### Task 1: Schema — face_records colunas novas + migration com guard

**Spec ref:** §4.1 (deltas + guard `DO $$ ... RAISE EXCEPTION` antes do `ALTER ... SET NOT NULL`).

**Files:**
- Modify: `packages/edge/src/persistence/schema/face-records.ts`
- Generated: `packages/edge/src/persistence/migrations/0005_*.sql` (drizzle-kit gera; nós editamos pra adicionar o guard)
- Test: `packages/edge/tests/unit/persistence/schema-face-records.test.ts`

- [ ] **Step 1: Write the failing test (TS-side schema invariants)**

Cria `packages/edge/tests/unit/persistence/schema-face-records.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { faceRecords } from "../../../src/persistence/schema/face-records.js";

describe("face_records schema (Onda 7)", () => {
  test("has new columns model_name, model_revision, det_score", () => {
    type Cols = keyof typeof faceRecords;
    const required: Cols[] = ["model_name", "model_revision", "det_score"] as Cols[];
    for (const col of required) {
      expect(faceRecords[col]).toBeDefined();
    }
  });

  test("embedding is NOT NULL", () => {
    expect((faceRecords.embedding as unknown as { notNull?: boolean }).notNull).toBe(true);
  });

  test("model_name has default 'buffalo_s'", () => {
    expect((faceRecords.model_name as unknown as { default?: string }).default).toBe("buffalo_s");
  });

  test("model_revision has default 'insightface-0.7.3'", () => {
    expect((faceRecords.model_revision as unknown as { default?: string }).default).toBe(
      "insightface-0.7.3",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

`bun --filter '@vipcam/edge' test tests/unit/persistence/schema-face-records.test.ts`
Expected: 4 fails (columns undefined).

- [ ] **Step 3: Update schema TS**

Em `packages/edge/src/persistence/schema/face-records.ts`, modificar o `pgTable` para:
```typescript
embedding: vector512("embedding").notNull(),
snapshot_path: text("snapshot_path").notNull(),
is_primary: boolean("is_primary").notNull().default(false),
// Onda 7: rastreamento de modelo pra permitir troca sem invalidar face_records
// existentes silenciosamente. Queries de match filtram por (model_name,
// model_revision) atuais — embeddings de outros modelos viram órfãos.
model_name: text("model_name").notNull().default("buffalo_s"),
model_revision: text("model_revision").notNull().default("insightface-0.7.3"),
// Qualidade do crop usado pra gerar este embedding (debug + filtro futuro).
det_score: real("det_score"),
created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
```
Imports: adicionar `real` no `import { ... } from "drizzle-orm/pg-core"`.

- [ ] **Step 4: Run test (pass)**

`bun --filter '@vipcam/edge' test tests/unit/persistence/schema-face-records.test.ts` → 4 PASS.

- [ ] **Step 5: Generate migration**

`bun --filter '@vipcam/edge' run db:generate`
Gera `packages/edge/src/persistence/migrations/0005_<random>.sql`.

- [ ] **Step 6: Editar a migration pra adicionar o guard antes do SET NOT NULL**

Abrir o `0005_*.sql` gerado. Encontrar:
```sql
ALTER TABLE "face_records" ALTER COLUMN "embedding" SET NOT NULL;
```
Prefixar com um cabeçalho `-- HAND-EDITED (Onda 7)` + bloco DO $$ (mantenha o `--> statement-breakpoint` separator do Drizzle):
```sql
-- HAND-EDITED (Onda 7): este arquivo foi editado MANUALMENTE após `db:generate`
-- pra inserir o guard abaixo. **NÃO re-rodar `db:generate` antes de commitar
-- este arquivo** — drizzle-kit detecta mudança no schema TS e regera, perdendo
-- o guard. Próximas migrations (Tasks 2/3) re-rodam db:generate, mas como
-- elas tocam OUTRAS tabelas, este 0005 fica intocado pelo regen.
DO $$
BEGIN
  IF (SELECT count(*) FROM face_records WHERE embedding IS NULL) > 0 THEN
    RAISE EXCEPTION 'face_records tem rows com embedding NULL — abortando migration. Investigar antes.';
  END IF;
END$$;
--> statement-breakpoint
ALTER TABLE "face_records" ALTER COLUMN "embedding" SET NOT NULL;
```

> **Importante:** se você precisar re-rodar `db:generate` por qualquer motivo antes de commit deste arquivo, **re-aplique o guard manualmente** ou faça backup do arquivo antes. O guard NÃO sobrevive sozinho — drizzle-kit não tem mecanismo pra preservar SQL custom em migrations regeradas. Este pattern (hand-edit migration) é raro no projeto; documentado aqui pra Onda 7.

- [ ] **Step 7: Apply migration locally (DB-deferred OK se não houver Postgres local)**

`bun --filter '@vipcam/edge' run db:migrate`. Verificar via `psql $DATABASE_URL -c "\d face_records"` (3 colunas novas + embedding NOT NULL).

- [ ] **Step 8: Commit**

```bash
git add packages/edge/src/persistence/schema/face-records.ts \
        packages/edge/src/persistence/migrations/0005_*.sql \
        packages/edge/src/persistence/migrations/meta/0005_snapshot.json \
        packages/edge/src/persistence/migrations/meta/_journal.json \
        packages/edge/tests/unit/persistence/schema-face-records.test.ts
git commit -m "feat(edge): Onda 7 — face_records ganha model_name/revision/det_score + embedding NOT NULL"
```

---

### Task 2: Schema — reid_match_attempts (nova tabela)

**Spec ref:** §4.1 (schema completo + índice partial `pending_idx`).

**Files:**
- Create: `packages/edge/src/persistence/schema/reid-match-attempts.ts`
- Modify: `packages/edge/src/persistence/schema/index.ts`
- Generated: `packages/edge/src/persistence/migrations/0006_*.sql`
- Test: `packages/edge/tests/unit/persistence/schema-reid-match-attempts.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/edge/tests/unit/persistence/schema-reid-match-attempts.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { reidMatchAttempts } from "../../../src/persistence/schema/reid-match-attempts.js";

describe("reid_match_attempts schema (Onda 7)", () => {
  test("has required FKs and decision enum", () => {
    type Cols = keyof typeof reidMatchAttempts;
    const required: Cols[] = [
      "id",
      "detection_id",
      "candidate_face_record_id",
      "candidate_person_id",
      "distance",
      "decision",
      "decided_by",
      "decided_at",
      "notes",
    ] as Cols[];
    for (const col of required) expect(reidMatchAttempts[col]).toBeDefined();
  });

  test("decision is NOT NULL (state machine integrity)", () => {
    expect(
      (reidMatchAttempts.decision as unknown as { notNull?: boolean }).notNull,
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run test (fail — module não existe)**

`bun --filter '@vipcam/edge' test tests/unit/persistence/schema-reid-match-attempts.test.ts`

- [ ] **Step 3: Create schema file**

`packages/edge/src/persistence/schema/reid-match-attempts.ts`:
```typescript
import { sql } from "drizzle-orm";
import { index, pgEnum, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { detections } from "./detections.js";
import { faceRecords } from "./face-records.js";
import { persons } from "./persons.js";

export const reidDecision = pgEnum("reid_decision", [
  "ambiguous",
  "matched_to_candidate",
  "rejected_new_person",
]);
export const reidDecidedBy = pgEnum("reid_decided_by", ["system", "user"]);

/**
 * Borderline reid matches (distance entre REID_DIST_STRICT e REID_DIST_LOOSE)
 * — humano decide via /matches UI se a detection é o mesmo person do
 * candidato (merge) ou pessoa nova (reject).
 *
 * Separada de match_attempts (temporal/ERP) porque o dado é diferente:
 * temporal aponta pra checkin, aqui aponta pra face_record candidato.
 */
export const reidMatchAttempts = pgTable(
  "reid_match_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    detection_id: uuid("detection_id")
      .notNull()
      .references(() => detections.id, { onDelete: "cascade" }),
    candidate_face_record_id: uuid("candidate_face_record_id")
      .notNull()
      .references(() => faceRecords.id, { onDelete: "cascade" }),
    candidate_person_id: uuid("candidate_person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    distance: real("distance").notNull(),
    decision: reidDecision("decision").notNull().default("ambiguous"),
    decided_by: reidDecidedBy("decided_by").notNull().default("system"),
    decided_at: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    notes: text("notes"),
  },
  (t) => ({
    detection_idx: index("reid_match_attempts_detection_idx").on(t.detection_id),
    pending_idx: index("reid_match_attempts_pending_idx")
      .on(t.decided_at)
      .where(sql`${t.decision} = 'ambiguous'`),
  }),
);

export type ReidMatchAttempt = typeof reidMatchAttempts.$inferSelect;
export type NewReidMatchAttempt = typeof reidMatchAttempts.$inferInsert;
```

- [ ] **Step 4: Export do index.ts**

Em `packages/edge/src/persistence/schema/index.ts`, adicionar:
```typescript
export * from "./reid-match-attempts.js";
```

- [ ] **Step 5: Run test (pass)**

`bun --filter '@vipcam/edge' test tests/unit/persistence/schema-reid-match-attempts.test.ts` → 2 PASS.

- [ ] **Step 6: Generate + apply migration**

```
bun --filter '@vipcam/edge' run db:generate
bun --filter '@vipcam/edge' run db:migrate
```
Gera `0006_*.sql` com CREATE TYPE + CREATE TABLE + índices. Verificar via `psql -c "\d reid_match_attempts"`.

- [ ] **Step 7: Commit**

```bash
git add packages/edge/src/persistence/schema/reid-match-attempts.ts \
        packages/edge/src/persistence/schema/index.ts \
        packages/edge/src/persistence/migrations/0006_*.sql \
        packages/edge/src/persistence/migrations/meta/0006_snapshot.json \
        packages/edge/src/persistence/migrations/meta/_journal.json \
        packages/edge/tests/unit/persistence/schema-reid-match-attempts.test.ts
git commit -m "feat(edge): Onda 7 — reid_match_attempts table + pending_idx parcial"
```

---

### Task 3: Schema — person_merge_audit (audit trail do mergeInto)

**Spec ref:** §5.2 step 5 ("Audit ANTES do DELETE").

**Files:**
- Create: `packages/edge/src/persistence/schema/person-merge-audit.ts`
- Modify: `packages/edge/src/persistence/schema/index.ts`
- Generated: `packages/edge/src/persistence/migrations/0007_*.sql`
- Test: `packages/edge/tests/unit/persistence/schema-person-merge-audit.test.ts`

- [ ] **Step 1: Failing test**

`packages/edge/tests/unit/persistence/schema-person-merge-audit.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { personMergeAudit } from "../../../src/persistence/schema/person-merge-audit.js";

describe("person_merge_audit schema (Onda 7)", () => {
  test("has required columns", () => {
    type Cols = keyof typeof personMergeAudit;
    const required: Cols[] = [
      "id",
      "src_id",
      "dst_id",
      "merged_at",
      "merged_by",
      "src_snapshot",
    ] as Cols[];
    for (const col of required) expect(personMergeAudit[col]).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test (fail)**

`bun --filter '@vipcam/edge' test tests/unit/persistence/schema-person-merge-audit.test.ts`

- [ ] **Step 3: Create schema file**

`packages/edge/src/persistence/schema/person-merge-audit.ts`:
```typescript
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Audit trail de merges executados em personsRepo.mergeInto.
 *
 * src_id e dst_id NÃO têm FK pra persons porque src some imediatamente após
 * o INSERT deste row. Mantemos os UUIDs como referência histórica;
 * src_snapshot tem o estado completo de src antes do delete (rehidratação
 * manual via SQL se necessário). dst_id também sem FK pra simetria — se um
 * merge subsequente eliminar Y, o audit anterior permanece legível.
 */
export const personMergeAudit = pgTable("person_merge_audit", {
  id: uuid("id").primaryKey().defaultRandom(),
  src_id: uuid("src_id").notNull(),
  dst_id: uuid("dst_id").notNull(),
  merged_at: timestamp("merged_at", { withTimezone: true }).notNull().defaultNow(),
  // UUID do operador (NextAuth) OU "system" enquanto auth real não chega.
  merged_by: text("merged_by").notNull(),
  src_snapshot: jsonb("src_snapshot").$type<Record<string, unknown>>().notNull(),
});

export type PersonMergeAuditRow = typeof personMergeAudit.$inferSelect;
export type NewPersonMergeAuditRow = typeof personMergeAudit.$inferInsert;
```

- [ ] **Step 4: Export do index.ts**

Adicionar `export * from "./person-merge-audit.js";` em `packages/edge/src/persistence/schema/index.ts`.

- [ ] **Step 5: Run test (pass)**

`bun --filter '@vipcam/edge' test tests/unit/persistence/schema-person-merge-audit.test.ts`

- [ ] **Step 6: Generate + apply migration**

```
bun --filter '@vipcam/edge' run db:generate
bun --filter '@vipcam/edge' run db:migrate
```

- [ ] **Step 7: Commit**

```bash
git add packages/edge/src/persistence/schema/person-merge-audit.ts \
        packages/edge/src/persistence/schema/index.ts \
        packages/edge/src/persistence/migrations/0007_*.sql \
        packages/edge/src/persistence/migrations/meta/0007_snapshot.json \
        packages/edge/src/persistence/migrations/meta/_journal.json \
        packages/edge/tests/unit/persistence/schema-person-merge-audit.test.ts
git commit -m "feat(edge): Onda 7 — person_merge_audit (rastro do mergeInto)"
```

---

### Task 4: Sidecar — POST /embed + POST /warmup + model metadata em /health

**Spec ref:** §3.1 (`/embed` multipart + bbox form fields, response com `model_name`/`model_revision`); §3.3 (`/warmup` endpoint dedicado pra pre-warm).

**Files:**
- Modify: `packages/reid/src/main.py`
- Test: `packages/reid/tests/test_embed.py` (criar)

- [ ] **Step 1: Failing test (todos os testes do endpoint /embed + /warmup + /health)**

`packages/reid/tests/test_embed.py`:
```python
import io
import os

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from src.main import app

client = TestClient(app)
FIX = os.path.join(os.path.dirname(__file__), "fixtures")
FACE = os.path.join(FIX, "face.jpg")


def _dummy_jpeg(w: int = 200, h: int = 200) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color=(128, 128, 128)).save(buf, format="JPEG")
    return buf.getvalue()


def test_embed_400_when_bbox_outside_frame():
    body = _dummy_jpeg(100, 100)
    r = client.post(
        "/embed",
        files={"file": ("dummy.jpg", body, "image/jpeg")},
        data={"x": "200", "y": "200", "w": "50", "h": "50"},
    )
    assert r.status_code == 400
    assert "bbox" in r.json()["detail"].lower()


def test_embed_400_when_bbox_negative():
    body = _dummy_jpeg(100, 100)
    r = client.post(
        "/embed",
        files={"file": ("dummy.jpg", body, "image/jpeg")},
        data={"x": "-5", "y": "0", "w": "50", "h": "50"},
    )
    assert r.status_code == 400


def test_health_includes_model_metadata():
    r = client.get("/health")
    body = r.json()
    assert body["model_name"] == "buffalo_s"
    assert body["model_revision"].startswith("insightface-")


def test_warmup_returns_200_with_took_ms():
    """`/warmup` é idempotente. Primeira chamada dispara model.prepare(),
    subsequentes são no-op. Sempre retorna 200 com `warmed=True`."""
    r = client.post("/warmup")
    assert r.status_code == 200
    body = r.json()
    assert body["warmed"] is True
    assert body["took_ms"] >= 0


@pytest.mark.skipif(
    not os.path.exists(FACE),
    reason="face.jpg fixture not provisioned (VPS step)",
)
def test_embed_returns_512d_vector_for_face_crop():
    with open(FACE, "rb") as f:
        raw = f.read()
    img = Image.open(io.BytesIO(raw))
    w, h = img.size
    x, y = w // 4, h // 4
    bw, bh = w // 2, h // 2
    r = client.post(
        "/embed",
        files={"file": ("face.jpg", raw, "image/jpeg")},
        data={"x": str(x), "y": str(y), "w": str(bw), "h": str(bh)},
    )
    assert r.status_code == 200
    body = r.json()
    assert len(body["embedding"]) == 512
    assert all(isinstance(v, (int, float)) for v in body["embedding"])
    assert body["model_name"] == "buffalo_s"
    assert body["model_revision"].startswith("insightface-")
    assert 0 <= body["det_score"] <= 1
    assert body["infer_ms"] >= 0
```

- [ ] **Step 2: Run tests (fail)**

```
cd packages/reid && pytest tests/test_embed.py -v
```
Expected: /embed 404 + /warmup 404 + /health missing model_name.

- [ ] **Step 3a: Extend imports**

Em `packages/reid/src/main.py`, **extender** o import existente do FastAPI (manter `File`, `UploadFile`; adicionar `Form`, `HTTPException`):
```python
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
```

- [ ] **Step 3b: Bump version + adicionar constants de modelo**

Logo após `app = FastAPI(...)`, substituir por:
```python
app = FastAPI(title="vipcam-reid", version="0.2.0")

# Onda 7: trocar quando atualizar pip insightface — pra invalidar embeddings
# antigos via WHERE clause no edge sem precisar re-migrar tabela.
MODEL_NAME = "buffalo_s"
MODEL_REVISION = "insightface-0.7.3"
```

- [ ] **Step 3c: Estender HealthResponse + handler**

Substituir o `class HealthResponse` e o handler `health`:
```python
class HealthResponse(BaseModel):
    status: str
    version: str
    model_name: str
    model_revision: str


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        status="healthy",
        version=app.version,
        model_name=MODEL_NAME,
        model_revision=MODEL_REVISION,
    )
```

- [ ] **Step 3d: Adicionar /warmup endpoint**

Após o handler `health`, adicionar:
```python
class WarmupResponse(BaseModel):
    warmed: bool
    took_ms: int


@app.post("/warmup", response_model=WarmupResponse)
async def warmup() -> WarmupResponse:
    """Força carga do modelo InsightFace (idempotente).

    Usado pelo systemd ExecStartPost pra eliminar cold-start runtime.
    Não recebe payload — sempre retorna 200 se _model() carrega com sucesso;
    500 se o load falhar (paths errados, modelo missing, etc.) — sinal pro
    systemd marcar unit como failed e disparar Restart=always.
    """
    t0 = time.monotonic()
    _ = _model()  # idempotente — se _MODEL já setado, no-op
    took_ms = int((time.monotonic() - t0) * 1000)
    return WarmupResponse(warmed=True, took_ms=took_ms)
```

- [ ] **Step 3e: Adicionar /embed endpoint**

Após o handler `warmup`, adicionar:
```python
class EmbedResponse(BaseModel):
    embedding: list[float]  # 512 floats (normed)
    det_score: float
    infer_ms: int
    model_name: str
    model_revision: str


@app.post("/embed", response_model=EmbedResponse)
async def embed(
    file: UploadFile = File(...),
    x: int = Form(...),
    y: int = Form(...),
    w: int = Form(...),
    h: int = Form(...),
) -> EmbedResponse:
    """Crop pela bbox + extrai embedding 512-d (InsightFace recognition).

    Edge envia frame inteiro + bbox do evento Dahua. Sidecar valida bbox,
    cropa em PIL e roda model.get() sobre o crop (detection+recognition em
    cima do rosto já isolado — mais rápido e preciso que rodar no frame
    inteiro 2688x1520).
    """
    if x < 0 or y < 0 or w <= 0 or h <= 0:
        raise HTTPException(status_code=400, detail="bbox: x/y must be >= 0, w/h must be > 0")
    raw = await file.read()
    try:
        img = Image.open(io.BytesIO(raw)).convert("RGB")
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"undecodable image: {exc}") from exc
    fw, fh = img.size
    if x + w > fw or y + h > fh:
        raise HTTPException(
            status_code=400,
            detail=f"bbox ({x},{y},{w},{h}) fora do frame ({fw}x{fh})",
        )
    crop = img.crop((x, y, x + w, y + h))
    arr = np.ascontiguousarray(np.asarray(crop)[:, :, ::-1])  # RGB->BGR
    t0 = time.monotonic()
    faces = _model().get(arr)
    infer_ms = int((time.monotonic() - t0) * 1000)
    if not faces:
        raise HTTPException(
            status_code=422,
            detail="no face detected in crop — bbox may be misaligned or face too small",
        )
    best = max(faces, key=lambda f: f.det_score)
    return EmbedResponse(
        embedding=[float(v) for v in best.normed_embedding.tolist()],
        det_score=float(best.det_score),
        infer_ms=infer_ms,
        model_name=MODEL_NAME,
        model_revision=MODEL_REVISION,
    )
```

- [ ] **Step 4: Run tests (pass except face.jpg-skip)**

`cd packages/reid && pytest tests/test_embed.py -v`
Expected: 4 PASS + 1 SKIPPED (test_embed_returns_512d).

- [ ] **Step 5: Run /detect regression**

`cd packages/reid && pytest tests/ -v`
Expected: tests do /detect também passam (não quebramos nada).

- [ ] **Step 6: Commit**

```bash
git add packages/reid/src/main.py packages/reid/tests/test_embed.py
git commit -m "feat(reid): Onda 7 — POST /embed (crop pela bbox) + POST /warmup (pre-warm dedicado) + model metadata em /health"
```

---

### Task 5: Systemd — ExecStartPost via /warmup

**Spec ref:** §3.3 (versão atualizada — pre-warm via `/warmup` endpoint dedicado, não `/embed` com asset).

**Files:**
- Modify: `infra/systemd/vipcam-reid.service.example`

> **Mudança de design vs draft inicial do plano:** abandonamos a ideia de vendorizar um `warmup.jpg` porque `/embed` com imagem sem rosto responde 422 corretamente — `curl --fail` veria isso como falha e systemd marcaria unit como failed. Solução: endpoint `/warmup` dedicado no sidecar (implementado em Task 4, Step 3d) que dispara `_model().prepare()` e retorna 200. ExecStartPost usa `--fail` contra esse endpoint — falha real (modelo não carrega) detectada, sucesso real (modelo warm) confirmado. Zero asset binário em git.

- [ ] **Step 1: Verificação manual local (smoke)**

Pré-req: Task 4 commitada (sidecar tem `/warmup`).
```bash
cd packages/reid
uv run uvicorn src.main:app --port 5005 &
SIDECAR_PID=$!
sleep 1  # connect refused window
curl -sf --retry 30 --retry-delay 1 --retry-connrefused \
  -X POST http://127.0.0.1:5005/warmup
echo "exit=$?"
kill $SIDECAR_PID
```
Expected: `{"warmed":true,"took_ms":N}` onde N pode ser ~5500 (primeira vez) ou ~1 (subsequente). `exit=0` (curl --fail HTTP 200).

- [ ] **Step 2: Atualizar systemd unit**

Em `infra/systemd/vipcam-reid.service.example`, dentro do `[Service]`, adicionar APÓS `ExecStart=...`:
```ini
# Onda 7 §3.3: pre-warm via /warmup (endpoint dedicado idempotente).
# Sem isso, primeira /embed em runtime sofre ~5,5s de cold-start. Usamos
# --fail aqui — se /warmup retornar 500 (modelo falha em carregar), o
# systemd marca o unit como failed e Restart=always tenta de novo.
# --retry 30 + --retry-connrefused absorve a janela de boot do uvicorn.
ExecStartPost=/usr/bin/curl --fail --silent --output /dev/null \
    --retry 30 --retry-delay 1 --retry-connrefused \
    -X POST http://127.0.0.1:5005/warmup
```

> **Não adicionar `ReadOnlyPaths`** — `/warmup` é POST sem payload, não precisa de filesystem access além do que o ExecStart já tem. (Draft anterior adicionava `ReadOnlyPaths=/opt/vipcamv2/packages/reid/assets` — no-op redundante com `ProtectSystem=strict` que já está no unit, e sem asset pra proteger agora.)

- [ ] **Step 3: Commit**

```bash
git add infra/systemd/vipcam-reid.service.example
git commit -m "feat(reid): Onda 7 — ExecStartPost via POST /warmup (--fail + retry-connrefused)"
```

---

### Task 6: Edge cliente — embed() em reid-client.ts + EmbedResult/BBox/ReidStatus shared

**Spec ref:** §3.2 (`embed(reidBaseUrl, frameBytes, bbox, timeout=3000)`).

**Files:**
- Create: `packages/shared/src/types/reid.ts`
- Modify: `packages/shared/src/index.ts` (export reid types)
- Modify: `packages/edge/src/discovery/image-probe/reid-client.ts`
- Test: `packages/edge/tests/unit/discovery/reid-client-embed.test.ts`

- [ ] **Step 1: Create shared types**

`packages/shared/src/types/reid.ts`:
```typescript
/** Saída de POST /embed do sidecar vipcam-reid (Onda 7 §3.1). */
export interface EmbedResult {
  /** Vetor 512-d normalizado (cosine-friendly). */
  embedding: number[];
  /** Confiança da detecção pós-crop (0..1). */
  det_score: number;
  infer_ms: number;
  model_name: string;
  model_revision: string;
}

/**
 * Bbox sub-conjunto do frame (retangular). Valores são em pixels do frame de
 * origem. O sidecar Python espera **inteiros** (FastAPI `Form(...)` com type
 * `int` rejeita floats), então o caller no edge deve aplicar `Math.floor()`
 * em cada componente antes de chamar `embed()` — bbox do evento Dahua já vem
 * inteiro, mas qualquer transformação intermediária deve preservar isso.
 */
export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Status do pipeline reid populado em detections.face_attrs.reid_status. */
export type ReidStatus =
  | "matched_strict"     // auto-link a person existente
  | "borderline"         // pediu revisão humana
  | "new_person"         // criou anonymous nova
  | "unavailable"        // sidecar down — graceful degrade
  | "inherited_session"  // herdou person_id de detection prévia da mesma sessão
  | "disabled";          // REID_ENABLED=false
```

- [ ] **Step 2: Export do shared/src/index.ts**

Adicionar em `packages/shared/src/index.ts`:
```typescript
export * from "./types/reid.js";
```

- [ ] **Step 3: Write the failing test**

`packages/edge/tests/unit/discovery/reid-client-embed.test.ts`:
```typescript
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { EmbedResult } from "@vipcam/shared";
import { ReidError, embed } from "../../../src/discovery/image-probe/reid-client.js";

const ORIG_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
});

describe("reid-client.embed", () => {
  test("POSTs multipart com file + bbox form fields, parses JSON em EmbedResult", async () => {
    const fakeResult: EmbedResult = {
      embedding: Array(512).fill(0.01),
      det_score: 0.95,
      infer_ms: 28,
      model_name: "buffalo_s",
      model_revision: "insightface-0.7.3",
    };
    let receivedUrl = "";
    let receivedBody: FormData | null = null;
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      receivedUrl = url.toString();
      receivedBody = init?.body as FormData;
      return new Response(JSON.stringify(fakeResult), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const result = await embed(
      "http://127.0.0.1:5005",
      Buffer.from("fake-frame-bytes"),
      { x: 10, y: 20, w: 100, h: 100 },
    );

    expect(result).toEqual(fakeResult);
    expect(receivedUrl).toBe("http://127.0.0.1:5005/embed");
    expect(receivedBody).toBeInstanceOf(FormData);
    const fd = receivedBody as unknown as FormData;
    expect(fd.get("x")).toBe("10");
    expect(fd.get("y")).toBe("20");
    expect(fd.get("w")).toBe("100");
    expect(fd.get("h")).toBe("100");
    expect(fd.get("file")).toBeInstanceOf(Blob);
  });

  test("throws ReidError on HTTP non-2xx", async () => {
    globalThis.fetch = mock(
      async () => new Response('{"detail":"bad bbox"}', { status: 400 }),
    ) as typeof globalThis.fetch;
    await expect(
      embed("http://127.0.0.1:5005", Buffer.from("x"), { x: 0, y: 0, w: 1, h: 1 }),
    ).rejects.toThrow(ReidError);
  });

  test("throws ReidError on fetch failure (network/timeout)", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof globalThis.fetch;
    await expect(
      embed("http://127.0.0.1:5005", Buffer.from("x"), { x: 0, y: 0, w: 1, h: 1 }),
    ).rejects.toThrow(ReidError);
  });

  test("attaches AbortSignal.timeout() by default", async () => {
    let receivedSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_url, init?: RequestInit) => {
      receivedSignal = init?.signal ?? undefined;
      return new Response(
        JSON.stringify({
          embedding: [],
          det_score: 0,
          infer_ms: 0,
          model_name: "x",
          model_revision: "y",
        }),
        { status: 200 },
      );
    }) as typeof globalThis.fetch;
    await embed("http://x", Buffer.from(""), { x: 0, y: 0, w: 1, h: 1 });
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });
});
```

- [ ] **Step 4: Run test (fail — embed não existe)**

`bun --filter '@vipcam/edge' test tests/unit/discovery/reid-client-embed.test.ts`

- [ ] **Step 5: Implement embed()**

Append a `packages/edge/src/discovery/image-probe/reid-client.ts`:
```typescript
import type { BBox, EmbedResult } from "@vipcam/shared";

/**
 * POST /embed: envia frame inteiro + bbox em multipart.
 * Sidecar cropa em PIL e retorna embedding 512-d (Onda 7 §3.1).
 *
 * Timeout default 3s assumindo sidecar warm (pre-warm via ExecStartPost).
 * Cold start (~5,5s) só ocorre se reid restartou e o warmup falhou — nesse
 * caso pipeline cai em graceful degrade (Onda 7 §3.5).
 */
export async function embed(
  reidBaseUrl: string,
  frameBytes: Buffer,
  bbox: BBox,
  timeoutMs = 3_000,
): Promise<EmbedResult> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(frameBytes)], { type: "image/jpeg" }),
    "frame.jpg",
  );
  form.append("x", String(bbox.x));
  form.append("y", String(bbox.y));
  form.append("w", String(bbox.w));
  form.append("h", String(bbox.h));
  let r: Response;
  try {
    r = await fetch(`${reidBaseUrl}/embed`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ReidError(`reid /embed request failed: ${(err as Error).message}`);
  }
  if (!r.ok) throw new ReidError(`reid /embed HTTP ${r.status}`);
  return (await r.json()) as EmbedResult;
}
```

- [ ] **Step 6: Run test (pass)**

`bun --filter '@vipcam/edge' test tests/unit/discovery/reid-client-embed.test.ts` → 4 PASS.

- [ ] **Step 7: Offline gates verde**

```
bun --filter '@vipcam/shared' typecheck
bun --filter '@vipcam/edge' typecheck
bun --filter '@vipcam/edge' test
bun run lint
```
Expected: tudo verde, 161+4 testes edge passando.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/types/reid.ts \
        packages/shared/src/index.ts \
        packages/edge/src/discovery/image-probe/reid-client.ts \
        packages/edge/tests/unit/discovery/reid-client-embed.test.ts
git commit -m "feat(edge): Onda 7 — reid-client.embed() + EmbedResult/BBox/ReidStatus shared types"
```

---

