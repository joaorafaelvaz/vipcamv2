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

## Chunk 2: Snapshot persistence + retention

Resolve o problema do `/live` blank em produção (independente do reid em si — funciona mesmo com `REID_ENABLED=false`). Adiciona helpers de write/prune de snapshots em disco, atualiza route `/snapshots/:date/:filename`, registra job de retention no scheduler. Também declara as ENV vars do Failover B no `env.ts` (consumidas em Chunks 3+).

**Tasks neste chunk:** 7-10
**Sequenciamento:** Task 7 (env vars) primeiro; outras podem ser paralelas mas commits separados. Task 10 depende de Task 8 (`pruneOlderThan`).

---

### Task 7: ENV vars — REID_ENABLED / REID_DIST_STRICT / REID_DIST_LOOSE / SNAPSHOTS_DIR

**Spec ref:** §4.3 (thresholds via ENV pra tuning empírico); §5.5 (`REID_ENABLED`); §8 (deploy steps menciona vars novos).

**Files:**
- Modify: `packages/edge/src/config/env.ts`
- Test: `packages/edge/tests/unit/config/env-reid.test.ts`

- [ ] **Step 1: Failing test**

`packages/edge/tests/unit/config/env-reid.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { parseEnv } from "../../../src/config/env.js";

const BASE = {
  API_KEY: "test-key",
};

describe("env Onda 7 vars", () => {
  test("REID_ENABLED defaults to true", () => {
    expect(parseEnv(BASE).REID_ENABLED).toBe(true);
  });

  test("REID_ENABLED accepts 'false'", () => {
    expect(parseEnv({ ...BASE, REID_ENABLED: "false" }).REID_ENABLED).toBe(false);
  });

  test("REID_ENABLED accepts 'true'", () => {
    expect(parseEnv({ ...BASE, REID_ENABLED: "true" }).REID_ENABLED).toBe(true);
  });

  test("REID_DIST_STRICT defaults to 0.35", () => {
    expect(parseEnv(BASE).REID_DIST_STRICT).toBe(0.35);
  });

  test("REID_DIST_LOOSE defaults to 0.55", () => {
    expect(parseEnv(BASE).REID_DIST_LOOSE).toBe(0.55);
  });

  test("REID_DIST_STRICT rejects > REID_DIST_LOOSE (refine)", () => {
    expect(() =>
      parseEnv({ ...BASE, REID_DIST_STRICT: "0.6", REID_DIST_LOOSE: "0.5" }),
    ).toThrow(/REID_DIST_STRICT.*REID_DIST_LOOSE/);
  });

  test("REID_BASE_URL defaults to http://127.0.0.1:5005", () => {
    expect(parseEnv(BASE).REID_BASE_URL).toBe("http://127.0.0.1:5005");
  });

  test("SNAPSHOTS_DIR defaults to /var/lib/vipcam/snapshots", () => {
    expect(parseEnv(BASE).SNAPSHOTS_DIR).toBe("/var/lib/vipcam/snapshots");
  });
});
```

- [ ] **Step 2: Run test (fail)**

`bun --filter '@vipcam/edge' test tests/unit/config/env-reid.test.ts`
Expected: `REID_ENABLED` undefined etc.

- [ ] **Step 3: Add vars to envSchema**

Em `packages/edge/src/config/env.ts`, dentro do `z.object({ ... })`:
```typescript
    // Onda 7 — Failover B
    REID_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    REID_BASE_URL: z.string().url().default("http://127.0.0.1:5005"),
    // Thresholds via ENV pra calibração empírica sem rebuild — ver spec §4.3.
    REID_DIST_STRICT: z.coerce.number().min(0).max(2).default(0.35),
    REID_DIST_LOOSE: z.coerce.number().min(0).max(2).default(0.55),
    SNAPSHOTS_DIR: z.string().min(1).default("/var/lib/vipcam/snapshots"),
```

E atualizar o `.refine(...)` final (substituir por um `.superRefine` ou encadear outro `.refine`):
```typescript
  .refine(
    (v) =>
      (v.CAMERA_IP && v.CAMERA_USER && v.CAMERA_PASS) ||
      (!v.CAMERA_IP && !v.CAMERA_USER && !v.CAMERA_PASS),
    { message: "CAMERA_IP/USER/PASS must be all set or all unset" },
  )
  .refine((v) => v.REID_DIST_STRICT < v.REID_DIST_LOOSE, {
    message: "REID_DIST_STRICT must be < REID_DIST_LOOSE (strict < borderline boundary)",
  });
```

- [ ] **Step 4: Run test (pass)**

`bun --filter '@vipcam/edge' test tests/unit/config/env-reid.test.ts` → 8 PASS.

- [ ] **Step 5: Verificar resto dos testes de env não quebraram**

`bun --filter '@vipcam/edge' test tests/unit/config/`
Expected: tests pré-existentes (se houver) ainda passam.

- [ ] **Step 6: Commit**

```bash
git add packages/edge/src/config/env.ts \
        packages/edge/tests/unit/config/env-reid.test.ts
git commit -m "feat(edge): Onda 7 — ENV vars REID_ENABLED/DIST_STRICT/DIST_LOOSE/BASE_URL/SNAPSHOTS_DIR"
```

---

### Task 8: Snapshot-store — saveCrop + pruneOlderThan

**Spec ref:** §2.2 (layout `snapshots/YYYY-MM-DD/<detection-uuid>.jpg`), §2.3 (path relativo), §2.4 (retention via `find -mtime`).

**Files:**
- Create: `packages/edge/src/api/reid/snapshot-store.ts`
- Test: `packages/edge/tests/unit/api/reid/snapshot-store.test.ts`

- [ ] **Step 1: Failing test**

`packages/edge/tests/unit/api/reid/snapshot-store.test.ts`:
```typescript
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pruneOlderThan, saveCrop } from "../../../../src/api/reid/snapshot-store.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "snap-store-test-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("saveCrop", () => {
  test("writes file to YYYY-MM-DD/<id>.jpg and returns relative path", async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic prefix
    const relPath = await saveCrop({
      baseDir: tmpDir,
      detectionId: "abc-123",
      detectedAt: new Date("2026-05-20T14:30:00Z"),
      jpegBytes: buf,
    });
    expect(relPath).toBe("2026-05-20/abc-123.jpg");
    const written = await fs.readFile(path.join(tmpDir, relPath));
    expect(Buffer.compare(written, buf)).toBe(0);
  });

  test("creates date directory on demand (mkdir -p)", async () => {
    await saveCrop({
      baseDir: tmpDir,
      detectionId: "x",
      detectedAt: new Date("2026-06-01T00:00:00Z"),
      jpegBytes: Buffer.from([0]),
    });
    const stat = await fs.stat(path.join(tmpDir, "2026-06-01"));
    expect(stat.isDirectory()).toBe(true);
  });

  test("uses UTC for date segment (not local TZ)", async () => {
    // 2026-05-20T01:00:00-03:00 = 2026-05-20T04:00:00Z → UTC date = 2026-05-20
    // BUT: 2026-05-20T23:30:00-03:00 = 2026-05-21T02:30:00Z → UTC date = 2026-05-21
    const relPath = await saveCrop({
      baseDir: tmpDir,
      detectionId: "edge",
      detectedAt: new Date("2026-05-21T02:30:00Z"),
      jpegBytes: Buffer.from([0]),
    });
    expect(relPath.startsWith("2026-05-21/")).toBe(true);
  });
});

describe("pruneOlderThan", () => {
  test("deletes date-prefixed dirs older than N days", async () => {
    // Cria 3 pastas: 40d atrás (apagar), 20d (manter), hoje (manter)
    const today = new Date();
    const mkOldDir = async (daysAgo: number) => {
      const d = new Date(today.getTime() - daysAgo * 86400_000);
      const name = d.toISOString().slice(0, 10);
      const full = path.join(tmpDir, name);
      await fs.mkdir(full, { recursive: true });
      await fs.writeFile(path.join(full, "fake.jpg"), Buffer.from([0]));
      // Backdating: setattr mtime usando utimes
      await fs.utimes(full, d, d);
    };
    await mkOldDir(40);
    await mkOldDir(20);
    await mkOldDir(0);

    const deleted = await pruneOlderThan({ baseDir: tmpDir, days: 30 });
    expect(deleted).toBe(1);

    const remaining = await fs.readdir(tmpDir);
    expect(remaining.length).toBe(2);
  });

  test("ignores non-date dirs (defense-in-depth)", async () => {
    // mkdir 'tmp' (não-date format), backdated 60d
    const odd = path.join(tmpDir, "lost+found");
    await fs.mkdir(odd, { recursive: true });
    const past = new Date(Date.now() - 60 * 86400_000);
    await fs.utimes(odd, past, past);

    const deleted = await pruneOlderThan({ baseDir: tmpDir, days: 30 });
    expect(deleted).toBe(0); // não tocou em lost+found
    const remaining = await fs.readdir(tmpDir);
    expect(remaining).toContain("lost+found");
  });

  test("baseDir não existe → retorna 0 sem throw (graceful)", async () => {
    const deleted = await pruneOlderThan({
      baseDir: path.join(tmpDir, "doesnt-exist"),
      days: 30,
    });
    expect(deleted).toBe(0);
  });
});
```

- [ ] **Step 2: Run test (fail — module não existe)**

`bun --filter '@vipcam/edge' test tests/unit/api/reid/snapshot-store.test.ts`

- [ ] **Step 3: Implement snapshot-store**

