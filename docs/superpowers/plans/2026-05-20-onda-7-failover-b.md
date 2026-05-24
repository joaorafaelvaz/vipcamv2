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
    import base64
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
    # Onda 7 §3.1 amend: crop_jpeg_b64 deve decodificar de volta pra JPEG válido
    crop_bytes = base64.b64decode(body["crop_jpeg_b64"])
    crop_img = Image.open(io.BytesIO(crop_bytes))
    assert crop_img.format == "JPEG"
    assert crop_img.size == (bw, bh)
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

Após o handler `warmup`, adicionar (imports adicionais: `import base64`):
```python
class EmbedResponse(BaseModel):
    embedding: list[float]  # 512 floats (normed)
    det_score: float
    infer_ms: int
    model_name: str
    model_revision: str
    # Onda 7 §3.1: crop reencoded JPEG (q=85), base64-encoded. Edge decode +
    # write em disco. Inflação ~33% sobre loopback aceitável vs alternativa
    # multipart (sacrificaria typed Pydantic).
    crop_jpeg_b64: str


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
    cropa em PIL, roda model.get() sobre o crop (detection+recognition em
    cima do rosto já isolado — mais rápido e preciso que rodar no frame
    inteiro 2688x1520), e devolve o crop serializado pra edge persistir.
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
    # Serializa crop pra edge persistir (Onda 7 §3.1 amend)
    crop_buf = io.BytesIO()
    crop.save(crop_buf, format="JPEG", quality=85)
    crop_b64 = base64.b64encode(crop_buf.getvalue()).decode("ascii")
    return EmbedResponse(
        embedding=[float(v) for v in best.normed_embedding.tolist()],
        det_score=float(best.det_score),
        infer_ms=infer_ms,
        model_name=MODEL_NAME,
        model_revision=MODEL_REVISION,
        crop_jpeg_b64=crop_b64,
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
  /** Crop reencoded JPEG q=85, base64-encoded. Edge decodifica e escreve em
   * disco via saveCrop (Onda 7 §2.1 — crop, não frame inteiro). */
  crop_jpeg_b64: string;
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
      crop_jpeg_b64: "/9j/4AAQSkZJRg==", // 1-byte JPEG b64 placeholder
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
          crop_jpeg_b64: "",
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
   * Aceita um Drizzle transaction opcional (`tx`) pra rodar DENTRO de uma
   * transação maior (caso típico: mergeInto). Quando `tx` ausente, usa o
   * connection pool normal (getDb()) — útil pra ad-hoc fixups.
   *
   * Importante: quando rodando fora de transação, race condition é possível
   * (entre UPDATE e DELETE outro insert pode mover o cap). Pra produção
   * usar dentro do mergeInto.
   */
  async transferToPerson(
    srcPersonId: string,
    dstPersonId: string,
    tx?: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  ): Promise<void> {
    const db = tx ?? getDb();
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
        crop_jpeg_b64: "/9j/4AAQSkZJRgABAQEAYABgAAD/2w==", // small valid JPEG b64
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
        crop_jpeg_b64: "/9j/4AAQSkZJRgABAQEAYABgAAD/2w==", // small valid JPEG b64
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
2. Resolve session UMA vez retornando `{sessionId, inheritedPersonId}` (single query)
3. Captura frame se evento tem bbox + REID_ENABLED + captureSnapshot fornecido
4. Chama orchestrator; **escreve o crop DEVOLVIDO pelo orchestrator (`reidOut.embedding.crop_jpeg_b64` decoded), não o frame inteiro** — preserva §2.1
5. Cria person nova se status=new_person
6. Insere detection com snapshot_path + person_id + face_attrs.reid_status/reid_distance/reid_error
7. Insere face_record se status in {strict, new_person} **E snapshotPath não-null** (não escrevemos embedding órfão sem imagem visualizável)
8. Insere reid_match_attempt(ambiguous) se status=borderline
9. Mantém recalcDominantEmotion + eventBus.publish

**Imports static** no topo do arquivo (sem `await import`):
```typescript
import type { CanonicalEvent, LiveDetectionEvent } from "@vipcam/shared";
import { eventBus } from "../api/events/event-bus.js";
import { resolvePersonIdViaReid, type ReidOutput } from "../api/reid/orchestrator.js";
import { saveCrop } from "../api/reid/snapshot-store.js";
import { getEnv } from "../config/env.js";
import type { CapturedEvent } from "../discovery/capture.js";
import { logger } from "../obs/logger.js";
import {
  detectionsRepo,
  faceRecordsRepo,
  personsRepo,
  reidMatchAttemptsRepo,
  sessionsRepo,
} from "../persistence/repositories/index.js";
import { normalize } from "./normalizer.js";
import { shouldStartNewSession } from "./session-tracker.js";
```

Código completo do `processEvent` + helper:
```typescript
const SESSION_GAP_MS = 30_000;

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
    // SINGLE call — retorna sessionId E inheritedPersonId (sessão prévia ABERTA)
    const { sessionId, inheritedPersonId } = await resolveSessionIdWithAnchor(event, detectedAt);

    // Snapshot capture + reid orchestration (apenas se temos bbox + captureSnapshot)
    let snapshotPath: string | null = null;
    let reidOut: ReidOutput | null = null;
    const detectionId = crypto.randomUUID();
    if (event.bbox && deps.captureSnapshot) {
      try {
        const frameBytes = await deps.captureSnapshot();
        reidOut = await resolvePersonIdViaReid({
          cameraId: event.camera_id,
          detectionId,
          detectedAt,
          sessionId,
          bbox: event.bbox,
          frameBytes,
          sessionInheritedPersonId: inheritedPersonId,
        });
        // Onda 7 §2.1: escrevemos o CROP devolvido pelo sidecar (não o frame
        // inteiro). embed() retorna crop_jpeg_b64 — decodificamos pra Buffer e
        // gravamos. Se reid falhou (sem embedding), pulamos o write — UI mostra
        // placeholder, sem garbage.
        if (reidOut.embedding?.crop_jpeg_b64) {
          const cropBytes = Buffer.from(reidOut.embedding.crop_jpeg_b64, "base64");
          snapshotPath = await saveCrop({
            baseDir: getEnv().SNAPSHOTS_DIR,
            detectionId,
            detectedAt,
            jpegBytes: cropBytes,
          });
        }
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

    // face_record (strict ou new_person com embedding E snapshot persistido —
    // sem snapshot não escrevemos: embedding sem imagem visualizável é débito).
    if (
      reidOut?.embedding &&
      (reidOut.status === "matched_strict" || reidOut.status === "new_person") &&
      personId &&
      snapshotPath
    ) {
      await faceRecordsRepo.insertAndEvict({
        person_id: personId,
        embedding: reidOut.embedding.embedding,
        snapshot_path: snapshotPath,
        det_score: reidOut.embedding.det_score,
        model_name: reidOut.embedding.model_name,
        model_revision: reidOut.embedding.model_revision,
        is_primary: reidOut.status === "new_person",
      });
    }

    // reid_match_attempt(ambiguous) se borderline
    if (reidOut?.status === "borderline" && reidOut.borderlineCandidate) {
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

/**
 * Helper privado — UMA query a findOpenForTrack devolvendo TANTO o sessionId
 * que vamos usar quanto o personId herdável (de detection prévia da MESMA
 * sessão aberta) pro session-inheritance fallback do reid (Onda 7 §3.5).
 *
 * Limitação documentada: se a sessão é nova (não existe sessão aberta pro
 * track), inheritedPersonId = null — não há previous-detection pra herdar.
 * Pipeline-level workaround pra reid down nessa primeira detection seria uma
 * Onda futura (sweep job).
 */
async function resolveSessionIdWithAnchor(
  event: CanonicalEvent,
  detectedAt: Date,
): Promise<{ sessionId: string; inheritedPersonId: string | null }> {
  const existing = event.track_id
    ? await sessionsRepo.findOpenForTrack(event.camera_id, event.track_id, detectedAt, SESSION_GAP_MS)
    : null;
  if (existing && !shouldStartNewSession(existing.last_seen_at, detectedAt, SESSION_GAP_MS)) {
    await sessionsRepo.appendDetection(existing.id, detectedAt);
    return { sessionId: existing.id, inheritedPersonId: existing.person_id ?? null };
  }
  const newSession: Parameters<typeof sessionsRepo.create>[0] = {
    camera_id: event.camera_id,
    person_id: null,
    started_at: detectedAt,
    last_seen_at: detectedAt,
    detection_count: 1,
  };
  if (event.track_id !== undefined) newSession.current_track_id = event.track_id;
  const created = await sessionsRepo.create(newSession);
  return { sessionId: created.id, inheritedPersonId: null };
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

## Chunk 4: Person merge + reid_match_attempts repo + endpoints

Fecha o loop humano-no-loop: `personsRepo.mergeInto` transacional (§5.2), `reidMatchAttemptsRepo` ganha `findPendingEnriched` + `resolve`, e endpoints `GET /api/matches/reid/pending` + `POST /api/matches/reid/:id/resolve` (§5.3).

**Tasks neste chunk:** 16-18 (Task 19 deferida pra Onda 7.1 — ver bloco final)
**Sequenciamento:** 16 → 17 (resolve depende de mergeInto) → 18. Tudo edge-side; UI vem em Chunk 5.

---

### Task 16: personsRepo.mergeInto (hard merge transacional)

**Spec ref:** §5.2 (locking determinístico LEAST/GREATEST + transferToPerson + rollup com GREATEST/LEAST + audit + DELETE).

**Files:**
- Modify: `packages/edge/src/persistence/repositories/persons.repo.ts`
- Test: `packages/edge/tests/integration/persistence/persons-merge.test.ts` (DB-deferred)

- [ ] **Step 1: Failing test (DB-deferred — exercita transação completa)**

`packages/edge/tests/integration/persistence/persons-merge.test.ts`:
```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { faceRecordsRepo } from "../../../src/persistence/repositories/face-records.repo.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";
import { getDb } from "../../../src/persistence/db.js";

let srcId: string;
let dstId: string;

function vec(seed: number): number[] {
  return Array.from({ length: 512 }, (_, i) => (seed * (i + 1)) / 1e6);
}

beforeEach(async () => {
  const src = await personsRepo.create({
    display_name: "Source anônima",
    person_type: "anonymous",
    first_seen_at: new Date("2026-05-15T10:00:00Z"),
    last_seen_at: new Date("2026-05-20T14:00:00Z"),
    total_visits: 3,
  });
  srcId = src.id;
  const dst = await personsRepo.create({
    display_name: "Destination cliente",
    person_type: "client",
    first_seen_at: new Date("2026-05-18T08:00:00Z"),
    last_seen_at: new Date("2026-05-19T12:00:00Z"),
    total_visits: 5,
    erp_client_id: "cliente-erp-123",
  });
  dstId = dst.id;
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`DELETE FROM person_merge_audit WHERE src_id IN (${srcId}, ${dstId}) OR dst_id IN (${srcId}, ${dstId})`);
  await db.execute(sql`DELETE FROM face_records WHERE person_id IN (${srcId}, ${dstId})`);
  await db.execute(sql`DELETE FROM persons WHERE id IN (${srcId}, ${dstId})`);
});

describe("personsRepo.mergeInto (Onda 7 §5.2)", () => {
  test("hard merge: src some, face_records migram, rollup correto, audit inserido", async () => {
    // src tem 2 face_records, dst tem 4 → após merge dst tem 5 (eviction)
    for (let i = 0; i < 2; i++) {
      await faceRecordsRepo.insertAndEvict({
        person_id: srcId,
        embedding: vec(100 + i),
        snapshot_path: `2026-05-15/src-${i}.jpg`,
        det_score: 0.9,
        model_name: "buffalo_s",
        model_revision: "insightface-0.7.3",
      });
    }
    for (let i = 0; i < 4; i++) {
      await faceRecordsRepo.insertAndEvict({
        person_id: dstId,
        embedding: vec(200 + i),
        snapshot_path: `2026-05-18/dst-${i}.jpg`,
        det_score: 0.9,
        model_name: "buffalo_s",
        model_revision: "insightface-0.7.3",
      });
    }

    await personsRepo.mergeInto(srcId, dstId, "user-test");

    // src foi deletada
    const srcAfter = await personsRepo.findById(srcId);
    expect(srcAfter).toBeNull();

    // dst absorveu rollup
    const dstAfter = await personsRepo.findById(dstId);
    expect(dstAfter).not.toBeNull();
    expect(dstAfter!.total_visits).toBe(8); // 5 + 3
    expect(dstAfter!.first_seen_at.toISOString()).toBe("2026-05-15T10:00:00.000Z"); // LEAST
    expect(dstAfter!.last_seen_at.toISOString()).toBe("2026-05-20T14:00:00.000Z"); // GREATEST

    // face_records: dst tem no máximo 5 (eviction)
    const db = getDb();
    const [{ c: dstFrCount }] = await db.execute<{ c: number }>(
      sql`SELECT count(*)::int AS c FROM face_records WHERE person_id = ${dstId}`,
    );
    expect(dstFrCount).toBe(5);

    // Audit row criada
    const audit = await db.execute<{ id: string; src_id: string; dst_id: string; merged_by: string }>(
      sql`SELECT id, src_id, dst_id, merged_by FROM person_merge_audit WHERE src_id = ${srcId} AND dst_id = ${dstId}`,
    );
    expect(audit.length).toBe(1);
    expect(audit[0].merged_by).toBe("user-test");
  });

  test("merge é idempotente (chamar 2x: a segunda chamada throws 'src já não existe')", async () => {
    await personsRepo.mergeInto(srcId, dstId, "user-1");
    await expect(personsRepo.mergeInto(srcId, dstId, "user-2")).rejects.toThrow(/not found/i);
  });

  test("merge de srcId == dstId é rejeitado (proteção contra self-merge)", async () => {
    await expect(personsRepo.mergeInto(srcId, srcId, "user")).rejects.toThrow(/same/i);
  });
});
```

- [ ] **Step 2: Run test (fail — mergeInto não existe)**

`bash packages/edge/scripts/run-integration-tests.sh tests/integration/persistence/persons-merge.test.ts`

- [ ] **Step 3: Implement mergeInto + transferToPerson reuse**

Em `packages/edge/src/persistence/repositories/persons.repo.ts`, adicionar import:
```typescript
import { faceRecordsRepo } from "./face-records.repo.js";
```
(circular import risk: persons.repo já importa nada de face-records — ok). Append ao `personsRepo` object:
```typescript
  /**
   * Hard merge transacional (Onda 7 §5.2): src some, todas as refs migram pra
   * dst, persons.dst absorve rollup de visitas, audit row inserida.
   *
   * Lock determinístico em ordem ascendente (LEAST primeiro) pra prevenir
   * deadlock entre dois operadores resolvendo merges sobrepostos.
   *
   * Subqueries posteriores ao FOR UPDATE são seguras porque srcId permanece
   * locked até COMMIT.
   */
  async mergeInto(srcId: string, dstId: string, userId: string): Promise<void> {
    if (srcId === dstId) {
      throw new Error("mergeInto: srcId and dstId are the same person");
    }
    const [leastId, greatestId] = srcId < dstId ? [srcId, dstId] : [dstId, srcId];
    await getDb().transaction(async (tx) => {
      // 1. Lock determinístico (dois statements separados — single ORDER BY IN(...) FOR UPDATE
      // não-garante ordem de lock acquisition no Postgres).
      const lockedLeast = await tx.execute<{ id: string }>(
        sql`SELECT id FROM persons WHERE id = ${leastId} FOR UPDATE`,
      );
      const lockedGreatest = await tx.execute<{ id: string }>(
        sql`SELECT id FROM persons WHERE id = ${greatestId} FOR UPDATE`,
      );
      if (lockedLeast.length === 0 || lockedGreatest.length === 0) {
        throw new Error(`mergeInto: person not found (${srcId} or ${dstId})`);
      }

      // 2. Migra refs simples (detections, sessions)
      await tx.execute(sql`UPDATE detections SET person_id = ${dstId} WHERE person_id = ${srcId}`);
      await tx.execute(sql`UPDATE sessions   SET person_id = ${dstId} WHERE person_id = ${srcId}`);

      // 3. face_records: reusa helper tx-aware (Task 11) — UPDATE + FIFO eviction
      // em dst após import (Top-K=5). DRY com insertAndEvict; mesma semântica.
      await faceRecordsRepo.transferToPerson(srcId, dstId, tx);

      // 4. Rollup das estatísticas — regras invariantes Onda 7 §5.2:
      //    - last_seen_at  = GREATEST(recência)
      //    - first_seen_at = LEAST (antiguidade)
      //    - total_visits  = soma
      //    - colunas nullable PRECISAM usar COALESCE (none aqui — todas NOT NULL).
      await tx.execute(sql`
        UPDATE persons
        SET total_visits  = persons.total_visits + (SELECT total_visits FROM persons WHERE id = ${srcId}),
            first_seen_at = LEAST(persons.first_seen_at,    (SELECT first_seen_at FROM persons WHERE id = ${srcId})),
            last_seen_at  = GREATEST(persons.last_seen_at,  (SELECT last_seen_at FROM persons WHERE id = ${srcId})),
            updated_at    = now()
        WHERE id = ${dstId}
      `);

      // 5. Audit ANTES do delete (snapshot completo de src)
      await tx.execute(sql`
        INSERT INTO person_merge_audit (src_id, dst_id, merged_at, merged_by, src_snapshot)
        VALUES (
          ${srcId}, ${dstId}, now(), ${userId},
          (SELECT row_to_json(persons.*) FROM persons WHERE id = ${srcId})
        )
      `);

      // 6. DELETE src. CASCADE em reid_match_attempts.candidate_person_id remove
      //    quaisquer rows pendentes apontando pra src (intencional — referência
      //    perdeu semântica).
      await tx.execute(sql`DELETE FROM persons WHERE id = ${srcId}`);
    });
  },
```

Adicionar import de `sql` no topo (já tem — confirmar).

- [ ] **Step 4: Run test (pass)**

`bash packages/edge/scripts/run-integration-tests.sh tests/integration/persistence/persons-merge.test.ts` → 3 PASS.

- [ ] **Step 5: Run /matches existing tests pra confirmar resolveAmbiguous não-regrediu**

`bun --filter '@vipcam/edge' test tests/unit/api/routes/matches.test.ts tests/unit/match-temp/`
(Se houver — verificar pattern de existing tests.)

- [ ] **Step 6: Commit**

```bash
git add packages/edge/src/persistence/repositories/persons.repo.ts \
        packages/edge/tests/integration/persistence/persons-merge.test.ts
git commit -m "feat(edge): Onda 7 — personsRepo.mergeInto (transacional, lock determinístico, audit + cascade)"
```

---

### Task 17: reidMatchAttemptsRepo — findPendingEnriched + resolve

**Spec ref:** §5.3 (`GET /api/matches/reid/pending` enriquecido + `POST /resolve` com merge se "matched_to_candidate").

**Files:**
- Modify: `packages/edge/src/persistence/repositories/reid-match-attempts.repo.ts`
- Create: `packages/shared/src/types/reid-pending.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/edge/tests/integration/persistence/reid-match-attempts-repo.test.ts` (DB-deferred)

- [ ] **Step 1: Create shared types pra envelope enriquecido**

`packages/shared/src/types/reid-pending.ts`:
```typescript
/** Item retornado por GET /api/matches/reid/pending — junta detection nova
 * com candidate face_record + person, pra UI mostrar side-by-side. */
export interface ReidMatchPendingEnriched {
  id: string; // reid_match_attempt.id
  distance: number;
  decided_at: string; // ISO
  detection: {
    id: string;
    detected_at: string;
    snapshot_path: string | null;
    camera_id: string;
  };
  candidate: {
    face_record_id: string;
    person_id: string;
    snapshot_path: string; // face_records.snapshot_path (NOT NULL no schema)
    person_display_name: string | null;
    person_type: "client" | "employee" | "anonymous";
  };
}

/** Decision de POST /api/matches/reid/:id/resolve */
export type ReidResolveDecision = "matched_to_candidate" | "rejected_new_person";
```

E export em `packages/shared/src/index.ts`:
```typescript
export * from "./types/reid-pending.js";
```

- [ ] **Step 2: Failing test (DB-deferred)**

`packages/edge/tests/integration/persistence/reid-match-attempts-repo.test.ts`:
```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { detectionsRepo } from "../../../src/persistence/repositories/detections.repo.js";
import { faceRecordsRepo } from "../../../src/persistence/repositories/face-records.repo.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";
import { reidMatchAttemptsRepo } from "../../../src/persistence/repositories/reid-match-attempts.repo.js";
import { sessionsRepo } from "../../../src/persistence/repositories/sessions.repo.js";
import { getDb } from "../../../src/persistence/db.js";

function vec(s: number): number[] {
  return Array.from({ length: 512 }, (_, i) => (s * (i + 1)) / 1e6);
}

let cameraId: string;
let candidatePersonId: string;
let detectionId: string;
let frId: string;
let attemptId: string;

beforeEach(async () => {
  const db = getDb();
  const [cam] = await db.execute<{ id: string }>(sql`
    INSERT INTO cameras (id, name) VALUES (gen_random_uuid(), 'test-cam')
    RETURNING id
  `);
  cameraId = cam.id;

  const candP = await personsRepo.create({
    display_name: "João Cliente",
    person_type: "client",
  });
  candidatePersonId = candP.id;

  const fr = await faceRecordsRepo.insertAndEvict({
    person_id: candidatePersonId,
    embedding: vec(1),
    snapshot_path: "2026-05-15/cand.jpg",
    det_score: 0.9,
    model_name: "buffalo_s",
    model_revision: "insightface-0.7.3",
  });
  frId = fr.id;

  const sess = await sessionsRepo.create({
    camera_id: cameraId,
    person_id: null,
    started_at: new Date("2026-05-20T14:00:00Z"),
    last_seen_at: new Date("2026-05-20T14:00:00Z"),
    detection_count: 1,
  });
  const det = await detectionsRepo.create({
    camera_id: cameraId,
    person_id: null,
    session_id: sess.id,
    face_attrs: { reid_status: "borderline", reid_distance: 0.45 },
    detected_at: new Date("2026-05-20T14:00:00Z"),
    raw_event: { test: true },
    snapshot_path: "2026-05-20/det-new.jpg",
  });
  detectionId = det.id;

  const att = await reidMatchAttemptsRepo.createAmbiguous({
    detection_id: detectionId,
    candidate_face_record_id: frId,
    candidate_person_id: candidatePersonId,
    distance: 0.45,
  });
  attemptId = att.id;
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`DELETE FROM reid_match_attempts WHERE detection_id = ${detectionId}`);
  await db.execute(sql`DELETE FROM detections WHERE id = ${detectionId}`);
  await db.execute(sql`DELETE FROM face_records WHERE id = ${frId}`);
  await db.execute(sql`DELETE FROM persons WHERE id = ${candidatePersonId}`);
  await db.execute(sql`DELETE FROM sessions WHERE camera_id = ${cameraId}`);
  await db.execute(sql`DELETE FROM cameras WHERE id = ${cameraId}`);
});

describe("reidMatchAttemptsRepo.findPendingEnriched", () => {
  test("retorna ambiguous joined com detection + face_record + person", async () => {
    const items = await reidMatchAttemptsRepo.findPendingEnriched(50);
    const ours = items.find((i) => i.id === attemptId);
    expect(ours).toBeDefined();
    expect(ours!.distance).toBe(0.45);
    expect(ours!.detection.id).toBe(detectionId);
    expect(ours!.detection.snapshot_path).toBe("2026-05-20/det-new.jpg");
    expect(ours!.candidate.face_record_id).toBe(frId);
    expect(ours!.candidate.person_id).toBe(candidatePersonId);
    expect(ours!.candidate.snapshot_path).toBe("2026-05-15/cand.jpg");
    expect(ours!.candidate.person_display_name).toBe("João Cliente");
    expect(ours!.candidate.person_type).toBe("client");
  });

  test("respeita limit + DESC order", async () => {
    // criar mais 2 attempts
    for (let i = 0; i < 2; i++) {
      const det = await detectionsRepo.create({
        camera_id: cameraId,
        person_id: null,
        session_id: null,
        face_attrs: {},
        detected_at: new Date(`2026-05-20T15:0${i}:00Z`),
        raw_event: {},
      });
      await reidMatchAttemptsRepo.createAmbiguous({
        detection_id: det.id,
        candidate_face_record_id: frId,
        candidate_person_id: candidatePersonId,
        distance: 0.4 + i * 0.02,
      });
    }
    const limited = await reidMatchAttemptsRepo.findPendingEnriched(2);
    expect(limited.length).toBe(2);
    // DESC: mais novos primeiro
    expect(new Date(limited[0].decided_at).getTime()).toBeGreaterThanOrEqual(
      new Date(limited[1].decided_at).getTime(),
    );
  });
});

describe("reidMatchAttemptsRepo.resolve", () => {
  test("matched_to_candidate: chama mergeInto(detection.person_id → candidate.person_id) — mas detection.person_id=null aqui", async () => {
    // Esse cenário é uma sutileza: borderline NÃO cria person nova,
    // detection vai com person_id=null. resolve(matched_to_candidate)
    // significa "esta detection nova pertence ao candidate" — então
    // UPDATE detection.person_id = candidate.person_id (sem merge — não há person src).
    await reidMatchAttemptsRepo.resolve(attemptId, "matched_to_candidate", "user-1");
    const db = getDb();
    const [{ pid }] = await db.execute<{ pid: string }>(
      sql`SELECT person_id AS pid FROM detections WHERE id = ${detectionId}`,
    );
    expect(pid).toBe(candidatePersonId);
    const [{ d, by }] = await db.execute<{ d: string; by: string }>(
      sql`SELECT decision AS d, decided_by AS by FROM reid_match_attempts WHERE id = ${attemptId}`,
    );
    expect(d).toBe("matched_to_candidate");
    expect(by).toBe("user");
  });

  test("rejected_new_person: cria anonymous nova + atribui detection a ela", async () => {
    await reidMatchAttemptsRepo.resolve(attemptId, "rejected_new_person", "user-2");
    const db = getDb();
    const [{ pid }] = await db.execute<{ pid: string | null }>(
      sql`SELECT person_id AS pid FROM detections WHERE id = ${detectionId}`,
    );
    expect(pid).not.toBeNull();
    expect(pid).not.toBe(candidatePersonId);
    // person nova é anonymous
    const newP = await personsRepo.findById(pid!);
    expect(newP?.person_type).toBe("anonymous");
    // limpeza extra (afterEach não pega a person nova criada)
    await db.execute(sql`DELETE FROM persons WHERE id = ${pid}`);
  });
});
```

- [ ] **Step 3: Run test (fail — métodos não existem)**

`bash packages/edge/scripts/run-integration-tests.sh tests/integration/persistence/reid-match-attempts-repo.test.ts`

- [ ] **Step 4: Implement findPendingEnriched + resolve**

Em `packages/edge/src/persistence/repositories/reid-match-attempts.repo.ts`, append ao `reidMatchAttemptsRepo`:
```typescript
import { and, desc, eq, sql } from "drizzle-orm";
import type { ReidMatchPendingEnriched, ReidResolveDecision } from "@vipcam/shared";
import { detections } from "../schema/detections.js";
import { faceRecords } from "../schema/face-records.js";
import { persons } from "../schema/persons.js";
import { personsRepo } from "./persons.repo.js";

// (... createAmbiguous existente acima ...)

  /**
   * Lista reid_match_attempts ambiguous enriquecidos com detection + face_record +
   * candidate person, em DESC por decided_at. Cap em `limit` (UI default 50).
   */
  async findPendingEnriched(limit: number): Promise<ReidMatchPendingEnriched[]> {
    const rows = await getDb()
      .select({
        id: reidMatchAttempts.id,
        distance: reidMatchAttempts.distance,
        decided_at: reidMatchAttempts.decided_at,
        det_id: detections.id,
        det_detected_at: detections.detected_at,
        det_snapshot_path: detections.snapshot_path,
        det_camera_id: detections.camera_id,
        fr_id: faceRecords.id,
        fr_person_id: faceRecords.person_id,
        fr_snapshot_path: faceRecords.snapshot_path,
        p_display_name: persons.display_name,
        p_person_type: persons.person_type,
      })
      .from(reidMatchAttempts)
      .innerJoin(detections, eq(detections.id, reidMatchAttempts.detection_id))
      .innerJoin(faceRecords, eq(faceRecords.id, reidMatchAttempts.candidate_face_record_id))
      .innerJoin(persons, eq(persons.id, reidMatchAttempts.candidate_person_id))
      .where(eq(reidMatchAttempts.decision, "ambiguous"))
      .orderBy(desc(reidMatchAttempts.decided_at))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      distance: r.distance,
      decided_at: r.decided_at.toISOString(),
      detection: {
        id: r.det_id,
        detected_at: r.det_detected_at.toISOString(),
        snapshot_path: r.det_snapshot_path,
        camera_id: r.det_camera_id,
      },
      candidate: {
        face_record_id: r.fr_id,
        person_id: r.fr_person_id,
        snapshot_path: r.fr_snapshot_path,
        person_display_name: r.p_display_name,
        person_type: r.p_person_type,
      },
    }));
  },

  /**
   * Resolve um reid_match_attempt ambiguous.
   *
   * - `matched_to_candidate`: detection nova pertence ao candidate person.
   *   Se detection.person_id já existe (cenário raro pós-borderline com
   *   inheritance), chamamos mergeInto(detection.person_id, candidate.person_id).
   *   Senão UPDATE detection.person_id = candidate.person_id (sem person src
   *   pra merge — borderline NÃO cria person, detection vai null).
   *
   * - `rejected_new_person`: cria person anonymous nova, UPDATE detection
   *   apontando pra ela. (Operador disse "pessoas diferentes" — borderline
   *   tomou o caminho 'new_person' depois do fato.)
   */
  async resolve(
    attemptId: string,
    decision: ReidResolveDecision,
    userId: string,
  ): Promise<void> {
    const db = getDb();
    // Lookup do attempt + detection + candidate
    const [att] = await db
      .select({
        detection_id: reidMatchAttempts.detection_id,
        candidate_person_id: reidMatchAttempts.candidate_person_id,
        det_current_person_id: detections.person_id,
        det_detected_at: detections.detected_at,
      })
      .from(reidMatchAttempts)
      .innerJoin(detections, eq(detections.id, reidMatchAttempts.detection_id))
      .where(and(
        eq(reidMatchAttempts.id, attemptId),
        eq(reidMatchAttempts.decision, "ambiguous"),
      ))
      .limit(1);

    if (!att) {
      throw new Error(`reid_match_attempt ${attemptId} not found or not ambiguous`);
    }

    if (decision === "matched_to_candidate") {
      if (att.det_current_person_id && att.det_current_person_id !== att.candidate_person_id) {
        // Cenário raro: detection já tem person (via inheritance ou
        // resolve anterior). Merge a antiga em candidate.
        await personsRepo.mergeInto(att.det_current_person_id, att.candidate_person_id, userId);
      } else {
        // Caso comum: detection.person_id era null, só atribui.
        await db.execute(sql`
          UPDATE detections SET person_id = ${att.candidate_person_id}
          WHERE id = ${att.detection_id}
        `);
        // incrementa visit count pra refletir a visita
        await personsRepo.incrementVisitCount(att.candidate_person_id, att.det_detected_at);
      }
    } else {
      // rejected_new_person: cria anonymous + atribui
      const newPerson = await personsRepo.create({
        person_type: "anonymous",
        first_seen_at: att.det_detected_at,
        last_seen_at: att.det_detected_at,
      });
      await db.execute(sql`
        UPDATE detections SET person_id = ${newPerson.id}
        WHERE id = ${att.detection_id}
      `);
    }

    // Marca attempt resolvido
    await db.execute(sql`
      UPDATE reid_match_attempts
      SET decision = ${decision}, decided_by = 'user', decided_at = now()
      WHERE id = ${attemptId}
    `);
  },
```

- [ ] **Step 5: Run tests (pass)**

`bash packages/edge/scripts/run-integration-tests.sh tests/integration/persistence/reid-match-attempts-repo.test.ts` → 4 PASS (2 find + 2 resolve).

- [ ] **Step 6: Commit**

```bash
git add packages/edge/src/persistence/repositories/reid-match-attempts.repo.ts \
        packages/shared/src/types/reid-pending.ts \
        packages/shared/src/index.ts \
        packages/edge/tests/integration/persistence/reid-match-attempts-repo.test.ts
git commit -m "feat(edge): Onda 7 — reidMatchAttemptsRepo.findPendingEnriched + resolve (merge/reject) + shared types"
```

---

### Task 18: API routes — GET /api/matches/reid/pending + POST /:id/resolve

**Spec ref:** §5.3 (endpoints).

**Files:**
- Create: `packages/edge/src/api/routes/matches-reid.ts`
- Modify: `packages/edge/src/api/server.ts` (mount route + auth via `apiKeyMiddleware`)
- Test: `packages/edge/tests/unit/api/routes/matches-reid.test.ts`

- [ ] **Step 1: Failing test**

`packages/edge/tests/unit/api/routes/matches-reid.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import type { ReidMatchPendingEnriched } from "@vipcam/shared";
import { createMatchesReidRoutes } from "../../../../src/api/routes/matches-reid.js";

const fakeItem: ReidMatchPendingEnriched = {
  id: "rma-1",
  distance: 0.45,
  decided_at: "2026-05-20T14:00:00Z",
  detection: {
    id: "det-1",
    detected_at: "2026-05-20T14:00:00Z",
    snapshot_path: "2026-05-20/det-1.jpg",
    camera_id: "cam-1",
  },
  candidate: {
    face_record_id: "fr-1",
    person_id: "p-1",
    snapshot_path: "2026-05-15/cand.jpg",
    person_display_name: "João",
    person_type: "client",
  },
};

function app(deps: {
  findPending: (limit: number) => Promise<ReidMatchPendingEnriched[]>;
  resolve: (id: string, decision: string, userId: string) => Promise<void>;
}) {
  return createMatchesReidRoutes(deps);
}

describe("GET /pending", () => {
  test("default limit=50", async () => {
    let received: number | undefined;
    const r = await app({
      findPending: async (l) => {
        received = l;
        return [fakeItem];
      },
      resolve: async () => undefined,
    }).request("/pending");
    expect(r.status).toBe(200);
    expect(received).toBe(50);
    expect(await r.json()).toEqual([fakeItem]);
  });

  test("limit=200 boundary OK", async () => {
    const r = await app({
      findPending: async () => [],
      resolve: async () => undefined,
    }).request("/pending?limit=200");
    expect(r.status).toBe(200);
  });

  test("invalid limit → 400", async () => {
    for (const bad of ["0", "201", "-1", "abc", "1.5"]) {
      const r = await app({
        findPending: async () => [],
        resolve: async () => undefined,
      }).request(`/pending?limit=${bad}`);
      expect(r.status).toBe(400);
    }
  });
});

describe("POST /:id/resolve", () => {
  test("matched_to_candidate → 204", async () => {
    let calls: Array<[string, string, string]> = [];
    const r = await app({
      findPending: async () => [],
      resolve: async (id, decision, user) => {
        calls.push([id, decision, user]);
      },
    }).request("/rma-1/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "matched_to_candidate" }),
    });
    expect(r.status).toBe(204);
    expect(calls).toEqual([["rma-1", "matched_to_candidate", "system"]]);
  });

  test("rejected_new_person → 204", async () => {
    let received: string | undefined;
    const r = await app({
      findPending: async () => [],
      resolve: async (_id, decision) => {
        received = decision;
      },
    }).request("/rma-2/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "rejected_new_person" }),
    });
    expect(r.status).toBe(204);
    expect(received).toBe("rejected_new_person");
  });

  test("decision inválida → 400", async () => {
    const r = await app({
      findPending: async () => [],
      resolve: async () => undefined,
    }).request("/rma-1/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "something_else" }),
    });
    expect(r.status).toBe(400);
  });

  test("resolve throws → 409 Conflict (race condition: já resolvido)", async () => {
    const r = await app({
      findPending: async () => [],
      resolve: async () => {
        throw new Error("not found or not ambiguous");
      },
    }).request("/rma-1/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "matched_to_candidate" }),
    });
    expect(r.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run test (fail — module não existe)**

`bun --filter '@vipcam/edge' test tests/unit/api/routes/matches-reid.test.ts`

- [ ] **Step 3: Implement route**

`packages/edge/src/api/routes/matches-reid.ts`:
```typescript
import type { ReidMatchPendingEnriched, ReidResolveDecision } from "@vipcam/shared";
import { Hono } from "hono";

export interface MatchesReidDeps {
  findPending: (limit: number) => Promise<ReidMatchPendingEnriched[]>;
  /** userId é placeholder "system" enquanto NextAuth não chega (Onda futura). */
  resolve: (id: string, decision: ReidResolveDecision, userId: string) => Promise<void>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const VALID_DECISIONS: ReidResolveDecision[] = ["matched_to_candidate", "rejected_new_person"];

/**
 * Reid borderline review endpoints (Onda 7 §5.3).
 *
 * Auth via apiKeyMiddleware aplicado em /api/matches/* no server.ts (já existe
 * pra aba temporal). userId placeholder "system" porque NextAuth é Onda futura.
 */
export function createMatchesReidRoutes(deps: MatchesReidDeps): Hono {
  const r = new Hono();

  r.get("/pending", async (c) => {
    const raw = c.req.query("limit");
    let limit = DEFAULT_LIMIT;
    if (raw !== undefined) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
        return c.json({ error: `limit must be 1..${MAX_LIMIT}` }, 400);
      }
      limit = n;
    }
    return c.json(await deps.findPending(limit));
  });

  r.post("/:id/resolve", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const decision = body?.decision;
    if (!decision || !VALID_DECISIONS.includes(decision)) {
      return c.json({ error: `decision must be one of ${VALID_DECISIONS.join("|")}` }, 400);
    }
    try {
      await deps.resolve(id, decision, "system");
      return new Response(null, { status: 204 });
    } catch (err) {
      // Race: outro operador resolveu primeiro, ou attempt já mudou de estado.
      // Trata como 409 Conflict — UI deve refresh.
      return c.json(
        { error: err instanceof Error ? err.message : "conflict" },
        409,
      );
    }
  });

  return r;
}
```

- [ ] **Step 4: Mount no server.ts**

Em `packages/edge/src/api/server.ts`, após o mount existente de `/api/matches`:
```typescript
import { createMatchesReidRoutes } from "./routes/matches-reid.js";
import { reidMatchAttemptsRepo } from "../persistence/repositories/index.js";

// (... dentro de createServer, após app.route("/api/matches", ...) ...)
app.route(
  "/api/matches/reid",
  createMatchesReidRoutes({
    findPending: (limit) => reidMatchAttemptsRepo.findPendingEnriched(limit),
    resolve: (id, decision, userId) => reidMatchAttemptsRepo.resolve(id, decision, userId),
  }),
);
```

`apiKeyMiddleware` aplicado em `/api/matches/*` já cobre o `/reid` subpath — sem mudança adicional.

- [ ] **Step 5: Run test (pass)**

`bun --filter '@vipcam/edge' test tests/unit/api/routes/matches-reid.test.ts` → 7 PASS.

- [ ] **Step 6: Run full edge tests**

`bun --filter '@vipcam/edge' test`
Expected: tudo verde.

- [ ] **Step 7: Commit**

```bash
git add packages/edge/src/api/routes/matches-reid.ts \
        packages/edge/src/api/server.ts \
        packages/edge/tests/unit/api/routes/matches-reid.test.ts
git commit -m "feat(edge): Onda 7 — GET /api/matches/reid/pending + POST /:id/resolve (auth herdado de /matches/*)"
```

---

## Chunk 5: Web UI (Reid borderline tab) + Final verification

Fecha o loop usuário. UI `/matches` ganha aba "Reid borderline" reaproveitando o pattern existente (lista à esquerda, detalhe à direita). React Query hook + side-by-side cards (snapshot detection vs snapshot face_record). Task final é validação completa offline + DB-deferred + smoke checklist pra deploy.

**Tasks neste chunk:** 19-22 (mantém numeração contínua, Task 19 deferida vira o bloco DEFERIDA mais abaixo)
**Sequenciamento:** 19 → 20 → 21 → 22.

---

### Task 19w: useReidPending + useResolveReid hooks

> **Nota:** Tasks dentro do Chunk 5 são prefixadas `w` (web) pra distinguir do bloco deferido §5.1. Sequencial mas independente do numero da Task 19 deferida.

**Spec ref:** §5.4 (UI ganha aba); §5.5 (REID_ENABLED=false → banner).

**Files:**
- Create: `packages/web/src/lib/queries/reid-matches.ts`
- Test: `packages/web/tests/unit/lib/queries-reid-matches.test.tsx`

- [ ] **Step 1: Failing test**

`packages/web/tests/unit/lib/queries-reid-matches.test.tsx`:
```typescript
// NOTA (bun:test mock.module process-wide leakage, herdado da Onda 8):
// re-registra api-client mock no beforeEach. Em isolado passa 3/3; no
// full suite pode haver flicker — documentado.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReidMatchPendingEnriched } from "@vipcam/shared";
import * as React from "react";

let returnRows: ReidMatchPendingEnriched[] = [];
let postCalls: Array<{ url: string; body: unknown }> = [];

const installMocks = () =>
  mock.module("../../../src/lib/api-client", () => ({
    apiFetch: async (url: string, opts?: { method?: string; body?: unknown }) => {
      if (opts?.method === "POST") {
        postCalls.push({ url, body: opts.body });
        return undefined;
      }
      return returnRows;
    },
    snapshotUrl: (p: string | null) => (p ? `/snapshots/${p}` : null),
    ApiError: class extends Error {},
  }));
installMocks();

import { useReidPending, useResolveReid } from "../../../src/lib/queries/reid-matches";

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

function PendingProbe() {
  const q = useReidPending(50);
  return <div data-testid="count">{q.data?.length ?? 0}</div>;
}

beforeEach(() => {
  returnRows = [];
  postCalls = [];
  installMocks();
});

describe("useReidPending", () => {
  test("fetches /api/matches/reid/pending?limit=50", async () => {
    returnRows = [
      {
        id: "rma-1",
        distance: 0.45,
        decided_at: "2026-05-20T14:00:00Z",
        detection: { id: "d1", detected_at: "x", snapshot_path: null, camera_id: "c1" },
        candidate: {
          face_record_id: "fr1",
          person_id: "p1",
          snapshot_path: "x.jpg",
          person_display_name: "João",
          person_type: "client",
        },
      },
    ];
    const qc = makeClient();
    render(
      <QueryClientProvider client={qc}>
        <PendingProbe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("1"));
  });
});

describe("useResolveReid", () => {
  test("POST /api/matches/reid/:id/resolve com decision", async () => {
    const qc = makeClient();
    let resolveFn: ((d: { id: string; decision: string }) => void) | null = null;
    function Probe() {
      const m = useResolveReid();
      React.useEffect(() => {
        resolveFn = (d) => m.mutate(d as { id: string; decision: "matched_to_candidate" | "rejected_new_person" });
      }, [m]);
      return null;
    }
    render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>);
    await waitFor(() => expect(resolveFn).not.toBeNull());
    resolveFn!({ id: "rma-1", decision: "matched_to_candidate" });
    await waitFor(() => expect(postCalls.length).toBe(1));
    expect(postCalls[0].url).toBe("/api/matches/reid/rma-1/resolve");
    expect(postCalls[0].body).toEqual({ decision: "matched_to_candidate" });
  });
});
```

- [ ] **Step 2: Run test (fail — hooks não existem)**

`cd packages/web && bun test tests/unit/lib/queries-reid-matches.test.tsx`

- [ ] **Step 3: Implement hooks**

`packages/web/src/lib/queries/reid-matches.ts`:
```typescript
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReidMatchPendingEnriched, ReidResolveDecision } from "@vipcam/shared";
import { apiFetch } from "../api-client";

export function useReidPending(limit = 50) {
  return useQuery<ReidMatchPendingEnriched[]>({
    queryKey: ["reid-matches", "pending", limit],
    queryFn: () => apiFetch<ReidMatchPendingEnriched[]>(`/api/matches/reid/pending?limit=${limit}`),
  });
}

export function useResolveReid() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: ReidResolveDecision }) =>
      apiFetch<void>(`/api/matches/reid/${id}/resolve`, {
        method: "POST",
        body: { decision },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reid-matches", "pending"] });
    },
  });
}
```

- [ ] **Step 4: Run test (pass)**

`cd packages/web && bun test tests/unit/lib/queries-reid-matches.test.tsx` → 2 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/queries/reid-matches.ts \
        packages/web/tests/unit/lib/queries-reid-matches.test.tsx
git commit -m "feat(web): Onda 7 — useReidPending + useResolveReid hooks"
```

---

### Task 20w: ReidMatchCard component (side-by-side)

**Spec ref:** §5.4 (snapshot detection vs snapshot face_record, distance, dois botões).

**Files:**
- Create: `packages/web/src/components/reid-match-card.tsx`
- Test: `packages/web/tests/unit/components/reid-match-card.test.tsx`

- [ ] **Step 1: Failing test**

`packages/web/tests/unit/components/reid-match-card.test.tsx`:
```typescript
import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReidMatchPendingEnriched } from "@vipcam/shared";
import * as React from "react";
import { ReidMatchCard } from "../../../src/components/reid-match-card";

const item: ReidMatchPendingEnriched = {
  id: "rma-1",
  distance: 0.45,
  decided_at: "2026-05-20T14:00:00Z",
  detection: {
    id: "d1",
    detected_at: "2026-05-20T14:00:00Z",
    snapshot_path: "2026-05-20/d1.jpg",
    camera_id: "c1",
  },
  candidate: {
    face_record_id: "fr1",
    person_id: "p1",
    snapshot_path: "2026-05-15/fr1.jpg",
    person_display_name: "João Cliente",
    person_type: "client",
  },
};

describe("ReidMatchCard", () => {
  test("renders both snapshots + distance + candidate name", () => {
    render(<ReidMatchCard item={item} onResolve={() => {}} loading={false} />);
    expect(screen.getByText("João Cliente")).toBeDefined();
    expect(screen.getByText(/0\.45/)).toBeDefined();
    const images = screen.getAllByRole("img");
    expect(images.length).toBe(2); // detection + candidate
  });

  test("disabled buttons when loading=true", () => {
    render(<ReidMatchCard item={item} onResolve={() => {}} loading={true} />);
    const buttons = screen.getAllByRole("button");
    for (const b of buttons) expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  test("fires onResolve with 'matched_to_candidate' when 'Mesma pessoa' clicked", async () => {
    const user = userEvent.setup();
    let received: { id: string; decision: string } | null = null;
    render(
      <ReidMatchCard
        item={item}
        onResolve={(p) => {
          received = p;
        }}
        loading={false}
      />,
    );
    await user.click(screen.getByText(/mesma pessoa/i));
    expect(received).toEqual({ id: "rma-1", decision: "matched_to_candidate" });
  });

  test("fires onResolve with 'rejected_new_person' when 'Pessoas diferentes' clicked", async () => {
    const user = userEvent.setup();
    let received: { id: string; decision: string } | null = null;
    render(
      <ReidMatchCard
        item={item}
        onResolve={(p) => {
          received = p;
        }}
        loading={false}
      />,
    );
    await user.click(screen.getByText(/pessoas diferentes/i));
    expect(received).toEqual({ id: "rma-1", decision: "rejected_new_person" });
  });
});
```

- [ ] **Step 2: Run test (fail — componente não existe)**

`cd packages/web && bun test tests/unit/components/reid-match-card.test.tsx`

- [ ] **Step 3: Implement component**

`packages/web/src/components/reid-match-card.tsx`:
```tsx
"use client";
import { Button } from "@/components/ui/button";
import { snapshotUrl } from "@/lib/api-client";
import type { ReidMatchPendingEnriched, ReidResolveDecision } from "@vipcam/shared";

export interface ReidMatchCardProps {
  item: ReidMatchPendingEnriched;
  onResolve: (params: { id: string; decision: ReidResolveDecision }) => void;
  loading: boolean;
}

export function ReidMatchCard({ item, onResolve, loading }: ReidMatchCardProps) {
  const detSrc = snapshotUrl(item.detection.snapshot_path);
  const candSrc = snapshotUrl(item.candidate.snapshot_path);

  return (
    <div className="p-6">
      <div className="grid grid-cols-2 gap-6 mb-4">
        <figure>
          <figcaption className="text-sm font-semibold mb-2">Detecção nova</figcaption>
          {detSrc ? (
            <img src={detSrc} alt="detection" className="w-full rounded border" />
          ) : (
            <div className="aspect-square bg-slate-100 rounded flex items-center justify-center text-slate-400">
              sem snapshot
            </div>
          )}
        </figure>
        <figure>
          <figcaption className="text-sm font-semibold mb-2">
            Candidato:{" "}
            <span className="font-bold">{item.candidate.person_display_name ?? "anônima"}</span>
            <span className="text-xs text-slate-500 ml-2">({item.candidate.person_type})</span>
          </figcaption>
          {candSrc ? (
            <img src={candSrc} alt="candidate" className="w-full rounded border" />
          ) : (
            <div className="aspect-square bg-slate-100 rounded flex items-center justify-center text-slate-400">
              sem snapshot
            </div>
          )}
        </figure>
      </div>

      <div className="text-sm text-slate-600 mb-4">
        Distância cosine: <span className="font-mono">{item.distance.toFixed(3)}</span>
        {" — "}
        revisado pra: <span className="font-mono">{new Date(item.decided_at).toLocaleString()}</span>
      </div>

      <div className="flex gap-2">
        <Button
          onClick={() => onResolve({ id: item.id, decision: "matched_to_candidate" })}
          disabled={loading}
          variant="default"
        >
          Mesma pessoa
        </Button>
        <Button
          onClick={() => onResolve({ id: item.id, decision: "rejected_new_person" })}
          disabled={loading}
          variant="outline"
        >
          Pessoas diferentes
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test (pass)**

`cd packages/web && bun test tests/unit/components/reid-match-card.test.tsx` → 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/reid-match-card.tsx \
        packages/web/tests/unit/components/reid-match-card.test.tsx
git commit -m "feat(web): Onda 7 — ReidMatchCard component (side-by-side + 2 botões)"
```

---

### Task 21w: /matches page ganha tabs (Temporal / Reid borderline)

**Spec ref:** §5.4 (aba nova co-existe com temporal).

**Files:**
- Modify: `packages/web/src/app/matches/page.tsx`

> **Nota:** este task NÃO escreve test novo (a page é integração — componentes já testados). Smoke visual via build + manual no browser.

- [ ] **Step 1: Refactor page.tsx pra usar Tabs**

Substituir `packages/web/src/app/matches/page.tsx`:
```tsx
"use client";

import { ReidMatchCard } from "@/components/reid-match-card";
import { MatchDetail } from "@/components/match-detail";
import { MatchListItem } from "@/components/match-list-item";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMatchesPending } from "@/lib/queries/matches";
import { useReidPending, useResolveReid } from "@/lib/queries/reid-matches";
import { useState } from "react";

export const dynamic = "force-dynamic";

export default function MatchesPage() {
  // Temporal (existente, Onda 3)
  const { data: temporal, isLoading: tLoading } = useMatchesPending();
  const [selectedTemporalId, setSelectedTemporalId] = useState<string | null>(null);
  const temporalList = temporal ?? [];
  const selectedTemporal =
    temporalList.find((m) => m.match_attempt_id === selectedTemporalId) ?? temporalList[0];

  // Reid borderline (Onda 7)
  const { data: reid, isLoading: rLoading } = useReidPending(50);
  const resolveReid = useResolveReid();
  const reidList = reid ?? [];

  return (
    <div className="container mx-auto p-6">
      <h1 className="text-2xl font-semibold mb-4">Matches pendentes</h1>

      <Tabs defaultValue="temporal" className="w-full">
        <TabsList>
          <TabsTrigger value="temporal">
            Temporal ({tLoading ? "…" : temporalList.length})
          </TabsTrigger>
          <TabsTrigger value="reid">
            Reid borderline ({rLoading ? "…" : reidList.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="temporal">
          <div className="bg-white border rounded-md flex" style={{ minHeight: 500 }}>
            <aside className="w-72 border-r overflow-y-auto" style={{ maxHeight: 600 }}>
              <div className="p-2 font-semibold border-b text-sm">
                {tLoading
                  ? "carregando…"
                  : `${temporalList.length} pendente${temporalList.length === 1 ? "" : "s"}`}
              </div>
              {tLoading ? (
                <div className="p-2"><Skeleton className="h-12" /></div>
              ) : temporalList.length === 0 ? (
                <div className="p-4 text-slate-500 text-sm text-center">
                  Nenhum match pendente — tudo resolvido!
                </div>
              ) : (
                temporalList.map((m) => (
                  <MatchListItem
                    key={m.match_attempt_id}
                    match={m}
                    active={selectedTemporal?.match_attempt_id === m.match_attempt_id}
                    onClick={() => setSelectedTemporalId(m.match_attempt_id)}
                  />
                ))
              )}
            </aside>
            <section className="flex-1">
              {selectedTemporal ? (
                <MatchDetail match={selectedTemporal} />
              ) : (
                <div className="p-8 text-slate-500 italic text-center">
                  Selecione um match na lista
                </div>
              )}
            </section>
          </div>
        </TabsContent>

        <TabsContent value="reid">
          <div className="bg-white border rounded-md" style={{ minHeight: 500 }}>
            {rLoading ? (
              <div className="p-4"><Skeleton className="h-32" /></div>
            ) : reidList.length === 0 ? (
              <div className="p-8 text-slate-500 text-sm text-center italic">
                Nenhum borderline pendente — calibração funcionando!
              </div>
            ) : (
              <div className="divide-y">
                {reidList.map((item) => (
                  <ReidMatchCard
                    key={item.id}
                    item={item}
                    onResolve={(params) => resolveReid.mutate(params)}
                    loading={resolveReid.isPending}
                  />
                ))}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

> **Pré-requisito:** componente Tabs do shadcn. Se não existir, gerar via shadcn-ui CLI:
> `bunx shadcn-ui@latest add tabs`

- [ ] **Step 2: Build + smoke manual**

```
bun --filter '@vipcam/web' run build
```
Expected: build OK, `/matches` aparece como route compilável.

- [ ] **Step 3: Run web full suite (sanity)**

```
cd packages/web && bun test
```
Expected: tests existentes + os 6 novos (Task 19w+20w) verdes (modulo flickiness conhecida de mock.module).

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/app/matches/page.tsx \
        packages/web/src/components/ui/tabs.tsx
git commit -m "feat(web): Onda 7 — /matches ganha aba Reid borderline (tabs Temporal/Reid)"
```

---

### Task 22w: Final verification + offline gates + smoke checklist

**Spec ref:** §8 (deploy + calibração); §9 (Onda 7 fechada quando).

**Files:** nenhum novo — só verificação.

- [ ] **Step 1: Offline gates completos**

```
bun --filter '*' typecheck       # 3/3 (shared + edge + web)
bun run lint                     # exit 0
bun --filter '@vipcam/edge' test # full edge unit suite
cd packages/web && bun test      # full web unit suite
bun --filter '@vipcam/web' run build
```
Expected:
- typecheck 3/3 ✓
- lint exit 0 (warnings pré-existentes ignoradas) ✓
- edge unit: previous total + Onda 7 novos (~25+ novos entre Chunks 1-4) ✓
- web unit: previous + Onda 7 novos (~6 novos Chunk 5) ✓
- web build ✓

- [ ] **Step 2: DB-deferred tests (manualmente — exige Postgres com migrations Onda 7)**

```
cd packages/edge
bash scripts/run-integration-tests.sh tests/integration/persistence/face-records-repo.test.ts
bash scripts/run-integration-tests.sh tests/integration/api/reid/match-policy-ann.test.ts
bash scripts/run-integration-tests.sh tests/integration/persistence/persons-merge.test.ts
bash scripts/run-integration-tests.sh tests/integration/persistence/reid-match-attempts-repo.test.ts
```
Expected: todos PASS contra Postgres + pgvector com migrations 0005/0006/0007 aplicadas. Total: ~13 testes DB-deferred.

- [ ] **Step 3: Sidecar pytest (regression + Onda 7)**

```
cd packages/reid
pytest tests/ -v
```
Expected: tests existentes (`/detect`) + Onda 7 (`test_embed.py`: 4 PASS + 1 SKIP sem fixture face).

- [ ] **Step 4: Smoke pré-deploy (local com sidecar + Postgres rodando)**

```
# 1. /api/health expõe checks.reid + checks.scheduler_snapshot_retention
curl -s -H "X-API-Key: $KEY" http://127.0.0.1:4000/api/health | jq '.checks | {reid, scheduler_snapshot_retention}'
# 2. /api/matches/reid/pending responde array
curl -s -H "X-API-Key: $KEY" http://127.0.0.1:4000/api/matches/reid/pending | jq length
# 3. /snapshots/2026-05-20/<id>.jpg responde 200 (com arquivo) ou 404 (sem)
curl -i http://127.0.0.1:4000/snapshots/2026-05-20/nonexistent.jpg
# Esperado: 404 + {"error":"not_found"}
```

- [ ] **Step 5: Commit (sem mudança de código — vazio OK ou pular)**

Nada a commitar — é um checkpoint. Pular este step.

- [ ] **Step 6: Pré-merge sanity**

```
git log --oneline master..HEAD | head -30
git diff master --stat | tail -5
```
Esperado: ~25 commits da Onda 7 + ~3 do spec/plan. Diff incluindo:
- packages/edge (schemas, repos, api/reid/*, ingest/pipeline, scheduler, env, server)
- packages/reid (main.py, tests)
- packages/web (queries, components, app/matches)
- packages/shared (types reid)
- infra/systemd
- docs/superpowers/specs + plans

- [ ] **Step 7: Operational follow-up (post-merge)**

Após merge + push + deploy.sh no VPS:

1. **`systemctl restart vipcam-reid` + verificar logs:**
```
journalctl -u vipcam-reid -n 50 --no-pager
# Esperado: ExecStartPost curl OK + ~5.5s cold start no boot
```

2. **`systemctl restart vipcam-edge` + verificar logs:**
```
journalctl -u vipcam-edge -n 50 --no-pager
# Esperado: "scheduler started (employees=hourly, clients=15min, checkins=30s, snapshot_retention=daily-03:00)"
```

3. **Smokes em produção:**
```
KEY=$(sudo grep '^API_KEY=' /etc/vipcam/edge.env | cut -d= -f2)
curl -s -H "X-API-Key: $KEY" https://monitoramento.franquiabv.com.br/api/health | jq .checks
# Esperado: checks.reid.ok=true + checks.scheduler_snapshot_retention

# Aguardar primeira detection real:
curl -s -H "X-API-Key: $KEY" https://monitoramento.franquiabv.com.br/api/events/recent?limit=3 | jq '.[].detection.snapshot_path'
# Esperado: paths não-null (eg "2026-05-20/<uuid>.jpg")

# Abrir /live no browser: cards com rostos recortados visíveis.
# Abrir /matches → aba "Reid borderline" funcional.
```

4. **Janela de calibração (§8):**
   - Acompanhar diariamente por 7 dias: `journalctl -u vipcam-edge | grep -E "reid_status|reid_distance"` agregado por status.
   - Triggers de ajuste: borderline > 30% → loosen LOOSE pra 0.60. Strict vs ERP contradiction > 10% → tighten STRICT pra 0.30.
   - Tuning via `/etc/vipcam/edge.env` + `systemctl restart vipcam-edge`.

5. **Após 7 dias estável:** criar `docs/superpowers/specs/2026-05-NN-onda-7-failover-b-report.md` com:
   - Thresholds finais
   - Distribuição (strict/borderline/new/unavailable %)
   - Resoluções de borderline (count + merges aprovados)
   - Decisão: continuar como está / iniciar Onda 7.1 (§5.1 rows 3-5)

---

## Onda 7 — bloco de tasks deferidas (Onda 7.1)

### Task 19: DEFERIDA — match temporal reid-aware (§5.1 rows 3-5)

**Status:** Removida desta onda. Spec §5.1 atualizado pra marcar rows 3-5 (conflito reid+ERP) como **Onda 7.1**.

**Razão da deferral:** implementação real exige:
1. Nova query `detectionsRepo.findInWindow(start, end)` (atualmente só `findAnonymousInWindow` existe — exclui detections com `person_id != null`, ou seja, detections já identificadas por reid nunca aparecem na janela de checkin).
2. Refactor de `processCheckin` pra iterar por detection (atualmente `decideMatch` retorna UMA decisão por window).
3. Workflow novo na UI `/matches` aba temporal — "esta detection já tem person W, ERP sugere Y, humano confirma merge ou reject" — escopo de design + componentes que não cabem em Chunk 5 da Onda 7.

**Risco aceito durante calibração:** se reid produzir false-positive em produção (linka detection ao person errado), o checkin do person correto NÃO cria ambiguous (porque a detection já tem `person_id`, então `findAnonymousInWindow` não a retorna). Erro fica silencioso até notar manualmente.

**Mitigação:** §8 calibração — durante os primeiros 7 dias, monitorar `strict matches contradicting ERP > 10%` (operador revisa entradas reid e ERP do mesmo dia). Se gatilhar, Onda 7.1 implementa rows 3-5.

**Onda 7.1 quando iniciar:**
- Task 19a: `detectionsRepo.findInWindow` + DB-deferred test.
- Task 19b: `processCheckin` refactor pra loop per-detection + 4 testes do §5.1 table.
- Task 19c: UI workflow "divergent reid+ERP" na aba temporal `/matches`.

---