`packages/edge/src/api/reid/snapshot-store.ts`:
```typescript
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Path relativo a SNAPSHOTS_DIR. Forma: 'YYYY-MM-DD/<detection-id>.jpg'. */
export type RelativeSnapshotPath = string;

export interface SaveCropParams {
  baseDir: string;
  detectionId: string;
  detectedAt: Date;
  jpegBytes: Buffer;
}

/** Regex que casa nomes de pasta no formato ISO date (UTC) — usado pelo prune
 * pra ignorar lixo (`lost+found`, manual debug dirs etc.). */
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Escreve crop JPEG em `<baseDir>/YYYY-MM-DD/<detection-id>.jpg`.
 * mkdir -p garante dir existe. Retorna o path relativo (formato armazenado
 * em `detections.snapshot_path` e usado na URL `/snapshots/:date/:filename`).
 *
 * Data deriva de `detectedAt` UTC — NÃO TZ local — pra evitar split-day em
 * boundary (eg 23:30 BRT em 20 vira 02:30 UTC em 21 → pasta 21, consistente
 * com `detected_at` armazenado no DB também UTC).
 */
export async function saveCrop(params: SaveCropParams): Promise<RelativeSnapshotPath> {
  const { baseDir, detectionId, detectedAt, jpegBytes } = params;
  const dateSeg = detectedAt.toISOString().slice(0, 10); // 'YYYY-MM-DD' (UTC)
  const dirFull = path.join(baseDir, dateSeg);
  await fs.mkdir(dirFull, { recursive: true });
  const fileFull = path.join(dirFull, `${detectionId}.jpg`);
  await fs.writeFile(fileFull, jpegBytes);
  return `${dateSeg}/${detectionId}.jpg`;
}

export interface PruneParams {
  baseDir: string;
  days: number;
}

/**
 * Retention: apaga pastas YYYY-MM-DD com mtime mais velho que `days`.
 *
 * Filtra por regex pra não tocar em dirs alheios (`lost+found`, snapshots de
 * outro release de design, etc.). Se baseDir não existe (cold start em VPS),
 * retorna 0 silently — scheduler-health pega via no-throw success.
 */
export async function pruneOlderThan(params: PruneParams): Promise<number> {
  const { baseDir, days } = params;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  const cutoff = Date.now() - days * 86400_000;
  let deleted = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!DATE_DIR_RE.test(e.name)) continue;
    const full = path.join(baseDir, e.name);
    const stat = await fs.stat(full);
    if (stat.mtimeMs < cutoff) {
      await fs.rm(full, { recursive: true, force: true });
      deleted += 1;
    }
  }
  return deleted;
}
```

- [ ] **Step 4: Run test (pass)**

`bun --filter '@vipcam/edge' test tests/unit/api/reid/snapshot-store.test.ts` → 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/edge/src/api/reid/snapshot-store.ts \
        packages/edge/tests/unit/api/reid/snapshot-store.test.ts
git commit -m "feat(edge): Onda 7 — snapshot-store (saveCrop UTC-date + pruneOlderThan)"
```

---

### Task 9: Route /snapshots/:date/:filename (multi-segment + anti-traversal)

**Spec ref:** §2.3 (rota muda, regex valida date + filename; route antigo flat pode ser removido porque pré-Onda-7 nenhum detection.snapshot_path foi populado).

**Files:**
- Modify: `packages/edge/src/api/routes/snapshots.ts`
- Modify: `packages/edge/src/api/server.ts` (atualizar caller pra passar `<date>/<filename>`)
- Test: `packages/edge/tests/unit/api/routes/snapshots-date.test.ts`

- [ ] **Step 1: Failing test**

`packages/edge/tests/unit/api/routes/snapshots-date.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { createSnapshotsRoutes } from "../../../../src/api/routes/snapshots.js";

function app(read: (rel: string) => Promise<Uint8Array | null>) {
  return createSnapshotsRoutes({ readSnapshot: read });
}

describe("snapshots route /:date/:filename (Onda 7)", () => {
  test("valid date + filename → 200 + image/jpeg", async () => {
    let received = "";
    const r = await app(async (rel) => {
      received = rel;
      return new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    }).request("/2026-05-20/abc-def-123.jpg");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(received).toBe("2026-05-20/abc-def-123.jpg");
  });

  test("404 when readSnapshot returns null", async () => {
    const r = await app(async () => null).request("/2026-05-20/missing.jpg");
    expect(r.status).toBe(404);
  });

  test("400 invalid date segment", async () => {
    const r = await app(async () => null).request("/not-a-date/x.jpg");
    expect(r.status).toBe(400);
  });

  test("400 invalid filename segment (non-UUID-ish)", async () => {
    const r = await app(async () => null).request("/2026-05-20/file..with..dots.jpg");
    expect(r.status).toBe(400);
  });

  test("400 path traversal attempt date segment", async () => {
    const r = await app(async () => null).request("/2026-05-20/..%2F..%2Fetc%2Fpasswd");
    // Hono decodifica → param vira '../../etc/passwd' → fail regex
    expect(r.status).toBe(400);
  });

  test("400 path traversal attempt date segment v2", async () => {
    const r = await app(async () => null).request("/..%2F..%2F2026-05-20/abc.jpg");
    expect(r.status).toBe(400);
  });

  test("legacy flat route /:filename returns 400 (sem date segment, intencionalmente removido)", async () => {
    const r = await app(async () => null).request("/old-flat.jpg");
    // Hono: nenhuma rota casa /:filename direto → 404 do Hono
    // Aceitamos 404 (rota inexistente) OU 400 (regex falhou) — qualquer um confirma que o legacy quebrou.
    expect([400, 404]).toContain(r.status);
  });
});
```

- [ ] **Step 2: Run test (fail — rota velha aceita /:filename)**

`bun --filter '@vipcam/edge' test tests/unit/api/routes/snapshots-date.test.ts`
Expected: testes da rota antiga passam acidentalmente (path `/2026-05-20/abc.jpg` é interpretado como filename = `2026-05-20/abc.jpg`, falha regex VALID_FILENAME). Maioria dos novos falha.

- [ ] **Step 3: Rewrite snapshots route**

Substituir `packages/edge/src/api/routes/snapshots.ts`:
```typescript
import { Hono } from "hono";

export interface SnapshotsDeps {
  /** Lê bytes do filesystem. `relativePath` é o valor armazenado em
   * detections.snapshot_path: 'YYYY-MM-DD/<detection-uuid>.jpg'. */
  readSnapshot: (relativePath: string) => Promise<Uint8Array | null>;
}

// Anti path traversal: dois segmentos validados separadamente.
const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_FILENAME = /^[a-zA-Z0-9-]+\.jpg$/;

/**
 * Endpoint público (sem auth — nginx restringe LAN) que serve snapshots
 * JPEG sob layout `snapshots/YYYY-MM-DD/<detection-uuid>.jpg`.
 *
 * Onda 7 §2.3: substitui rota flat `/snapshots/:filename` que existia desde
 * Onda 3. Pré-Onda-7 nenhuma detection tinha snapshot_path populado, então
 * remover a rota antiga não-quebra URLs reais.
 *
 * Validação anti-traversal: regex em CADA segmento. Hono decodifica %2F
 * em / antes de matchar params, então qualquer ../../etc/passwd cai aqui.
 */
export function createSnapshotsRoutes(deps: SnapshotsDeps): Hono {
  const r = new Hono();

  r.get("/:date/:filename", async (c) => {
    const date = c.req.param("date");
    const filename = c.req.param("filename");
    if (
      !VALID_DATE.test(date) ||
      !VALID_FILENAME.test(filename) ||
      filename.includes("..") ||
      date.includes("..")
    ) {
      return c.json({ error: "invalid_path" }, 400);
    }
    const relativePath = `${date}/${filename}`;
    const bytes = await deps.readSnapshot(relativePath);
    if (!bytes) return c.json({ error: "not_found" }, 404);
    // C1: bytes pode ser uma VIEW num buffer maior (fs.readFile retorna
    // Buffer do pool interno do Node pra files <8KB). Slice exato copia
    // só este arquivo (evita leak de memória adjacente num endpoint sem auth).
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return new Response(body, {
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

- [ ] **Step 4: Run test (pass)**

`bun --filter '@vipcam/edge' test tests/unit/api/routes/snapshots-date.test.ts` → 7 PASS.

- [ ] **Step 5: Atualizar server.ts pra passar relativePath ao readFile**

Em `packages/edge/src/api/server.ts`, encontrar o mount de `/snapshots` (próximo ao final do `createServer`) e atualizar o caller pra trabalhar com o relativePath completo:
```typescript
const SNAPSHOTS_DIR = env.SNAPSHOTS_DIR;  // antes era process.env.SNAPSHOTS_DIR ?? "..."
app.route(
  "/snapshots",
  createSnapshotsRoutes({
    readSnapshot: async (relativePath) => {
      const fullPath = path.join(SNAPSHOTS_DIR, relativePath);
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

> **Importante:** `path.join(SNAPSHOTS_DIR, relativePath)` é seguro pós-regex (`..` rejeitado upstream). Não usar `path.resolve` (que poderia normalizar `..` se entrasse).

- [ ] **Step 6: Run all edge tests (sanity)**

`bun --filter '@vipcam/edge' test`
Expected: tudo verde, sem regressão.

- [ ] **Step 7: Commit**

```bash
git add packages/edge/src/api/routes/snapshots.ts \
        packages/edge/src/api/server.ts \
        packages/edge/tests/unit/api/routes/snapshots-date.test.ts
git commit -m "feat(edge): Onda 7 — /snapshots/:date/:filename (multi-segment + remoção do route flat)"
```

---

### Task 10: Scheduler — snapshot_retention job (diário, 30d)

**Spec ref:** §2.4 (cron 03:00 BRT, `find -mtime +30`, integrado em `getJobHealth()`).

**Files:**
- Modify: `packages/edge/src/erp-sync/scheduler.ts` (adicionar 4º job)
- Test: `packages/edge/tests/unit/scheduler/snapshot-retention.test.ts` (testa lógica, não cron-fire)

- [ ] **Step 1: Failing test — verifica que startScheduler registra job de retention**

`packages/edge/tests/unit/scheduler/snapshot-retention.test.ts`:
```typescript
// NOTA (bun:test mock.module process-wide): este arquivo registra mocks
// de `node-cron` + 4 deps do scheduler. `mock.module` em bun:test é
// PROCESS-WIDE — outros arquivos do suite que mockam os mesmos paths
// (ex: futuro scheduler-health.test.ts) podem sobrescrever. Re-registramos
// no beforeEach (via installMocks) pra defender contra ordem de execução.
// Padrão herdado de packages/web/tests/unit/lib/queries-events.test.tsx
// (Onda 8 — documenta limitação conhecida).
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const captured: Array<{ cronExpr: string; cb: () => Promise<void> | void; tz?: string }> = [];
let prunedDays: number | undefined;
let prunedBaseDir: string | undefined;

const installMocks = () => {
  mock.module("node-cron", () => ({
    default: {
      schedule: (
        cronExpr: string,
        cb: () => Promise<void> | void,
        opts?: { timezone?: string },
      ) => {
        captured.push({ cronExpr, cb, tz: opts?.timezone });
        return { stop: () => {} };
      },
    },
  }));
  mock.module("../../../src/erp-sync/checkins.js", () => ({ pollCheckins: async () => {} }));
  mock.module("../../../src/erp-sync/clients.js", () => ({ syncClients: async () => {} }));
  mock.module("../../../src/erp-sync/employees.js", () => ({ syncEmployees: async () => {} }));
  mock.module("../../../src/match-temp/orchestrator.js", () => ({
    processAllPendingCheckins: async () => {},
  }));
  mock.module("../../../src/api/reid/snapshot-store.js", () => ({
    pruneOlderThan: async ({ baseDir, days }: { baseDir: string; days: number }) => {
      prunedBaseDir = baseDir;
      prunedDays = days;
      return 3;
    },
  }));
};
installMocks();

import { startScheduler } from "../../../src/erp-sync/scheduler.js";
import { _resetHealth, getJobHealth } from "../../../src/erp-sync/scheduler-health.js";

beforeEach(() => {
  captured.length = 0;
  prunedDays = undefined;
  prunedBaseDir = undefined;
  _resetHealth();
  installMocks();
});
afterEach(() => {
  delete process.env.SNAPSHOTS_DIR;
});

describe("snapshot_retention job (Onda 7)", () => {
  test("startScheduler registers snapshot_retention diário às 03:00 BRT", () => {
    const h = startScheduler();
    h.stop();
    const j = captured.find((c) => c.cronExpr === "0 3 * * *");
    expect(j).toBeDefined();
    // Crítico: timezone explícito p/ que "03:00" seja BRT, não UTC do VPS.
    expect(j!.tz).toBe("America/Sao_Paulo");
  });

  test("snapshot_retention job calls pruneOlderThan(30d) and marks success", async () => {
    process.env.SNAPSHOTS_DIR = "/tmp/test-snaps";
    const h = startScheduler();
    const j = captured.find((c) => c.cronExpr === "0 3 * * *");
    expect(j).toBeDefined();
    await j!.cb();
    h.stop();
    expect(prunedDays).toBe(30);
    expect(prunedBaseDir).toBe("/tmp/test-snaps");
    const health = getJobHealth();
    const snap = health.find((x) => x.name === "snapshot_retention");
    expect(snap?.healthy).toBe(true);
    expect(snap?.last_success_at).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Run test (fail — job snapshot_retention não registrado)**

`bun --filter '@vipcam/edge' test tests/unit/scheduler/snapshot-retention.test.ts`

- [ ] **Step 3: Adicionar job ao scheduler**

Em `packages/edge/src/erp-sync/scheduler.ts`:

(a) Adicionar import no topo:
```typescript
import { pruneOlderThan } from "../api/reid/snapshot-store.js";
import { getEnv } from "../config/env.js";
```

(b) Dentro de `startScheduler`, antes do `return { stop: ... }`, adicionar:
```typescript
  // 03:00 BRT — timezone explícito porque VPS systemd roda em UTC e nesse caso
  // "0 3 * * *" puro fire-aria às 00:00 BRT (3h cedo). Pattern espelha
  // METRICS_TZ pra consistência (Onda 7 §2.4 + plan-reviewer round 2).
  const snapJob = cron.schedule(
    "0 3 * * *",
    withRunningGuard("snapshot_retention", async () => {
      const env = getEnv();
      const deleted = await pruneOlderThan({ baseDir: env.SNAPSHOTS_DIR, days: 30 });
      logger.info({ deleted }, "snapshot retention job — pruned old date dirs");
    }),
    { timezone: "America/Sao_Paulo" },
  );
```

(c) E adicionar ao `stop()`:
```typescript
    stop() {
      empJob.stop();
      cliJob.stop();
      chkJob.stop();
      snapJob.stop();
      logger.info("ERP sync scheduler stopped");
    },
```

(d) Atualizar log inicial pra refletir o job novo:
```typescript
  logger.info(
    "scheduler started (employees=hourly, clients=15min, checkins=30s, snapshot_retention=daily-03:00)",
  );
```

- [ ] **Step 4: Run test (pass)**

`bun --filter '@vipcam/edge' test tests/unit/scheduler/snapshot-retention.test.ts` → 2 PASS.

- [ ] **Step 5: Run all edge tests (sanity — scheduler é compartilhado)**

`bun --filter '@vipcam/edge' test`
Expected: tudo verde. Como mock.module é process-wide em bun:test, se outros testes do scheduler existirem, podem ser afetados — mas Onda 8 já documentou o pattern de re-register em beforeEach.

- [ ] **Step 6: Verificar que /api/health vai expor checks.scheduler_snapshot_retention**

Não há código novo a escrever — `getJobHealth()` é genérico, então qualquer job registrado via `withRunningGuard` vira automaticamente `checks.scheduler_<name>` no `/api/health`. Verificação visual (manual, no curl):
```bash
# Depois do deploy:
curl -H "X-API-Key: $KEY" https://monitoramento.../api/health | jq .checks
# Esperado: aparece "scheduler_snapshot_retention": {"ok": true}
```
(Esta verificação roda no plano operacional pós-merge, não no plano de TDD.)

- [ ] **Step 7: Commit**

```bash
git add packages/edge/src/erp-sync/scheduler.ts \
        packages/edge/tests/unit/scheduler/snapshot-retention.test.ts
git commit -m "feat(edge): Onda 7 — scheduler snapshot_retention diário 03:00 (30d retention via pruneOlderThan)"
```

---

## Chunk 3: Match policy + Pipeline integration + Health

Onde o Failover B liga de fato. Repo de face_records ganha helpers de eviction (Top-K=5 FIFO) e transferência (usado pelo merge); módulo `match-policy` decide strict/borderline/new sobre o resultado de ANN pgvector; `orchestrator` cola reid-client + match-policy + saveCrop + graceful degrade + session-inheritance; pipeline.ts é re-escrito pra usar tudo isso; `/api/health` ganha `checks.reid`.

**Tasks neste chunk:** 11-15
**Sequenciamento estrito:** 11 → 12 → 13 (orchestrator depende de 11+12) → 14 (pipeline depende de 13) → 15 (paralelo a 14, mas commit depois).

---

### Task 11: face-records repo — insertAndEvict + transferToPerson

**Spec ref:** §4.2 (FIFO eviction transacional); §5.2 step 2 ("UPDATE face_records SET person_id = $Y WHERE person_id = $X" + eviction em Y).

**Files:**
- Modify: `packages/edge/src/persistence/repositories/face-records.repo.ts`
- Test: `packages/edge/tests/integration/persistence/face-records-repo.test.ts` (DB-deferred)

- [ ] **Step 1: Failing test (DB-deferred)**

`packages/edge/tests/integration/persistence/face-records-repo.test.ts`:
```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { faceRecordsRepo } from "../../../src/persistence/repositories/face-records.repo.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";
import { getDb } from "../../../src/persistence/db.js";

function vec(seed: number): number[] {
  return Array.from({ length: 512 }, (_, i) => (seed * (i + 1)) / 1e6);
}

let personId: string;
let dstPersonId: string;

beforeEach(async () => {
  const p = await personsRepo.create({ display_name: "Test src" });
  personId = p.id;
  const q = await personsRepo.create({ display_name: "Test dst" });
  dstPersonId = q.id;
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`DELETE FROM face_records WHERE person_id IN (${personId}, ${dstPersonId})`);
  await db.execute(sql`DELETE FROM persons WHERE id IN (${personId}, ${dstPersonId})`);
});

describe("faceRecordsRepo.insertAndEvict", () => {
  test("inserts 1st through 5th — all kept", async () => {
    for (let i = 0; i < 5; i++) {
      await faceRecordsRepo.insertAndEvict({
        person_id: personId,
        embedding: vec(i + 1),
        snapshot_path: `2026-05-20/det-${i}.jpg`,
        det_score: 0.9,
        model_name: "buffalo_s",
        model_revision: "insightface-0.7.3",
      });
    }
    const db = getDb();
    const [{ c }] = await db.execute<{ c: number }>(
      sql`SELECT count(*)::int AS c FROM face_records WHERE person_id = ${personId}`,
    );
    expect(c).toBe(5);
  });

  test("6th insert evicts oldest (FIFO via created_at)", async () => {
    const inserts: string[] = [];
    for (let i = 0; i < 6; i++) {
      const fr = await faceRecordsRepo.insertAndEvict({
        person_id: personId,
        embedding: vec(i + 1),
        snapshot_path: `2026-05-20/det-${i}.jpg`,
        det_score: 0.9,
        model_name: "buffalo_s",
        model_revision: "insightface-0.7.3",
      });
      inserts.push(fr.id);
      // gap mínimo pra garantir ordem temporal distinta (created_at granularity)
      await new Promise((r) => setTimeout(r, 5));
    }
    const db = getDb();
    const rows = await db.execute<{ id: string }>(
      sql`SELECT id FROM face_records WHERE person_id = ${personId} ORDER BY created_at ASC`,
    );
    expect(rows.length).toBe(5);
    // O mais antigo (índice 0) foi deletado
    expect(rows.map((r) => r.id)).not.toContain(inserts[0]);
    // O 6º (mais recente) está presente
    expect(rows.map((r) => r.id)).toContain(inserts[5]);
  });
});

describe("faceRecordsRepo.transferToPerson", () => {
  test("moves face_records de src pra dst e aplica FIFO eviction em dst", async () => {
    // src tem 3, dst tem 4 → após transfer dst tem 7 → eviction deixa 5 mais recentes
    for (let i = 0; i < 4; i++) {
      await faceRecordsRepo.insertAndEvict({
        person_id: dstPersonId,
        embedding: vec(100 + i),
        snapshot_path: `2026-05-20/dst-${i}.jpg`,
        det_score: 0.9,
        model_name: "buffalo_s",
        model_revision: "insightface-0.7.3",
      });
      await new Promise((r) => setTimeout(r, 2));
    }
    for (let i = 0; i < 3; i++) {
      await faceRecordsRepo.insertAndEvict({
        person_id: personId,
        embedding: vec(200 + i),
        snapshot_path: `2026-05-20/src-${i}.jpg`,
        det_score: 0.9,
        model_name: "buffalo_s",
        model_revision: "insightface-0.7.3",
      });
      await new Promise((r) => setTimeout(r, 2));
    }
    await faceRecordsRepo.transferToPerson(personId, dstPersonId);

    const db = getDb();
    const srcRows = await db.execute<{ c: number }>(
      sql`SELECT count(*)::int AS c FROM face_records WHERE person_id = ${personId}`,
    );
    expect(srcRows[0].c).toBe(0);
    const dstRows = await db.execute<{ c: number }>(
      sql`SELECT count(*)::int AS c FROM face_records WHERE person_id = ${dstPersonId}`,
    );
    expect(dstRows[0].c).toBe(5); // cap em 5
  });
});
```

- [ ] **Step 2: Run test (fail — métodos não existem)**

`bash packages/edge/scripts/run-integration-tests.sh tests/integration/persistence/face-records-repo.test.ts`
(Pré-req: `DATABASE_URL` setado + Postgres com migrations da Onda 7 aplicadas.)

- [ ] **Step 3: Implement insertAndEvict + transferToPerson**

Estender `packages/edge/src/persistence/repositories/face-records.repo.ts` — append os métodos abaixo dentro do `faceRecordsRepo` object:
```typescript
  /**
   * Insere face_record + FIFO eviction (cap=5) numa transação.
   * Pattern Onda 7 §4.2: SELECT FOR UPDATE defensivo (pipeline atual é
   * single-threaded mas paralelização futura não-quebra).
   */
  async insertAndEvict(
    data: Omit<NewFaceRecord, "id" | "created_at">,
  ): Promise<FaceRecord> {
    return await getDb().transaction(async (tx) => {
      // Lock dos existentes pra evitar race com outro insert na mesma person
      await tx.execute(sql`
        SELECT id FROM face_records WHERE person_id = ${data.person_id} FOR UPDATE
      `);
      const [inserted] = await tx.insert(faceRecords).values(data).returning();
      if (!inserted) throw new Error("face_records insert returned no row");
      // Eviction: deleta o que sobra além de 5 mais recentes
      await tx.execute(sql`
        DELETE FROM face_records
        WHERE id IN (
          SELECT id FROM face_records
          WHERE person_id = ${data.person_id}
          ORDER BY created_at DESC
          OFFSET 5
        )
      `);
      return inserted;
    });
  },

  /**
   * Move todos face_records de srcPersonId pra dstPersonId, depois FIFO
   * eviction em dst se total > 5. Helper usado por personsRepo.mergeInto
   * (Onda 7 §5.2 step 2 + step 3).
   *
   * Importante: NÃO faz lock próprio — assume que caller já está dentro de
   * uma transação que locked persons.srcId e persons.dstId (via mergeInto).
   * Se for chamado fora desse contexto, race condition é possível.
   */
  async transferToPerson(srcPersonId: string, dstPersonId: string): Promise<void> {
    const db = getDb();
    await db.execute(sql`
      UPDATE face_records SET person_id = ${dstPersonId}
      WHERE person_id = ${srcPersonId}
    `);
    await db.execute(sql`
      DELETE FROM face_records
      WHERE id IN (
        SELECT id FROM face_records
        WHERE person_id = ${dstPersonId}
        ORDER BY created_at DESC
        OFFSET 5
      )
    `);
  },
```

Imports adicionais no topo:
```typescript
import { sql } from "drizzle-orm";
```

- [ ] **Step 4: Run test (pass)**

`bash packages/edge/scripts/run-integration-tests.sh tests/integration/persistence/face-records-repo.test.ts`
Expected: 3 PASS.

- [ ] **Step 5: Verificar typecheck**

`bun --filter '@vipcam/edge' typecheck`

- [ ] **Step 6: Commit**

```bash
git add packages/edge/src/persistence/repositories/face-records.repo.ts \
        packages/edge/tests/integration/persistence/face-records-repo.test.ts
git commit -m "feat(edge): Onda 7 — faceRecordsRepo.insertAndEvict (FIFO=5) + transferToPerson (suporte ao mergeInto)"
```

---

### Task 12: match-policy module — decideMatch (ANN + dual threshold)

**Spec ref:** §4.3 (decision tree + zero-rows behavior + thresholds via ENV).

**Files:**
- Create: `packages/edge/src/api/reid/match-policy.ts`
- Test: `packages/edge/tests/unit/api/reid/match-policy.test.ts`
- Test (DB-deferred): `packages/edge/tests/integration/api/reid/match-policy-ann.test.ts`

- [ ] **Step 1: Failing test (pure logic, sem DB)**

`packages/edge/tests/unit/api/reid/match-policy.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import {
  classifyDistance,
  type MatchDecision,
} from "../../../../src/api/reid/match-policy.js";

describe("classifyDistance — pure decision tree", () => {
  const strict = 0.35;
  const loose = 0.55;

  test("dist=0 → strict", () => {
    expect(classifyDistance(0, strict, loose)).toBe("strict");
  });
  test("dist=0.35 → strict (boundary inclusive)", () => {
    expect(classifyDistance(0.35, strict, loose)).toBe("strict");
  });
  test("dist=0.36 → borderline", () => {
    expect(classifyDistance(0.36, strict, loose)).toBe("borderline");
  });
  test("dist=0.55 → borderline (boundary inclusive)", () => {
    expect(classifyDistance(0.55, strict, loose)).toBe("borderline");
  });
  test("dist=0.56 → new_person", () => {
    expect(classifyDistance(0.56, strict, loose)).toBe("new_person");
  });
  test("dist=2.0 (max cosine) → new_person", () => {
    expect(classifyDistance(2.0, strict, loose)).toBe("new_person");
  });

  // Type tightness
  test("returns MatchDecision union", () => {
    const _: MatchDecision = classifyDistance(0.5, strict, loose);
    void _;
  });
});
```

- [ ] **Step 2: Run test (fail — module não existe)**

`bun --filter '@vipcam/edge' test tests/unit/api/reid/match-policy.test.ts`

- [ ] **Step 3: Create match-policy module — pure decision tree primeiro**

`packages/edge/src/api/reid/match-policy.ts`:
```typescript
import { sql } from "drizzle-orm";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../persistence/db.js";
import { faceRecords } from "../../persistence/schema/face-records.js";

/** Tipo do resultado de decideMatch (Onda 7 §4.3 decision tree). */
export type MatchDecision = "strict" | "borderline" | "new_person";

/** Pura — classifica distance. Boundaries inclusivas em ambos limiares. */
export function classifyDistance(
  distance: number,
  strictMax: number,
  looseMax: number,
): MatchDecision {
  if (distance <= strictMax) return "strict";
  if (distance <= looseMax) return "borderline";
  return "new_person";
}

export interface DecideMatchInput {
  embedding: number[];
  modelName: string;
  modelRevision: string;
  strictMax: number;
  looseMax: number;
}

export interface DecideMatchResult {
  decision: MatchDecision;
  /** Apenas presente em 'strict' ou 'borderline'. */
  candidate?: {
    face_record_id: string;
    person_id: string;
    distance: number;
  };
}

/**
 * Query ANN top-1 + dual threshold (Onda 7 §4.3).
 *
 * Filtra por (model_name, model_revision) atuais — embeddings de modelos
 * antigos viram órfãos automaticamente (zero matching post-troca).
 *
 * Zero rows resultantes (DB vazio OU todos os face_records são de outro
 * modelo) → decisão `new_person` sem candidate.
 */
export async function decideMatch(input: DecideMatchInput): Promise<DecideMatchResult> {
  const db = getDb();
  // Embedding vai como string `[v1,v2,...]` (formato custom type vector512)
  const embStr = `[${input.embedding.join(",")}]`;
  const rows = await db
    .select({
      face_record_id: faceRecords.id,
      person_id: faceRecords.person_id,
      distance: sql<number>`embedding <=> ${embStr}::vector`,
    })
    .from(faceRecords)
    .where(
      and(
        eq(faceRecords.model_name, input.modelName),
        eq(faceRecords.model_revision, input.modelRevision),
      ),
    )
    .orderBy(sql`embedding <=> ${embStr}::vector`)
    .limit(1);

  if (rows.length === 0) {
    return { decision: "new_person" };
  }
  const [top] = rows;
  const decision = classifyDistance(top.distance, input.strictMax, input.looseMax);
  if (decision === "new_person") {
    return { decision: "new_person" };
  }
  return {
    decision,
    candidate: {
      face_record_id: top.face_record_id,
      person_id: top.person_id,
      distance: top.distance,
    },
  };
}
```

- [ ] **Step 4: Run unit test (pass)**

`bun --filter '@vipcam/edge' test tests/unit/api/reid/match-policy.test.ts` → 7 PASS.

- [ ] **Step 5: Failing DB-deferred test (decideMatch ANN query real)**

`packages/edge/tests/integration/api/reid/match-policy-ann.test.ts`:
```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { decideMatch } from "../../../../src/api/reid/match-policy.js";
import { faceRecordsRepo } from "../../../../src/persistence/repositories/face-records.repo.js";
import { personsRepo } from "../../../../src/persistence/repositories/persons.repo.js";
import { getDb } from "../../../../src/persistence/db.js";

let personId: string;

function vecFromBase(seed: number, jitter = 0): number[] {
  return Array.from({ length: 512 }, (_, i) => {
    const v = ((seed * (i + 1)) % 1000) / 1000;
    return v + (Math.sin(i + jitter) * 0.001); // pequena perturbação
  });
}

beforeEach(async () => {
  const p = await personsRepo.create({ display_name: "Anchor" });
  personId = p.id;
});
afterEach(async () => {
  const db = getDb();
  await db.execute(sql`DELETE FROM face_records WHERE person_id = ${personId}`);
  await db.execute(sql`DELETE FROM persons WHERE id = ${personId}`);
});

describe("decideMatch ANN query (DB-deferred)", () => {
  test("empty DB → new_person", async () => {
    const r = await decideMatch({
      embedding: vecFromBase(1),
      modelName: "buffalo_s",
      modelRevision: "insightface-0.7.3",
      strictMax: 0.35,
      looseMax: 0.55,
    });
    expect(r.decision).toBe("new_person");
    expect(r.candidate).toBeUndefined();
  });

  test("model mismatch filter → new_person (zero rows)", async () => {
    await faceRecordsRepo.insertAndEvict({
      person_id: personId,
      embedding: vecFromBase(1),
      snapshot_path: "x.jpg",
      det_score: 0.9,
      model_name: "OUTRO_MODELO",
      model_revision: "y",
    });
    const r = await decideMatch({
      embedding: vecFromBase(1),
      modelName: "buffalo_s",
      modelRevision: "insightface-0.7.3",
      strictMax: 0.35,
      looseMax: 0.55,
    });
    expect(r.decision).toBe("new_person");
  });

  test("strict match — distância ~0 contra embedding idêntico", async () => {
    const emb = vecFromBase(1);
    const fr = await faceRecordsRepo.insertAndEvict({
      person_id: personId,
      embedding: emb,
      snapshot_path: "x.jpg",
      det_score: 0.9,
      model_name: "buffalo_s",
      model_revision: "insightface-0.7.3",
    });
    const r = await decideMatch({
      embedding: emb,
      modelName: "buffalo_s",
      modelRevision: "insightface-0.7.3",
      strictMax: 0.35,
      looseMax: 0.55,
    });
    expect(r.decision).toBe("strict");
    expect(r.candidate?.face_record_id).toBe(fr.id);
    expect(r.candidate?.person_id).toBe(personId);
    expect(r.candidate?.distance).toBeLessThanOrEqual(0.001);
  });
});
```

- [ ] **Step 6: Run DB-deferred test (pass)**

`bash packages/edge/scripts/run-integration-tests.sh tests/integration/api/reid/match-policy-ann.test.ts`
Expected: 3 PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/edge/src/api/reid/match-policy.ts \
        packages/edge/tests/unit/api/reid/match-policy.test.ts \
        packages/edge/tests/integration/api/reid/match-policy-ann.test.ts
git commit -m "feat(edge): Onda 7 — match-policy.decideMatch (ANN top-1 + dual threshold + model filter)"
```

---

### Task 13: Reid orchestrator — resolvePersonIdViaReid

**Spec ref:** §3.5 (graceful degrade + session-inheritance), §4.3 (3 caminhos: strict/borderline/new), §5.5 (REID_ENABLED toggle).

**Files:**
- Create: `packages/edge/src/api/reid/orchestrator.ts`
- Modify: `packages/edge/src/persistence/repositories/reid-match-attempts.repo.ts` (criar — necessário aqui pra inserir borderline)
- Modify: `packages/edge/src/persistence/repositories/index.ts` (export)
- Test: `packages/edge/tests/unit/api/reid/orchestrator.test.ts`

- [ ] **Step 1: Create reid_match_attempts.repo (minimal — só createAmbiguous; resto vem em Chunk 4)**

`packages/edge/src/persistence/repositories/reid-match-attempts.repo.ts`:
```typescript
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
```

E adicionar export em `packages/edge/src/persistence/repositories/index.ts`:
```typescript
export * from "./reid-match-attempts.repo.js";
```

- [ ] **Step 2: Failing test do orchestrator**

`packages/edge/tests/unit/api/reid/orchestrator.test.ts`:
```typescript
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { EmbedResult } from "@vipcam/shared";
import type { DecideMatchResult } from "../../../../src/api/reid/match-policy.js";

// Mock todas as deps externas via mock.module ANTES de importar o orchestrator
let embedReturn: EmbedResult | Error = new Error("not configured");
let decideReturn: DecideMatchResult = { decision: "new_person" };
let saveCropReturn = "2026-05-20/test.jpg";
let envOverride: Record<string, unknown> = {};

const installMocks = () => {
  mock.module("../../../../src/discovery/image-probe/reid-client.js", () => ({
    embed: async () => {
      if (embedReturn instanceof Error) throw embedReturn;
      return embedReturn;
    },
    ReidError: class extends Error {},
  }));
  mock.module("../../../../src/api/reid/match-policy.js", () => ({
    decideMatch: async () => decideReturn,
  }));
  mock.module("../../../../src/api/reid/snapshot-store.js", () => ({
    saveCrop: async () => saveCropReturn,
  }));
  mock.module("../../../../src/config/env.js", () => ({
    getEnv: () => ({
      REID_ENABLED: true,
      REID_BASE_URL: "http://x",
      REID_DIST_STRICT: 0.35,
      REID_DIST_LOOSE: 0.55,
      SNAPSHOTS_DIR: "/tmp/snaps",
      ...envOverride,
    }),
  }));
};
installMocks();

import { resolvePersonIdViaReid } from "../../../../src/api/reid/orchestrator.js";

const baseInput = {
  cameraId: "cam-1",
  detectionId: "det-1",
  detectedAt: new Date("2026-05-20T14:30:00Z"),
  sessionId: "sess-1",
  bbox: { x: 100, y: 100, w: 200, h: 200 },
  frameBytes: Buffer.from([0xff, 0xd8]),
};

beforeEach(() => {
  embedReturn = new Error("not configured");
  decideReturn = { decision: "new_person" };
  saveCropReturn = "2026-05-20/test.jpg";
  envOverride = {};
  installMocks();
});

describe("resolvePersonIdViaReid", () => {
  test("REID_ENABLED=false → status=disabled, snapshot ainda salva", async () => {
    envOverride = { REID_ENABLED: false };
    installMocks();
    const r = await resolvePersonIdViaReid({
      ...baseInput,
      sessionInheritedPersonId: null,
    });
    expect(r.status).toBe("disabled");
    expect(r.personId).toBeNull();
    expect(r.snapshotPath).toBe("2026-05-20/test.jpg"); // saveCrop ainda roda no caller; ver pipeline
  });

  test("embed throws → status=unavailable + session-inheritance fallback", async () => {
    embedReturn = new Error("ECONNREFUSED");
    const r = await resolvePersonIdViaReid({
      ...baseInput,
      sessionInheritedPersonId: "p-inherited",
    });
    expect(r.status).toBe("inherited_session");
    expect(r.personId).toBe("p-inherited");
    expect(r.reidError).toBeDefined();
  });

  test("embed throws + sem session inheritance → status=unavailable + personId=null", async () => {
    embedReturn = new Error("timeout");
    const r = await resolvePersonIdViaReid({
      ...baseInput,
      sessionInheritedPersonId: null,
    });
    expect(r.status).toBe("unavailable");
    expect(r.personId).toBeNull();
  });

  test("decision=strict → status=matched_strict, personId=candidate.person_id", async () => {
    embedReturn = {
      embedding: Array(512).fill(0.01),
      det_score: 0.9,
      infer_ms: 28,
      model_name: "buffalo_s",
      model_revision: "insightface-0.7.3",
    };
    decideReturn = {
      decision: "strict",
      candidate: { face_record_id: "fr-1", person_id: "p-existing", distance: 0.2 },
    };
    const r = await resolvePersonIdViaReid({
      ...baseInput,
      sessionInheritedPersonId: null,
    });
    expect(r.status).toBe("matched_strict");
    expect(r.personId).toBe("p-existing");
    expect(r.reidDistance).toBe(0.2);
  });

  test("decision=new_person → status=new_person + personId=null (caller cria person)", async () => {
    embedReturn = {
      embedding: Array(512).fill(0.01),
      det_score: 0.9,
      infer_ms: 28,
      model_name: "buffalo_s",
      model_revision: "insightface-0.7.3",
    };
    decideReturn = { decision: "new_person" };
    const r = await resolvePersonIdViaReid({
      ...baseInput,
      sessionInheritedPersonId: null,
    });
    expect(r.status).toBe("new_person");
    expect(r.personId).toBeNull();
    expect(r.embedding).toBeDefined();
  });

  test("decision=borderline → status=borderline + personId=null + candidate exposto", async () => {
    embedReturn = {
      embedding: Array(512).fill(0.01),
      det_score: 0.9,
      infer_ms: 28,
      model_name: "buffalo_s",
      model_revision: "insightface-0.7.3",
    };
    decideReturn = {
      decision: "borderline",
      candidate: { face_record_id: "fr-2", person_id: "p-maybe", distance: 0.45 },
    };
    const r = await resolvePersonIdViaReid({
      ...baseInput,
      sessionInheritedPersonId: null,
    });
    expect(r.status).toBe("borderline");
    expect(r.personId).toBeNull();
    expect(r.borderlineCandidate).toEqual({
      face_record_id: "fr-2",
      person_id: "p-maybe",
      distance: 0.45,
    });
  });
});
```

- [ ] **Step 3: Run test (fail — orchestrator module não existe)**

`bun --filter '@vipcam/edge' test tests/unit/api/reid/orchestrator.test.ts`

- [ ] **Step 4: Implement orchestrator**

`packages/edge/src/api/reid/orchestrator.ts`:
```typescript
import type { BBox, EmbedResult, ReidStatus } from "@vipcam/shared";
import { getEnv } from "../../config/env.js";
import { embed } from "../../discovery/image-probe/reid-client.js";
import { logger } from "../../obs/logger.js";
import { decideMatch } from "./match-policy.js";

export interface ReidInput {
  cameraId: string;
  detectionId: string;
  detectedAt: Date;
  sessionId: string;
  bbox: BBox;
  frameBytes: Buffer;
  /** person_id de detection prévia da MESMA sessão aberta (Onda 7 §3.5
   * session-inheritance fallback). null se sessão nova ou anterior anônima. */
  sessionInheritedPersonId: string | null;
}

export interface ReidOutput {
  /** Person resolvido pelo reid (null se borderline, new, ou unavailable
   * sem session inheritance). */
  personId: string | null;
  /** Estado pra gravar em detections.face_attrs.reid_status. */
  status: ReidStatus;
  /** Distance do match (apenas presente em strict/borderline). */
  reidDistance?: number;
  /** Erro do reid client (apenas presente em status='unavailable'/'inherited_session'). */
  reidError?: string;
  /** Embedding bruto — caller usa pra criar face_record em strict/new_person. */
  embedding?: EmbedResult;
  /** Candidato borderline — caller usa pra inserir reid_match_attempt(ambiguous). */
  borderlineCandidate?: { face_record_id: string; person_id: string; distance: number };
}

/**
 * Orquestra reid para uma detection: embed + match + decide.
 * NÃO escreve no DB (caller é o pipeline que orquestra a transação completa).
 * NÃO escreve em disco (caller faz saveCrop).
 *
 * Política de falha (Onda 7 §3.5):
 * 1. REID_ENABLED=false → status='disabled', skip embed.
 * 2. embed() throws → status='unavailable'. Se sessionInheritedPersonId
 *    presente, herda esse personId + status='inherited_session'. Senão personId=null.
 * 3. embed() ok + decideMatch → strict / borderline / new_person.
 */
export async function resolvePersonIdViaReid(input: ReidInput): Promise<ReidOutput> {
  const env = getEnv();
  if (!env.REID_ENABLED) {
    return { personId: null, status: "disabled" };
  }
  let emb: EmbedResult;
  try {
    emb = await embed(env.REID_BASE_URL, input.frameBytes, input.bbox);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg, detectionId: input.detectionId }, "reid embed failed");
    if (input.sessionInheritedPersonId) {
      return {
        personId: input.sessionInheritedPersonId,
        status: "inherited_session",
        reidError: msg,
      };
    }
    return { personId: null, status: "unavailable", reidError: msg };
  }

  const match = await decideMatch({
    embedding: emb.embedding,
    modelName: emb.model_name,
    modelRevision: emb.model_revision,
    strictMax: env.REID_DIST_STRICT,
    looseMax: env.REID_DIST_LOOSE,
  });

  if (match.decision === "strict") {
    return {
      personId: match.candidate!.person_id,
      status: "matched_strict",
      reidDistance: match.candidate!.distance,
      embedding: emb,
    };
  }
  if (match.decision === "borderline") {
    return {
      personId: null,
      status: "borderline",
      reidDistance: match.candidate!.distance,
      embedding: emb,
      borderlineCandidate: match.candidate,
    };
  }
  return { personId: null, status: "new_person", embedding: emb };
}
```

- [ ] **Step 5: Run test (pass)**

`bun --filter '@vipcam/edge' test tests/unit/api/reid/orchestrator.test.ts` → 6 PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/edge/src/api/reid/orchestrator.ts \
        packages/edge/src/persistence/repositories/reid-match-attempts.repo.ts \
        packages/edge/src/persistence/repositories/index.ts \
        packages/edge/tests/unit/api/reid/orchestrator.test.ts
git commit -m "feat(edge): Onda 7 — reid orchestrator (graceful degrade + session-inheritance + 3 decision paths)"
```

---

### Task 14: Pipeline rewrite + listener wiring

**Spec ref:** §2.5 (sync sequencial: capture → embed → ANN → write → INSERT); §3.5 (face_attrs.reid_status); §5.5 (REID_ENABLED).

**Files:**
- Modify: `packages/edge/src/ingest/pipeline.ts`
- Modify: `packages/edge/src/ingest/listener.ts` (passa o client pro pipeline)
- Modify: `packages/edge/src/discovery/image-probe/reid-client.ts` (já tem detect; reusa pattern pra captureSnapshot helper)
- Modify: `packages/edge/tests/unit/ingest/pipeline.test.ts` (se existir; senão criar)

- [ ] **Step 1: Failing test do pipeline (mock orchestrator + saveCrop + reid-client.captureSnapshot)**

> **Nota:** este teste é grande — é a integração do orchestrator no pipeline. Aceitar +50 LoC porque cobre TODOS os caminhos.

`packages/edge/tests/unit/ingest/pipeline-reid.test.ts`:
```typescript
// Bun:test mock.module process-wide note — mesma defesa do Onda 8.
import { beforeEach, describe, expect, mock, test } from "bun:test";

let orchestratorResult: unknown = { personId: null, status: "disabled" };
let savedCrop: { detectionId?: string; jpegBytes?: Buffer } = {};
let capturedFrame: Buffer = Buffer.from([0xff, 0xd8]);
let insertedDetection: Record<string, unknown> | null = null;
let createdPerson: Record<string, unknown> | null = null;
let createdFaceRecord: Record<string, unknown> | null = null;
let createdAmbiguous: Record<string, unknown> | null = null;

const installMocks = () => {
  mock.module("../../../src/api/reid/orchestrator.js", () => ({
    resolvePersonIdViaReid: async () => orchestratorResult,
  }));
  mock.module("../../../src/api/reid/snapshot-store.js", () => ({
    saveCrop: async (p: { detectionId: string; jpegBytes: Buffer }) => {
      savedCrop = p;
      return "2026-05-20/test.jpg";
    },
  }));
  mock.module("../../../src/persistence/repositories/detections.repo.js", () => ({
    detectionsRepo: {
      create: async (d: Record<string, unknown>) => {
        insertedDetection = d;
        return { id: d.id ?? "det-x", ...d };
      },
    },
  }));
  mock.module("../../../src/persistence/repositories/persons.repo.js", () => ({
    personsRepo: {
      create: async (p: Record<string, unknown>) => {
        createdPerson = p;
        return { id: "p-new", ...p };
      },
      incrementVisitCount: async () => undefined,
    },
  }));
  mock.module("../../../src/persistence/repositories/face-records.repo.js", () => ({
    faceRecordsRepo: {
      insertAndEvict: async (d: Record<string, unknown>) => {
        createdFaceRecord = d;
        return { id: "fr-x", ...d };
      },
    },
  }));
  mock.module("../../../src/persistence/repositories/reid-match-attempts.repo.js", () => ({
    reidMatchAttemptsRepo: {
      createAmbiguous: async (d: Record<string, unknown>) => {
        createdAmbiguous = d;
        return { id: "rma-x", ...d };
      },
    },
  }));
  mock.module("../../../src/persistence/repositories/sessions.repo.js", () => ({
    sessionsRepo: {
      findOpenForTrack: async () => null,
      create: async () => ({ id: "sess-new", person_id: null }),
      appendDetection: async () => undefined,
      recalcDominantEmotion: async () => undefined,
    },
  }));
};
installMocks();

import { processEvent } from "../../../src/ingest/pipeline.js";

function captureSnapshotStub(): Promise<Buffer> {
  return Promise.resolve(capturedFrame);
}

beforeEach(() => {
  orchestratorResult = { personId: null, status: "disabled" };
  savedCrop = {};
  insertedDetection = null;
  createdPerson = null;
  createdFaceRecord = null;
  createdAmbiguous = null;
  installMocks();
});

describe("processEvent — reid integration", () => {
  test("orchestrator strict match → detection gets person_id + face_record criado", async () => {
    orchestratorResult = {
      personId: "p-existing",
      status: "matched_strict",
      reidDistance: 0.2,
      embedding: {
        embedding: Array(512).fill(0.1),
        det_score: 0.95,
        infer_ms: 28,
        model_name: "buffalo_s",
        model_revision: "insightface-0.7.3",
      },
    };
    const raw = {
      // shape mínimo aceito pelo normalizer — ver pipeline.ts atual
      received_at: "2026-05-20T14:30:00Z",
      index: 1,
      parsed: {
        code: "FaceDetection",
        action: "Start",
        data: {
          UID: "track-1",
          Object: { BoundingBox: [100, 100, 300, 300] },
        },
      },
    } as Parameters<typeof processEvent>[0];

    await processEvent(raw, "cam-1", { captureSnapshot: captureSnapshotStub });

    expect(insertedDetection?.person_id).toBe("p-existing");
    expect(insertedDetection?.snapshot_path).toBe("2026-05-20/test.jpg");
    expect((insertedDetection?.face_attrs as Record<string, unknown>).reid_status).toBe(
      "matched_strict",
    );
    expect(createdFaceRecord?.person_id).toBe("p-existing");
    expect(createdPerson).toBeNull();
  });

  test("orchestrator new_person → cria person anônima + face_record", async () => {
    orchestratorResult = {
      personId: null,
      status: "new_person",
      embedding: {
        embedding: Array(512).fill(0.1),
        det_score: 0.95,
        infer_ms: 28,
        model_name: "buffalo_s",
        model_revision: "insightface-0.7.3",
      },
    };
    const raw = {
      received_at: "2026-05-20T14:30:00Z",
      index: 1,
      parsed: {
        code: "FaceDetection",
        action: "Start",
        data: {
          UID: "track-2",
          Object: { BoundingBox: [100, 100, 300, 300] },
        },
      },
    } as Parameters<typeof processEvent>[0];

    await processEvent(raw, "cam-1", { captureSnapshot: captureSnapshotStub });

    expect(createdPerson).toBeDefined();
    expect((createdPerson as Record<string, unknown>).person_type).toBe("anonymous");
    expect(insertedDetection?.person_id).toBe("p-new");
    expect(createdFaceRecord?.person_id).toBe("p-new");
    expect((createdFaceRecord as Record<string, unknown>).is_primary).toBe(true);
  });

  test("orchestrator borderline → INSERT reid_match_attempt(ambiguous)", async () => {
    orchestratorResult = {
      personId: null,
      status: "borderline",
      reidDistance: 0.45,
      embedding: {
        embedding: Array(512).fill(0.1),
        det_score: 0.9,
        infer_ms: 28,
        model_name: "buffalo_s",
        model_revision: "insightface-0.7.3",
      },
      borderlineCandidate: { face_record_id: "fr-cand", person_id: "p-cand", distance: 0.45 },
    };
    const raw = {
      received_at: "2026-05-20T14:30:00Z",
      index: 1,
      parsed: {
        code: "FaceDetection",
        action: "Start",
        data: {
          UID: "track-3",
          Object: { BoundingBox: [100, 100, 300, 300] },
        },
      },
    } as Parameters<typeof processEvent>[0];

    await processEvent(raw, "cam-1", { captureSnapshot: captureSnapshotStub });

    expect(createdAmbiguous?.candidate_face_record_id).toBe("fr-cand");
    expect(createdAmbiguous?.candidate_person_id).toBe("p-cand");
    expect(createdAmbiguous?.distance).toBe(0.45);
    expect(insertedDetection?.person_id).toBeNull();
    expect(createdFaceRecord).toBeNull(); // borderline NÃO grava face_record
  });

  test("status=disabled → snapshot ainda escreve (parte independente)", async () => {
    orchestratorResult = { personId: null, status: "disabled" };
    const raw = {
      received_at: "2026-05-20T14:30:00Z",
      index: 1,
      parsed: {
        code: "FaceDetection",
        action: "Start",
        data: {
          UID: "track-4",
          Object: { BoundingBox: [100, 100, 300, 300] },
        },
      },
    } as Parameters<typeof processEvent>[0];

    await processEvent(raw, "cam-1", { captureSnapshot: captureSnapshotStub });

    expect(insertedDetection?.snapshot_path).toBe("2026-05-20/test.jpg");
    expect((insertedDetection?.face_attrs as Record<string, unknown>).reid_status).toBe("disabled");
  });
});
```

- [ ] **Step 2: Run test (fail — processEvent não aceita captureSnapshot e não chama orchestrator)**

`bun --filter '@vipcam/edge' test tests/unit/ingest/pipeline-reid.test.ts`

- [ ] **Step 3: Rewrite pipeline.ts**

Substituir o `processEvent` atual por uma versão que:
1. Recebe `deps?: { captureSnapshot?: () => Promise<Buffer> }` opcional
2. Após resolveSessionId, captura frame se evento tem bbox + REID_ENABLED + captureSnapshot fornecido
3. Chama orchestrator
4. Salva crop em disco (sempre que tem snapshot bytes — independente do reid status)
5. Cria person nova se status=new_person
6. Insere detection com snapshot_path + person_id + face_attrs.reid_status/reid_distance/reid_error
7. Insere face_record se status in {strict, new_person}
8. Insere reid_match_attempt(ambiguous) se status=borderline
9. Mantém recalcDominantEmotion + eventBus.publish

Código completo (substituir o `export async function processEvent` inteiro):
```typescript
export interface ProcessEventDeps {
  /** Closure que captura frame inteiro via snapshot.cgi. Injetada pelo
   * listener (que tem o DahuaHttpClient). Quando undefined (ex: testes
   * sem câmera), reid é skipado e detection vai sem snapshot. */
  captureSnapshot?: () => Promise<Buffer>;
}

export async function processEvent(
  raw: CapturedEvent,
  cameraId: string,
  deps: ProcessEventDeps = {},
): Promise<void> {
  try {
    const event = normalize(raw, cameraId);
    if (!event) return;
    if (event.type === "face.detected.stop") {
      logger.debug({ track_id: event.track_id }, "face.detected.stop — no detection persisted");
      return;
    }

    const detectedAt = new Date(event.detected_at);
    // Resolve session ANTES do reid pra ter sessionInheritedPersonId
    const sessionId = await resolveSessionIdWithAnchor(event, detectedAt);
    const sessionInheritedPersonId = await sessionsRepo
      .findOpenForTrack(event.camera_id, event.track_id ?? "", detectedAt, SESSION_GAP_MS)
      .then((s) => s?.person_id ?? null);

    // Snapshot capture + reid orchestration (apenas se temos bbox + captureSnapshot)
    let snapshotPath: string | null = null;
    let reidOut: import("../api/reid/orchestrator.js").ReidOutput | null = null;
    const detectionId = crypto.randomUUID();
    if (event.bbox && deps.captureSnapshot) {
      try {
        const frameBytes = await deps.captureSnapshot();
        const { resolvePersonIdViaReid } = await import("../api/reid/orchestrator.js");
        reidOut = await resolvePersonIdViaReid({
          cameraId: event.camera_id,
          detectionId,
          detectedAt,
          sessionId,
          bbox: event.bbox,
          frameBytes,
          sessionInheritedPersonId,
        });
        // Save snapshot (sempre — mesmo se reid falhou, queremos o /live mostrando rosto)
        const { saveCrop } = await import("../api/reid/snapshot-store.js");
        const { getEnv } = await import("../config/env.js");
        // NB: gravamos o FRAME INTEIRO (não o crop) porque crop pra serializar
        // pediria PIL/sharp no edge — Onda 7 mantém JPEG do frame inteiro até
        // que UI tenha demand pra apertar (Onda futura).
        snapshotPath = await saveCrop({
          baseDir: getEnv().SNAPSHOTS_DIR,
          detectionId,
          detectedAt,
          jpegBytes: frameBytes,
        });
      } catch (err) {
        logger.warn({ err, detectionId }, "snapshot/reid pipeline error — degrading");
      }
    }

    // Decide person_id final
    let personId: string | null = reidOut?.personId ?? null;
    if (reidOut?.status === "new_person") {
      const created = await personsRepo.create({
        person_type: "anonymous",
        first_seen_at: detectedAt,
        last_seen_at: detectedAt,
      });
      personId = created.id;
    } else if (reidOut?.status === "matched_strict" && personId) {
      await personsRepo.incrementVisitCount(personId, detectedAt);
    }

    // Compose face_attrs (parsed + reid metadata)
    const parsedAttrs: Record<string, unknown> = {};
    if (event.face_attrs) {
      const { raw: _raw, ...rest } = event.face_attrs;
      Object.assign(parsedAttrs, rest);
    }
    if (reidOut) {
      parsedAttrs.reid_status = reidOut.status;
      if (reidOut.reidDistance !== undefined) parsedAttrs.reid_distance = reidOut.reidDistance;
      if (reidOut.reidError) parsedAttrs.reid_error = reidOut.reidError;
    }

    const detection: Parameters<typeof detectionsRepo.create>[0] = {
      id: detectionId,
      camera_id: event.camera_id,
      person_id: personId,
      session_id: sessionId,
      face_attrs: parsedAttrs,
      detected_at: detectedAt,
      raw_event: event.raw_event,
    };
    if (event.track_id !== undefined) detection.track_id = event.track_id;
    if (event.bbox !== undefined) detection.bbox = event.bbox;
    if (event.face_attrs?.emotion !== undefined) detection.dominant_emotion = event.face_attrs.emotion;
    if (event.face_attrs?.emotion_intensity !== undefined) {
      detection.emotion_confidence = event.face_attrs.emotion_intensity / 100;
    }
    if (snapshotPath) detection.snapshot_path = snapshotPath;

    const created = await detectionsRepo.create(detection);

    // face_record (strict ou new_person tem embedding pra gravar)
    if (
      reidOut?.embedding &&
      (reidOut.status === "matched_strict" || reidOut.status === "new_person") &&
      personId
    ) {
      const { faceRecordsRepo } = await import("../persistence/repositories/face-records.repo.js");
      await faceRecordsRepo.insertAndEvict({
        person_id: personId,
        embedding: reidOut.embedding.embedding,
        snapshot_path: snapshotPath ?? "",
        det_score: reidOut.embedding.det_score,
        model_name: reidOut.embedding.model_name,
        model_revision: reidOut.embedding.model_revision,
        is_primary: reidOut.status === "new_person", // primeiro embedding da person nova vira primary
      });
    }

    // reid_match_attempt(ambiguous) se borderline
    if (reidOut?.status === "borderline" && reidOut.borderlineCandidate) {
      const { reidMatchAttemptsRepo } = await import(
        "../persistence/repositories/reid-match-attempts.repo.js"
      );
      await reidMatchAttemptsRepo.createAmbiguous({
        detection_id: created.id,
        candidate_face_record_id: reidOut.borderlineCandidate.face_record_id,
        candidate_person_id: reidOut.borderlineCandidate.person_id,
        distance: reidOut.borderlineCandidate.distance,
      });
    }

    if (detection.dominant_emotion) await sessionsRepo.recalcDominantEmotion(sessionId);

    // event-bus dormente (Onda 8: SSE removido, mas publish ainda existe sem consumer)
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
        person: null,
      };
      eventBus.publish(liveEvent);
    } catch (err) {
      logger.warn({ err }, "event bus publish failed — ingest continues");
    }

    logger.debug({ event: event.type, personId, sessionId }, "ingest persisted");
  } catch (err) {
    logger.error({ err, raw }, "ingest pipeline failed for event");
  }
}

// Helper privado — encapsula a lógica de resolveSessionId atual sem o personId
// (que agora é decidido pós-reid). Preserva semântica do shouldStartNewSession.
async function resolveSessionIdWithAnchor(event: CanonicalEvent, detectedAt: Date): Promise<string> {
  const existing = event.track_id
    ? await sessionsRepo.findOpenForTrack(event.camera_id, event.track_id, detectedAt, SESSION_GAP_MS)
    : null;
  if (existing && !shouldStartNewSession(existing.last_seen_at, detectedAt, SESSION_GAP_MS)) {
    await sessionsRepo.appendDetection(existing.id, detectedAt);
    return existing.id;
  }
  const newSession: Parameters<typeof sessionsRepo.create>[0] = {
    camera_id: event.camera_id,
    person_id: null, // pessoa será setada pós-reid via UPDATE futuro (ou ficam null pra anônimas)
    started_at: detectedAt,
    last_seen_at: detectedAt,
    detection_count: 1,
  };
  if (event.track_id !== undefined) newSession.current_track_id = event.track_id;
  const created = await sessionsRepo.create(newSession);
  return created.id;
}
```

Remover o `resolvePersonId` stub e o antigo `resolveSessionId`.

- [ ] **Step 4: Update listener.ts pra passar captureSnapshot**

Em `packages/edge/src/ingest/listener.ts`, dentro de `runOnce`, no `onEvent`:
```typescript
    onEvent: (captured) => {
      const captureSnapshot = () =>
        client
          .get("/cgi-bin/snapshot.cgi?channel=1")
          .then((r) => r.arrayBuffer())
          .then((b) => Buffer.from(b));
      void processEvent(captured, camera.id, { captureSnapshot });
      // ... resto do probe sampler (preservado)
    },
```

- [ ] **Step 5: Run test (pass)**

`bun --filter '@vipcam/edge' test tests/unit/ingest/pipeline-reid.test.ts` → 4 PASS.

- [ ] **Step 6: Run full edge tests + typecheck**

```
bun --filter '@vipcam/edge' typecheck
bun --filter '@vipcam/edge' test
```
Expected: tudo verde. Se algum test antigo do pipeline existir e quebrar pelo signature mudou, atualizar (provavelmente chamava processEvent(raw, cameraId) sem deps — esse continua funcionando, default {} skipa reid).

- [ ] **Step 7: Commit**

```bash
git add packages/edge/src/ingest/pipeline.ts \
        packages/edge/src/ingest/listener.ts \
        packages/edge/tests/unit/ingest/pipeline-reid.test.ts
git commit -m "feat(edge): Onda 7 — pipeline.processEvent integra reid orchestrator + snapshot capture/write"
```

---

### Task 15: /api/health checks.reid (sync ping)

**Spec ref:** §3.4 (ping sync, latency_ms, model_name/revision, ok=false degrada overall).

**Files:**
- Create: `packages/edge/src/api/reid/health.ts`
- Modify: `packages/edge/src/api/server.ts` (incluir checks.reid no /api/health handler)
- Test: `packages/edge/tests/unit/api/reid/health.test.ts`

- [ ] **Step 1: Failing test**

`packages/edge/tests/unit/api/reid/health.test.ts`:
```typescript
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ORIG_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
});

import { pingReid } from "../../../../src/api/reid/health.ts";

describe("pingReid", () => {
  test("returns ok=true + model metadata when /health responds 200", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            status: "healthy",
            version: "0.2.0",
            model_name: "buffalo_s",
            model_revision: "insightface-0.7.3",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as typeof globalThis.fetch;

    const r = await pingReid("http://127.0.0.1:5005");
    expect(r.ok).toBe(true);
    expect(r.latency_ms).toBeGreaterThanOrEqual(0);
    expect(r.model_name).toBe("buffalo_s");
    expect(r.model_revision).toBe("insightface-0.7.3");
    expect(r.error).toBeUndefined();
  });

  test("returns ok=false on HTTP non-2xx", async () => {
    globalThis.fetch = mock(
      async () => new Response("server error", { status: 500 }),
    ) as typeof globalThis.fetch;
    const r = await pingReid("http://127.0.0.1:5005");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("HTTP 500");
  });

  test("returns ok=false on fetch failure (timeout/network)", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof globalThis.fetch;
    const r = await pingReid("http://127.0.0.1:5005");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ECONNREFUSED");
  });

  test("disabled flag short-circuits ping (REID_ENABLED=false)", async () => {
    let fetched = false;
    globalThis.fetch = mock(async () => {
      fetched = true;
      return new Response("never", { status: 200 });
    }) as typeof globalThis.fetch;
    const r = await pingReid("http://127.0.0.1:5005", { disabled: true });
    expect(r.ok).toBe(true);
    expect(r.disabled).toBe(true);
    expect(fetched).toBe(false);
  });
});
```

- [ ] **Step 2: Run test (fail — module não existe)**

`bun --filter '@vipcam/edge' test tests/unit/api/reid/health.test.ts`

- [ ] **Step 3: Implement pingReid**

`packages/edge/src/api/reid/health.ts`:
```typescript
import type { HealthCheck } from "@vipcam/shared";

export interface ReidHealthCheck extends HealthCheck {
  model_name?: string;
  model_revision?: string;
  /** True quando REID_ENABLED=false — skip ping, ok=true (sem degradar overall). */
  disabled?: boolean;
}

/**
 * Ping síncrono ao /health do sidecar reid (Onda 7 §3.4).
 *
 * Timeout 1s — sidecar é localhost; latency normal <10ms. Se demorar mais,
 * algo está errado e degrade health pra "degraded" no /api/health.
 *
 * Sem cache — estado sempre real. /api/health é raro o suficiente pra que
 * isso não seja problema (uptime monitoring chama cada 30-60s).
 */
export async function pingReid(
  reidBaseUrl: string,
  opts: { disabled?: boolean } = {},
): Promise<ReidHealthCheck> {
  if (opts.disabled) {
    return { ok: true, disabled: true };
  }
  const t0 = Date.now();
  try {
    const r = await fetch(`${reidBaseUrl}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!r.ok) {
      return { ok: false, error: `HTTP ${r.status}` };
    }
    const body = (await r.json()) as {
      model_name?: string;
      model_revision?: string;
    };
    return {
      ok: true,
      latency_ms: Date.now() - t0,
      ...(body.model_name ? { model_name: body.model_name } : {}),
      ...(body.model_revision ? { model_revision: body.model_revision } : {}),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 4: Wire em /api/health do server.ts**

Em `packages/edge/src/api/server.ts`, dentro do handler de `/api/health`, após o bloco do `db` check e antes do loop de `getJobHealth()`:
```typescript
    // I4 + Onda 7: checks.reid sync (timeout 1s). REID_ENABLED=false →
    // disabled flag e não degrada overall status.
    const reidCheck = await pingReid(env.REID_BASE_URL, { disabled: !env.REID_ENABLED });
    checks.reid = reidCheck;
```

Import no topo:
```typescript
import { pingReid } from "./reid/health.js";
```

- [ ] **Step 5: Run tests (pass)**

```
bun --filter '@vipcam/edge' test tests/unit/api/reid/health.test.ts
bun --filter '@vipcam/edge' test  # full suite
```
Expected: 4 testes novos PASS + tudo o resto verde.

- [ ] **Step 6: Verificação smoke local (manual, se Postgres + sidecar de pé)**

```
curl -s http://127.0.0.1:4000/api/health | jq .checks.reid
```
Esperado: `{ok:true, latency_ms:N, model_name:"buffalo_s", model_revision:"insightface-0.7.3"}` (com sidecar rodando) ou `{ok:false, error:"..."}` (sem sidecar). Não é gate de CI — só pra confirmar wiring.

- [ ] **Step 7: Commit**

```bash
git add packages/edge/src/api/reid/health.ts \
        packages/edge/src/api/server.ts \
        packages/edge/tests/unit/api/reid/health.test.ts
git commit -m "feat(edge): Onda 7 — /api/health ganha checks.reid (sync ping, disabled flag pra REID_ENABLED=false)"
```

---

