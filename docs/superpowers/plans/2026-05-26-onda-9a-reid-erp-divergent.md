# Onda 9-A — Reid vs ERP Divergent Resolution — Implementation Plan

> **For agentic workers:** REQUIRED: Use **superpowers:subagent-driven-development** (if subagents available) or **superpowers:executing-plans** to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar §5.1 rows 3-5 do spec da Onda 7: quando reid já identificou uma detection antes do checkin ERP chegar, processar os 3 cenários (NO-OP convergent, AMBIGUOUS anonymous→client, AMBIGUOUS client→client).

**Architecture:** 1 migration (2 colunas em `match_attempts`), nova query `findInWindow` substituindo `findAnonymousInWindow`, refactor de `processCheckin` em 2 passes (clássico + divergent), bifurcação in-place de `resolveAmbiguous` delegando pra novo helper `resolveDivergent` (que reusa `personsRepo.mergeInto` da Onda 7). UI: 1 warning block condicional em `match-detail.tsx`. Forward-only deploy.

**Tech Stack:**
- Edge: Bun + Hono + Drizzle ORM + Postgres + pgvector (sem mudança no sidecar reid)
- Web: Next.js 14 + React Query + shadcn/ui + happy-dom (bun:test)
- Deploy: systemd unit `vipcam-edge` restart pega migrations no startup automático

**Spec base:** `docs/superpowers/specs/2026-05-26-onda-9a-reid-erp-divergent-design.md` (commit `55a7eb0`, approved 3-round review)

**Branch:** `onda-9a-reid-erp-divergent` (já existe; 2 commits do spec).

---

## File Structure

### Edge (`packages/edge/`)
**Modify:**
- `src/persistence/schema/match-attempts.ts` — adicionar `previous_person_id` + `previous_person_snapshot`
- `src/persistence/repositories/detections.repo.ts` — adicionar `findInWindow()`; manter `findAnonymousInWindow` deprecated com comentário (verificar callers via grep)
- `src/match-temp/orchestrator.ts` — refactor `processCheckin` em 2-pass (classic clássico via decideMatch existente + per-detection divergent)
- `src/match-temp/review.ts` — estender `ResolveErrorCode` enum + bifurcar `resolveAmbiguous` no top + adicionar helper interno `resolveDivergent`
- `src/api/match-pending.ts` — aliasedTable de persons pra LEFT JOIN duplo; mapper adiciona `previous_person` no envelope
- `src/api/routes/matches.ts` — mapping de HTTP status pros novos `ResolveErrorCode`

**Generated:**
- `src/persistence/migrations/0008_*.sql` — drizzle-kit gera

**Test (create):**
- `tests/unit/persistence/schema-match-attempts-prev.test.ts` — schema invariants
- `tests/integration/match-temp/divergent.test.ts` — 4 cenários do §5.1 (DB-deferred)
- `tests/unit/match-temp/resolve-divergent.test.ts` — bifurcation logic com mocks
- `tests/integration/api/match-pending-prev.test.ts` — enrichment com previous_person (DB-deferred)
- `tests/unit/api/routes/matches-resolve-errors.test.ts` — HTTP status mapping

### Shared (`packages/shared/`)
**Modify:**
- `src/types/index.ts` (ou onde MatchPendingEnriched estiver — verificar) — adicionar `previous_person?` opcional

### Web (`packages/web/`)
**Modify:**
- `src/components/match-detail.tsx` — warning block condicional + textos dos botões adaptativos
- `src/lib/queries/matches.ts` — sem mudança esperada (consome shared type)

**Test (create):**
- `tests/unit/components/match-detail-divergent.test.tsx` — renderização condicional + edge cases

---

## Chunk 1: Schema + Pipeline + Resolve Backend

Camada de dados e backend de detecção/resolve. Sai com schema novo, pipeline 2-pass, e endpoint `/resolve` bifurcado — tudo testável via integration + curl, sem UI.

**Tasks:** 1-5.
**Sequência estrita:** 1 (schema) → 2 (findInWindow) → 3 (orchestrator) → 4 (review bifurcation) → 5 (route handler).

---

### Task 1: Schema migration — match_attempts.previous_person_id + previous_person_snapshot

**Spec ref:** §3.

**Files:**
- Modify: `packages/edge/src/persistence/schema/match-attempts.ts`
- Generated: `packages/edge/src/persistence/migrations/0008_*.sql`
- Test: `packages/edge/tests/unit/persistence/schema-match-attempts-prev.test.ts` (create)

- [ ] **Step 1: Failing test**

`packages/edge/tests/unit/persistence/schema-match-attempts-prev.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { matchAttempts } from "../../../src/persistence/schema/match-attempts.js";

describe("match_attempts schema Onda 9-A", () => {
  test("has previous_person_id (nullable FK)", () => {
    expect((matchAttempts as unknown as Record<string, unknown>).previous_person_id).toBeDefined();
  });

  test("has previous_person_snapshot (jsonb nullable)", () => {
    expect((matchAttempts as unknown as Record<string, unknown>).previous_person_snapshot).toBeDefined();
  });

  test("previous_person_id is NOT notNull (must be nullable)", () => {
    const col = (matchAttempts as unknown as { previous_person_id: { notNull?: boolean } }).previous_person_id;
    expect(col.notNull).not.toBe(true);
  });
});
```

- [ ] **Step 2: Run test (fail)**

`cd packages/edge && bun test tests/unit/persistence/schema-match-attempts-prev.test.ts`
Expected: 3 fails (columns undefined).

- [ ] **Step 3: Add columns to Drizzle schema**

Em `packages/edge/src/persistence/schema/match-attempts.ts`, dentro do `pgTable("match_attempts", { ... })`, adicionar após o último campo existente (provavelmente `notes`):
```typescript
// Onda 9-A: presente apenas em divergent ambiguous (detection.person_id !=
// null no momento do orchestrator detectar conflito reid+ERP).
previous_person_id: uuid("previous_person_id")
  .references(() => persons.id, { onDelete: "set null" }),
// Snapshot denormalizado de W (sobrevive a mergeInto futuro de W que zera
// o FK via SET NULL). Espelha pattern de person_merge_audit.src_snapshot.
previous_person_snapshot: jsonb("previous_person_snapshot")
  .$type<Record<string, unknown>>(),
```

Imports adicionais no topo do arquivo:
```typescript
import { jsonb, ... } from "drizzle-orm/pg-core";    // adicionar jsonb à lista existente
import { persons } from "./persons.js";              // novo import — necessário p/ .references()
```

(`uuid` já vem da lista atual do `drizzle-orm/pg-core`. Verifica `persons.ts` p/ confirmar que não importa de `match-attempts.ts` antes de adicionar — circular import quebraria o module loader.)

- [ ] **Step 4: Run test (pass)**

`cd packages/edge && bun test tests/unit/persistence/schema-match-attempts-prev.test.ts` → 3 PASS.

- [ ] **Step 5: Generate migration**

`cd packages/edge && bun run db:generate`
Expected: cria `0008_*.sql` com `ALTER TABLE "match_attempts" ADD COLUMN "previous_person_id" uuid` + `ADD COLUMN "previous_person_snapshot" jsonb` + FK constraint pra persons com ON DELETE SET NULL.

> **Importante:** verificar SQL gerado tem o `ON DELETE SET NULL` correto. Drizzle às vezes omite e default vira NO ACTION — se omitido, editar manualmente o arquivo gerado pra adicionar.

- [ ] **Step 6: Apply migration locally (DB-deferred OK)**

`cd packages/edge && bun run db:migrate`
Se Postgres local não-disponível, marcar como DB-deferred (VPS aplica no startup do edge pós-deploy).

- [ ] **Step 7: Commit**

```bash
git add packages/edge/src/persistence/schema/match-attempts.ts \
        packages/edge/src/persistence/migrations/0008_*.sql \
        packages/edge/src/persistence/migrations/meta/0008_snapshot.json \
        packages/edge/src/persistence/migrations/meta/_journal.json \
        packages/edge/tests/unit/persistence/schema-match-attempts-prev.test.ts
git commit -m "feat(edge): Onda 9-A — match_attempts ganha previous_person_id + previous_person_snapshot"
```

---

### Task 2: detectionsRepo.findInWindow

**Spec ref:** §4.1.

**Files:**
- Modify: `packages/edge/src/persistence/repositories/detections.repo.ts`
- Test: `packages/edge/tests/integration/persistence/detections-find-in-window.test.ts` (create — DB-deferred)

- [ ] **Step 1: Failing test (DB-deferred)**

`packages/edge/tests/integration/persistence/detections-find-in-window.test.ts`:
```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { detectionsRepo } from "../../../src/persistence/repositories/detections.repo.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";
import { sessionsRepo } from "../../../src/persistence/repositories/sessions.repo.js";
import { getDb } from "../../../src/persistence/db.js";

let cameraId: string;
let personId: string;

beforeEach(async () => {
  const db = getDb();
  const [cam] = await db.execute<{ id: string }>(sql`
    INSERT INTO cameras (id, name) VALUES (gen_random_uuid(), 'test-cam-fw')
    RETURNING id
  `);
  cameraId = cam.id;
  const p = await personsRepo.create({ display_name: "Test" });
  personId = p.id;
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`DELETE FROM detections WHERE camera_id = ${cameraId}`);
  await db.execute(sql`DELETE FROM sessions WHERE camera_id = ${cameraId}`);
  await db.execute(sql`DELETE FROM persons WHERE id = ${personId}`);
  await db.execute(sql`DELETE FROM cameras WHERE id = ${cameraId}`);
});

describe("detectionsRepo.findInWindow", () => {
  test("retorna ambas detections NULL e non-NULL person_id na janela", async () => {
    const sess = await sessionsRepo.create({
      camera_id: cameraId,
      person_id: null,
      started_at: new Date("2026-05-26T14:00:00Z"),
      last_seen_at: new Date("2026-05-26T14:00:00Z"),
      detection_count: 2,
    });
    await detectionsRepo.create({
      camera_id: cameraId,
      person_id: null,                      // anonymous
      session_id: sess.id,
      face_attrs: {},
      detected_at: new Date("2026-05-26T14:00:00Z"),
      raw_event: {},
    });
    await detectionsRepo.create({
      camera_id: cameraId,
      person_id: personId,                  // identified
      session_id: sess.id,
      face_attrs: {},
      detected_at: new Date("2026-05-26T14:01:00Z"),
      raw_event: {},
    });

    const rows = await detectionsRepo.findInWindow(
      new Date("2026-05-26T13:55:00Z"),
      new Date("2026-05-26T14:05:00Z"),
    );
    const inCamera = rows.filter((r) => r.id);
    expect(inCamera.length).toBeGreaterThanOrEqual(2);
    const nullCount = inCamera.filter((r) => r.person_id === null).length;
    const identifiedCount = inCamera.filter((r) => r.person_id === personId).length;
    expect(nullCount).toBeGreaterThanOrEqual(1);
    expect(identifiedCount).toBeGreaterThanOrEqual(1);
  });

  test("fora da janela não retorna", async () => {
    await detectionsRepo.create({
      camera_id: cameraId,
      person_id: null,
      session_id: null,
      face_attrs: {},
      detected_at: new Date("2026-05-26T12:00:00Z"),    // 2h antes
      raw_event: {},
    });
    const rows = await detectionsRepo.findInWindow(
      new Date("2026-05-26T13:55:00Z"),
      new Date("2026-05-26T14:05:00Z"),
    );
    const myDet = rows.find((r) => r.detected_at.getTime() === new Date("2026-05-26T12:00:00Z").getTime());
    expect(myDet).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test (fail — method não existe)**

`bash packages/edge/scripts/run-integration-tests.sh tests/integration/persistence/detections-find-in-window.test.ts`

- [ ] **Step 3: Implement findInWindow**

Em `packages/edge/src/persistence/repositories/detections.repo.ts`, dentro do `detectionsRepo` object, adicionar (espelhar pattern do `findAnonymousInWindow` existente):
```typescript
  /**
   * Onda 9-A: substitui findAnonymousInWindow no orchestrator. Retorna TODAS
   * as detections na janela (NULL + non-NULL person_id) pra suportar §5.1
   * rows 3-5 (conflito reid+ERP divergente).
   *
   * findAnonymousInWindow continua existindo se outros callers usarem (grep
   * antes de deletar); marcar deprecated se único caller for o orchestrator.
   */
  async findInWindow(start: Date, end: Date): Promise<Array<{
    id: string;
    detected_at: Date;
    person_id: string | null;
    snapshot_path: string | null;
  }>> {
    return getDb()
      .select({
        id: detections.id,
        detected_at: detections.detected_at,
        person_id: detections.person_id,
        snapshot_path: detections.snapshot_path,
      })
      .from(detections)
      .where(and(
        gte(detections.detected_at, start),
        lte(detections.detected_at, end),
      ))
      .orderBy(detections.detected_at);
  },
```

Imports adicionais no topo se necessário: `and, gte, lte` de drizzle-orm (provavelmente já tem).

- [ ] **Step 4: Run test (pass)**

`bash packages/edge/scripts/run-integration-tests.sh tests/integration/persistence/detections-find-in-window.test.ts` → 2 PASS (DB-deferred OK).

- [ ] **Step 5: Verify callers de findAnonymousInWindow**

```bash
cd packages/edge && grep -rn "findAnonymousInWindow" src/ tests/
```
Esperado: 1 ou 2 callers (provavelmente só `match-temp/matcher.ts` via `decideMatch`). Se único caller é o orchestrator, marcar findAnonymousInWindow como `@deprecated` com JSDoc apontando pra findInWindow.

- [ ] **Step 6: Commit**

```bash
git add packages/edge/src/persistence/repositories/detections.repo.ts \
        packages/edge/tests/integration/persistence/detections-find-in-window.test.ts
git commit -m "feat(edge): Onda 9-A — detectionsRepo.findInWindow (sem filtro NULL person_id)"
```

---

### Task 3: orchestrator.processCheckin refactor (2-pass)

**Spec ref:** §4.2.

**Files:**
- Modify: `packages/edge/src/match-temp/orchestrator.ts`
- Test: `packages/edge/tests/integration/match-temp/divergent.test.ts` (create — DB-deferred)

- [ ] **Step 1: Failing test — 4 cenários do §5.1 (DB-deferred)**

`packages/edge/tests/integration/match-temp/divergent.test.ts`:
```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { processCheckin } from "../../../src/match-temp/orchestrator.js";
import { detectionsRepo } from "../../../src/persistence/repositories/detections.repo.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";
import { sessionsRepo } from "../../../src/persistence/repositories/sessions.repo.js";
import { getDb } from "../../../src/persistence/db.js";

let cameraId: string;
let clientY_personId: string;
let anonX_personId: string;
let clientW_personId: string;
let checkinErpId: string;

beforeEach(async () => {
  const db = getDb();
  const [cam] = await db.execute<{ id: string }>(sql`
    INSERT INTO cameras (id, name) VALUES (gen_random_uuid(), 'test-cam-div')
    RETURNING id
  `);
  cameraId = cam.id;

  // Cliente do ERP (Y) com person já cadastrado
  await db.execute(sql`
    INSERT INTO erp_clients (erp_id, name, is_active)
    VALUES ('cli-y', 'Maria', true)
    ON CONFLICT (erp_id) DO UPDATE SET name = EXCLUDED.name
  `);
  const y = await personsRepo.create({
    display_name: "Maria",
    person_type: "client",
    erp_client_id: "cli-y",
  });
  clientY_personId = y.id;

  // Anônima X (reid criou)
  const x = await personsRepo.create({
    display_name: null,
    person_type: "anonymous",
  });
  anonX_personId = x.id;

  // Cliente W (reid auto-matched errado — diferente do checkin)
  await db.execute(sql`
    INSERT INTO erp_clients (erp_id, name, is_active)
    VALUES ('cli-w', 'Wagner', true)
    ON CONFLICT (erp_id) DO UPDATE SET name = EXCLUDED.name
  `);
  const w = await personsRepo.create({
    display_name: "Wagner",
    person_type: "client",
    erp_client_id: "cli-w",
  });
  clientW_personId = w.id;

  // Checkin: cliente Y no horário T
  checkinErpId = `chk-${Date.now()}`;
  await db.execute(sql`
    INSERT INTO erp_checkins (erp_id, erp_client_id, event_type, occurred_at, metadata)
    VALUES (${checkinErpId}, 'cli-y', 'in', ${new Date("2026-05-26T14:00:00Z")}, '{}')
  `);
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`DELETE FROM match_attempts WHERE erp_checkin_id = ${checkinErpId}`);
  await db.execute(sql`DELETE FROM detections WHERE camera_id = ${cameraId}`);
  await db.execute(sql`DELETE FROM sessions WHERE camera_id = ${cameraId}`);
  await db.execute(sql`DELETE FROM persons WHERE id IN (${clientY_personId}, ${anonX_personId}, ${clientW_personId})`);
  await db.execute(sql`DELETE FROM erp_clients WHERE erp_id IN ('cli-y', 'cli-w')`);
  await db.execute(sql`DELETE FROM erp_checkins WHERE erp_id = ${checkinErpId}`);
  await db.execute(sql`DELETE FROM cameras WHERE id = ${cameraId}`);
});

async function makeDetection(personId: string | null, detectedAt: Date) {
  return detectionsRepo.create({
    camera_id: cameraId,
    person_id: personId,
    session_id: null,
    face_attrs: {},
    detected_at: detectedAt,
    raw_event: {},
  });
}

async function loadCheckin() {
  const db = getDb();
  const [r] = await db.execute<{
    erp_id: string;
    erp_client_id: string;
    event_type: string;
    occurred_at: Date;
    metadata: Record<string, unknown>;
    processed_at: Date | null;
  }>(sql`SELECT * FROM erp_checkins WHERE erp_id = ${checkinErpId}`);
  return r;
}

async function getMatchAttempts() {
  const db = getDb();
  return db.execute<{
    detection_id: string | null;
    decision: string;
    previous_person_id: string | null;
  }>(sql`SELECT detection_id, decision, previous_person_id FROM match_attempts WHERE erp_checkin_id = ${checkinErpId}`);
}

describe("processCheckin divergent (Onda 9-A §5.1)", () => {
  test("Row 3: detection já == cliente Y do checkin → NO-OP (zero match_attempts)", async () => {
    await makeDetection(clientY_personId, new Date("2026-05-26T14:00:30Z"));
    await processCheckin(await loadCheckin());
    const attempts = await getMatchAttempts();
    expect(attempts.length).toBe(0);
  });

  test("Row 4: detection anonymous X + checkin sugere Y → ambiguous com previous_person_id=X", async () => {
    const det = await makeDetection(anonX_personId, new Date("2026-05-26T14:00:30Z"));
    await processCheckin(await loadCheckin());
    const attempts = await getMatchAttempts();
    expect(attempts.length).toBe(1);
    expect(attempts[0].decision).toBe("ambiguous");
    expect(attempts[0].previous_person_id).toBe(anonX_personId);
    expect(attempts[0].detection_id).toBe(det.id);
  });

  test("Row 5: detection cliente W + checkin sugere cliente Y → ambiguous com previous_person_id=W", async () => {
    const det = await makeDetection(clientW_personId, new Date("2026-05-26T14:00:30Z"));
    await processCheckin(await loadCheckin());
    const attempts = await getMatchAttempts();
    expect(attempts.length).toBe(1);
    expect(attempts[0].decision).toBe("ambiguous");
    expect(attempts[0].previous_person_id).toBe(clientW_personId);
  });

  test("Row 1: 1 detection NULL na janela → auto-match clássico (não toca caminho novo)", async () => {
    const det = await makeDetection(null, new Date("2026-05-26T14:00:30Z"));
    await processCheckin(await loadCheckin());
    const attempts = await getMatchAttempts();
    expect(attempts.length).toBe(1);
    expect(attempts[0].decision).toBe("auto_matched");
    expect(attempts[0].previous_person_id).toBeNull();
    const updated = await detectionsRepo.findById(det.id);
    expect(updated?.person_id).toBe(clientY_personId);
  });
});
```

- [ ] **Step 2: Run test (fail — lógica nova não-implementada)**

`bash packages/edge/scripts/run-integration-tests.sh tests/integration/match-temp/divergent.test.ts`

- [ ] **Step 3: Implement refactor**

> **Pré-requisito:** ler `packages/edge/src/match-temp/orchestrator.ts` inteiro antes de editar. O código atual JÁ tem `db.transaction` wrapping (C1, review 2026-05-13). A versão nova DEVE preservar isso — todos os WRITES (Pass 1 + Pass 2 + update processed_at) ficam dentro do mesmo `tx`. Também usa `detectionsRepo.linkToPerson(detectionId, personId)` (confirmado), `decideMatch(anonymousDetectionIds: readonly string[])` (assina array de strings, retorna `{decision, chosen_detection_id}`), e bootstrap de Person quando `persons.erp_client_id` ausente (lê de `erpClients` e cria — preservar esse comportamento).

Reescrita completa de `processCheckin` (substitui a função inteira, preservando contrato existente):

```typescript
export async function processCheckin(checkin: ErpCheckin): Promise<void> {
  if (checkin.processed_at) return;
  const env = getEnv();
  const window = computeWindow(checkin.occurred_at, env.MATCH_WINDOW_SECONDS);

  // Onda 9-A: pega TODAS as detections na window (não só anônimas)
  const allInWindow = await detectionsRepo.findInWindow(window.start, window.end);
  const anonymous = allInWindow.filter((d) => d.person_id === null);
  const identified = allInWindow.filter((d) => d.person_id !== null);

  // Pass 1 clássico (preserva semântica Onda 2/3): decideMatch sobre IDs anônimos
  const classic = decideMatch(anonymous.map((d) => d.id));

  await getDb().transaction(async (tx) => {
    // Bootstrap candidatePerson DENTRO da transaction (preserva atomicity do
    // INSERT persons + linkToPerson). Reusa lookup persons.erp_client_id; se
    // ausente, materializa de erp_clients (mesmo pattern do código atual).
    const [existing] = await tx
      .select()
      .from(persons)
      .where(eq(persons.erp_client_id, checkin.erp_client_id))
      .limit(1);

    let candidatePerson = existing ?? null;
    if (!candidatePerson) {
      const [erpClient] = await tx
        .select()
        .from(erpClients)
        .where(eq(erpClients.erp_id, checkin.erp_client_id))
        .limit(1);
      const [created] = await tx
        .insert(persons)
        .values({
          person_type: "client",
          display_name: erpClient?.name ?? "Cliente",
          erp_client_id: checkin.erp_client_id,
        })
        .returning();
      if (!created) throw new Error("persons insert returned no row");
      candidatePerson = created;
    }

    // Pass 1: clássico
    if (classic.decision === "auto_matched" && classic.chosen_detection_id) {
      const det = anonymous.find((d) => d.id === classic.chosen_detection_id);
      if (!det) {
        throw new Error(
          `auto_matched chose ${classic.chosen_detection_id} but detection not in anonymous list`,
        );
      }
      await tx.insert(matchAttempts).values({
        detection_id: classic.chosen_detection_id,
        erp_checkin_id: checkin.erp_id,
        decision: "auto_matched",
        decided_by: "system",
      });
      await tx
        .update(detections)
        .set({ person_id: candidatePerson.id })
        .where(eq(detections.id, classic.chosen_detection_id));
      if (det.session_id) {
        await tx
          .update(sessions)
          .set({ person_id: candidatePerson.id, linked_erp_checkin_id: checkin.erp_id })
          .where(eq(sessions.id, det.session_id));
      }
    } else if (classic.decision === "ambiguous") {
      await tx.insert(matchAttempts).values({
        // ambiguous clássico não fixa detection (UI escolhe na revisão)
        erp_checkin_id: checkin.erp_id,
        decision: "ambiguous",
        decided_by: "system",
        notes: `${anonymous.length} candidates`,
        // previous_person_id default NULL = signal de "caso clássico"
      });
    }
    // 'rejected' clássico (0 anônimas) = no-op de WRITE; Pass 2 abaixo ainda roda.

    // Pass 2: divergent (Onda 9-A novo) — uma linha por detection identificada ≠ Y
    for (const det of identified) {
      if (det.person_id === candidatePerson.id) continue; // Row 3: NO-OP convergent
      // Rows 4-5: ambiguous divergente. Snapshot denormaliza W p/ sobreviver
      // a futuro SET NULL caso W seja merged/deletado depois.
      const [prevPerson] = await tx
        .select()
        .from(persons)
        .where(eq(persons.id, det.person_id as string))
        .limit(1);
      await tx.insert(matchAttempts).values({
        detection_id: det.id,
        erp_checkin_id: checkin.erp_id,
        decision: "ambiguous",
        decided_by: "system",
        previous_person_id: det.person_id,
        previous_person_snapshot: prevPerson as unknown as Record<string, unknown>,
      });
    }

    // Marca checkin processed (ÚLTIMA write — se falhar, transação inteira reverte)
    await tx
      .update(erpCheckins)
      .set({ processed_at: sql`now()` })
      .where(eq(erpCheckins.erp_id, checkin.erp_id));
  });

  logger.info(
    {
      checkin: checkin.erp_id,
      classic_decision: classic.decision,
      anonymous: anonymous.length,
      identified: identified.length,
    },
    "match temporal decision (2-pass)",
  );
}
```

Imports verificados (já presentes no arquivo atual, manter): `eq`, `sql` de `drizzle-orm`; `getDb`; `detectionsRepo`, `erpRepo`; `detections`, `erpCheckins`, `erpClients`, `matchAttempts`, `persons`, `sessions`; `decideMatch`, `computeWindow`, `getEnv`, `logger`. **Nada novo a importar** — a refatoração só rearranja a lógica já alcançável.

Atualizar o JSDoc da função (linhas 14-37 do arquivo atual) p/ refletir 2-pass + previous_person_id semantics. Mencionar Onda 9-A explicitamente.

- [ ] **Step 4: Run test (pass)**

`bash packages/edge/scripts/run-integration-tests.sh tests/integration/match-temp/divergent.test.ts` → 4 PASS.

- [ ] **Step 5: Run existing match-temp tests pra confirmar regressão zero**

`cd packages/edge && bun test tests/unit/match-temp/ tests/integration/match-temp/`
Expected: tudo verde (caminho clássico mantido via decideMatch existente).

- [ ] **Step 6: Commit**

```bash
git add packages/edge/src/match-temp/orchestrator.ts \
        packages/edge/tests/integration/match-temp/divergent.test.ts
git commit -m "feat(edge): Onda 9-A — processCheckin refactor 2-pass (clássico + divergent)"
```

---

### Task 4: review.ts resolveAmbiguous bifurcation + ResolveErrorCode extension

**Spec ref:** §4.3.

**Files:**
- Modify: `packages/edge/src/match-temp/review.ts`
- Test: `packages/edge/tests/unit/match-temp/resolve-divergent.test.ts` (create)

- [ ] **Step 1: Failing test (mocks de repos)**

`packages/edge/tests/unit/match-temp/resolve-divergent.test.ts`:
```typescript
import { beforeEach, describe, expect, mock, test } from "bun:test";

// NOTA bun:test mock.module process-wide leakage — installMocks re-registra
// em beforeEach pra defender contra ordem de execução do suite.
let attemptReturn: Record<string, unknown> | null = null;
let prevPersonReturn: Record<string, unknown> | null = null;
let mergeIntoCalls: Array<[string, string, string]> = [];
let mergeIntoThrow: Error | null = null;
let resolveAmbigCalls: Array<[string, string, string?]> = [];

const installMocks = () => {
  mock.module("../../../src/persistence/repositories/match-attempts.repo.js", () => ({
    matchAttemptsRepo: {
      resolveAmbiguous: async (id: string, detId: string, notes?: string) => {
        resolveAmbigCalls.push([id, detId, notes]);
      },
      rejectAmbiguous: async () => undefined,
    },
  }));
  mock.module("../../../src/persistence/repositories/persons.repo.js", () => ({
    personsRepo: {
      findById: async () => prevPersonReturn,
      mergeInto: async (src: string, dst: string, user: string) => {
        mergeIntoCalls.push([src, dst, user]);
        if (mergeIntoThrow) throw mergeIntoThrow;
      },
    },
  }));
  mock.module("../../../src/persistence/db.js", () => ({
    getDb: () => ({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (attemptReturn ? [attemptReturn] : []),
          }),
        }),
      }),
    }),
  }));
};
installMocks();

import { ResolveError, resolveAmbiguous } from "../../../src/match-temp/review.js";

beforeEach(() => {
  attemptReturn = null;
  prevPersonReturn = null;
  mergeIntoCalls = [];
  mergeIntoThrow = null;
  resolveAmbigCalls = [];
  installMocks();
});

describe("resolveAmbiguous divergent bifurcation (Onda 9-A)", () => {
  test("previous_person_id != null + W ≠ Y → calls mergeInto + resolveAmbiguous", async () => {
    attemptReturn = {
      id: "att-1",
      decision: "ambiguous",
      detection_id: "det-1",
      erp_checkin_id: "chk-1",
      previous_person_id: "p-W",
    };
    prevPersonReturn = { id: "p-W", display_name: "W" };
    await resolveAmbiguous("att-1", "det-1", "p-Y");
    expect(mergeIntoCalls).toEqual([["p-W", "p-Y", "system"]]);
    expect(resolveAmbigCalls.length).toBe(1);
    expect(resolveAmbigCalls[0][0]).toBe("att-1");
  });

  test("previous_person_id == chosenPersonId (stale W==Y) → no mergeInto, marks resolved", async () => {
    attemptReturn = {
      id: "att-2",
      decision: "ambiguous",
      detection_id: "det-2",
      previous_person_id: "p-Y",  // ← já é Y
    };
    await resolveAmbiguous("att-2", "det-2", "p-Y");
    expect(mergeIntoCalls.length).toBe(0);
    expect(resolveAmbigCalls.length).toBe(1);
  });

  test("previous_person_id != null + W not found → ResolveError 'previous_person_gone'", async () => {
    attemptReturn = {
      id: "att-3",
      decision: "ambiguous",
      previous_person_id: "p-W-deleted",
    };
    prevPersonReturn = null;  // W foi deletada
    await expect(resolveAmbiguous("att-3", "det-3", "p-Y")).rejects.toThrow(ResolveError);
    expect(mergeIntoCalls.length).toBe(0);
  });

  test("mergeInto throws 'not found' → ResolveError 'concurrent_merge'", async () => {
    attemptReturn = {
      id: "att-4",
      decision: "ambiguous",
      previous_person_id: "p-W",
    };
    prevPersonReturn = { id: "p-W" };
    mergeIntoThrow = new Error("mergeInto: person not found (p-W or p-Y)");
    await expect(resolveAmbiguous("att-4", "det-4", "p-Y")).rejects.toMatchObject({
      code: "concurrent_merge",
    });
  });

  test("decision != ambiguous → already_resolved", async () => {
    attemptReturn = { id: "att-5", decision: "auto_matched" };
    await expect(resolveAmbiguous("att-5", "det-5", "p-Y")).rejects.toMatchObject({
      code: "already_resolved",
    });
  });
});
```

- [ ] **Step 2: Run test (fail — bifurcation não-existe)**

`cd packages/edge && bun test tests/unit/match-temp/resolve-divergent.test.ts`

- [ ] **Step 3: Extend ResolveErrorCode + add bifurcation**

Em `packages/edge/src/match-temp/review.ts`:

(a) Estender o `ResolveErrorCode` enum (linha 21):
```typescript
export type ResolveErrorCode =
  | "not_found"
  | "already_resolved"
  | "detection_outside_window"
  | "person_client_mismatch"
  | "checkin_not_found"
  // Onda 9-A:
  | "concurrent_merge"          // outro operador resolveu (mergeInto race)
  | "previous_person_gone";     // W já não existe no DB
```

(b) Atualizar JSDoc no topo do enum citando os novos códigos.

(c) Modificar `resolveAmbiguous` (linha 55+) adicionando branch divergente APÓS o check `decision !== "ambiguous"` e ANTES do existing checkin lookup:
```typescript
export async function resolveAmbiguous(
  matchAttemptId: string,
  chosenDetectionId: string,
  chosenPersonId: string,
): Promise<void> {
  const db = getDb();

  // (Reads de validação existentes — mantidos)
  const [attempt] = await db.select().from(matchAttempts)
    .where(eq(matchAttempts.id, matchAttemptId)).limit(1);
  if (!attempt) throw new ResolveError("not_found", `match_attempt ${matchAttemptId} not found`);
  if (attempt.decision !== "ambiguous") {
    throw new ResolveError("already_resolved", `... decision=${attempt.decision}`);
  }

  // Onda 9-A: branch divergente
  if (attempt.previous_person_id) {
    return resolveDivergent(attempt, chosenPersonId);
  }

  // ... resto do código atual (validações + UPDATE detection + INSERT match_attempt) ...
}
```

(d) Adicionar helper interno `resolveDivergent` no mesmo arquivo:
```typescript
async function resolveDivergent(
  attempt: typeof matchAttempts.$inferSelect,
  chosenPersonId: string,
): Promise<void> {
  // Stale state: W já é Y (algum outro path merged primeiro)
  if (attempt.previous_person_id === chosenPersonId) {
    // resolveAmbiguous retorna Promise<MatchAttempt | null>, mas resolveDivergent
    // declara void — descarta retorno via await + return explícito.
    await matchAttemptsRepo.resolveAmbiguous(
      attempt.id,
      attempt.detection_id!,
      "auto-merged stale state (W already == Y)",
    );
    return;
  }

  // W ainda existe?
  const w = await personsRepo.findById(attempt.previous_person_id!);
  if (!w) {
    throw new ResolveError(
      "previous_person_gone",
      `W (${attempt.previous_person_id}) já não existe`,
    );
  }

  try {
    await personsRepo.mergeInto(attempt.previous_person_id!, chosenPersonId, "system");
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) {
      throw new ResolveError("concurrent_merge", err.message);
    }
    throw err;
  }

  await matchAttemptsRepo.resolveAmbiguous(
    attempt.id,
    attempt.detection_id!,
    `merged ${attempt.previous_person_id} → ${chosenPersonId}`,
  );
}
```

Imports adicionais no topo (verificar — arquivo atual NÃO tem `personsRepo`/`matchAttemptsRepo`, faz queries inline via `db.select(persons)...`. Adicionar):
```typescript
import { matchAttemptsRepo, personsRepo } from "../persistence/repositories/index.js";
```

- [ ] **Step 4: Run test (pass)**

`cd packages/edge && bun test tests/unit/match-temp/resolve-divergent.test.ts` → 5 PASS.

- [ ] **Step 5: Run resto dos match-temp tests**

`cd packages/edge && bun test tests/unit/match-temp/`
Expected: tests existentes (regressão Onda 2/3) verdes.

- [ ] **Step 6: Commit**

```bash
git add packages/edge/src/match-temp/review.ts \
        packages/edge/tests/unit/match-temp/resolve-divergent.test.ts
git commit -m "feat(edge): Onda 9-A — resolveAmbiguous bifurca pra resolveDivergent (mergeInto reuse)"
```

---

### Task 5: HTTP status mapping no route handler

**Spec ref:** §4.3 tabela de status.

**Files:**
- Modify: `packages/edge/src/api/routes/matches.ts`
- Test: `packages/edge/tests/unit/api/routes/matches-resolve-errors.test.ts` (create)

- [ ] **Step 1: Failing test**

`packages/edge/tests/unit/api/routes/matches-resolve-errors.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { createMatchRoutes } from "../../../../src/api/routes/matches.js";
import { ResolveError } from "../../../../src/match-temp/review.js";

function app(resolve: (...args: any[]) => Promise<void>) {
  return createMatchRoutes({
    listPending: async () => [],
    resolve,
    reject: async () => undefined,
  });
}

// IMPORTANTE: route schema é snake_case (verificado em matches.ts:26-29 —
// `chosen_detection_id` / `chosen_person_id`). Body camelCase seria 400 por
// schema validation, NÃO 409/410 — mascararia o bug que queremos testar.
const validBody = JSON.stringify({
  chosen_detection_id: "11111111-1111-1111-1111-111111111111",
  chosen_person_id: "22222222-2222-2222-2222-222222222222",
});

describe("POST /api/matches/:id/resolve error mapping (Onda 9-A)", () => {
  test("concurrent_merge → 409", async () => {
    const r = await app(async () => {
      throw new ResolveError("concurrent_merge", "race");
    }).request("/rma-1/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: validBody,
    });
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.error).toBe("concurrent_merge");
  });

  test("previous_person_gone → 410", async () => {
    const r = await app(async () => {
      throw new ResolveError("previous_person_gone", "W gone");
    }).request("/rma-1/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: validBody,
    });
    expect(r.status).toBe(410);
    expect((await r.json()).error).toBe("previous_person_gone");
  });

  test("not_found → 404 (regressão existente)", async () => {
    const r = await app(async () => {
      throw new ResolveError("not_found", "");
    }).request("/rma-1/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: validBody,
    });
    expect(r.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test (fail — mapping não-implementado)**

`cd packages/edge && bun test tests/unit/api/routes/matches-resolve-errors.test.ts`

- [ ] **Step 3: Update route handler**

`matches.ts:18-24` já tem `const RESOLVE_ERROR_STATUS: Record<ResolveErrorCode, ContentfulStatusCode>` — não é inline literal. Só adicionar 2 entries na Record existente (a extensão de `ResolveErrorCode` na Task 4 vai forçar TS a exigir as 2 chaves novas, garantindo exhaustiveness check):

```typescript
const RESOLVE_ERROR_STATUS: Record<ResolveErrorCode, ContentfulStatusCode> = {
  not_found: 404,
  already_resolved: 409,
  detection_outside_window: 400,
  person_client_mismatch: 400,
  checkin_not_found: 500,
  // Onda 9-A:
  concurrent_merge: 409,
  previous_person_gone: 410,
};
```

O catch handler (linhas 65-72) NÃO muda — usa `RESOLVE_ERROR_STATUS[err.code]` que automaticamente passa a mapear os 2 codes novos.

- [ ] **Step 4: Run test (pass)**

`cd packages/edge && bun test tests/unit/api/routes/matches-resolve-errors.test.ts` → 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/edge/src/api/routes/matches.ts \
        packages/edge/tests/unit/api/routes/matches-resolve-errors.test.ts
git commit -m "feat(edge): Onda 9-A — route /resolve mapeia concurrent_merge→409, previous_person_gone→410"
```

---

## Chunk 2: API Enrichment + Web UI + Smoke

Superfície que o usuário vê. Backend de `/api/match-pending` traz `previous_person` (snapshot ou live), shared type ganha o novo campo, `match-detail.tsx` renderiza o warning block com 4 edge cases. Termina com smoke pré-deploy.

**Tasks:** 6-9.
**Sequência estrita:** 6 (enrichment backend) → 7 (shared type) → 8 (web UI) → 9 (final gates).
**Pré-requisito:** Chunk 1 mergeado (schema + pipeline + resolve já em main).

---

### Task 6: Backend enrichment com aliasedTable

**Spec ref:** §5.1.

**Files:**
- Modify: `packages/edge/src/api/match-pending.ts`
- Test: `packages/edge/tests/integration/api/match-pending-prev.test.ts` (create — DB-deferred)

- [ ] **Step 1: Failing test (DB-deferred)**

`packages/edge/tests/integration/api/match-pending-prev.test.ts`:
```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { listPendingEnriched } from "../../../src/api/match-pending.js";
import { matchAttemptsRepo } from "../../../src/persistence/repositories/match-attempts.repo.js";
import { detectionsRepo } from "../../../src/persistence/repositories/detections.repo.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";
import { getDb } from "../../../src/persistence/db.js";

let cameraId: string;
let wPersonId: string;
let detectionId: string;
let checkinErpId: string;
let attemptId: string;

beforeEach(async () => {
  const db = getDb();
  const [cam] = await db.execute<{ id: string }>(sql`
    INSERT INTO cameras (id, name) VALUES (gen_random_uuid(), 'test-cam-mp')
    RETURNING id
  `);
  cameraId = cam.id;

  await db.execute(sql`
    INSERT INTO erp_clients (erp_id, name, is_active)
    VALUES ('cli-y-mp', 'Maria MP', true)
    ON CONFLICT (erp_id) DO UPDATE SET name = EXCLUDED.name
  `);
  await personsRepo.create({ display_name: "Maria MP", person_type: "client", erp_client_id: "cli-y-mp" });

  const w = await personsRepo.create({
    display_name: "Wagner W",
    person_type: "client",
    thumbnail_path: "2026-05-20/wagner.jpg",
  });
  wPersonId = w.id;

  const det = await detectionsRepo.create({
    camera_id: cameraId, person_id: wPersonId, session_id: null,
    face_attrs: {}, detected_at: new Date("2026-05-26T14:00:00Z"), raw_event: {},
  });
  detectionId = det.id;

  checkinErpId = `chk-mp-${Date.now()}`;
  await db.execute(sql`
    INSERT INTO erp_checkins (erp_id, erp_client_id, event_type, occurred_at, metadata)
    VALUES (${checkinErpId}, 'cli-y-mp', 'in', ${new Date("2026-05-26T14:00:30Z")}, '{}')
  `);

  const att = await matchAttemptsRepo.create({
    detection_id: detectionId,
    erp_checkin_id: checkinErpId,
    decision: "ambiguous",
    previous_person_id: wPersonId,
    previous_person_snapshot: { id: wPersonId, display_name: "Wagner W (snap)" },
  });
  attemptId = att.id;
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`DELETE FROM match_attempts WHERE erp_checkin_id = ${checkinErpId}`);
  await db.execute(sql`DELETE FROM detections WHERE camera_id = ${cameraId}`);
  await db.execute(sql`DELETE FROM persons WHERE id = ${wPersonId} OR erp_client_id = 'cli-y-mp'`);
  await db.execute(sql`DELETE FROM erp_clients WHERE erp_id = 'cli-y-mp'`);
  await db.execute(sql`DELETE FROM erp_checkins WHERE erp_id = ${checkinErpId}`);
  await db.execute(sql`DELETE FROM cameras WHERE id = ${cameraId}`);
});

describe("listPendingEnriched previous_person (Onda 9-A)", () => {
  test("retorna previous_person populado quando previous_person_id != null", async () => {
    const items = await listPendingEnriched(50);
    const ours = items.find((i) => i.match_attempt_id === attemptId);
    expect(ours).toBeDefined();
    expect(ours!.previous_person).toBeDefined();
    expect(ours!.previous_person!.id).toBe(wPersonId);
    expect(ours!.previous_person!.display_name).toBe("Wagner W");
    expect(ours!.previous_person!.person_type).toBe("client");
    expect(ours!.previous_person!.thumbnail_path).toBe("2026-05-20/wagner.jpg");
  });

  test("clássico (previous_person_id null) → previous_person undefined", async () => {
    const db = getDb();
    const otherCheckin = `chk-classic-${Date.now()}`;
    await db.execute(sql`
      INSERT INTO erp_checkins (erp_id, erp_client_id, event_type, occurred_at, metadata)
      VALUES (${otherCheckin}, 'cli-y-mp', 'in', ${new Date("2026-05-26T15:00:00Z")}, '{}')
    `);
    const classicAtt = await matchAttemptsRepo.create({
      detection_id: null,
      erp_checkin_id: otherCheckin,
      decision: "ambiguous",
    });
    const items = await listPendingEnriched(50);
    const classic = items.find((i) => i.match_attempt_id === classicAtt.id);
    expect(classic).toBeDefined();
    expect(classic!.previous_person).toBeUndefined();
    await db.execute(sql`DELETE FROM match_attempts WHERE id = ${classicAtt.id}`);
    await db.execute(sql`DELETE FROM erp_checkins WHERE erp_id = ${otherCheckin}`);
  });
});
```

- [ ] **Step 2: Run test (fail — campo não-presente)**

`bash packages/edge/scripts/run-integration-tests.sh tests/integration/api/match-pending-prev.test.ts`

- [ ] **Step 3: Implement enrichment**

Em `packages/edge/src/api/match-pending.ts`:

(a) Adicionar imports (o arquivo atual só importa `matchAttemptsRepo` — precisa do schema `matchAttempts` p/ referenciar as colunas novas no select, e do `aliasedTable` p/ o LEFT JOIN duplo):
```typescript
import { aliasedTable } from "drizzle-orm";
import { matchAttempts } from "../persistence/schema/match-attempts.js";
```

(b) Antes do `db.select(...)`, declarar alias:
```typescript
const prevPersons = aliasedTable(persons, "prev_persons");
```

(c) Estender o `select(...)` object com 4 campos novos (snapshot fallback):
```typescript
.select({
  // ... campos existentes ...
  previous_person_id: matchAttempts.previous_person_id,
  prev_display_name: prevPersons.display_name,
  prev_person_type: prevPersons.person_type,
  prev_thumbnail_path: prevPersons.thumbnail_path,
  previous_person_snapshot: matchAttempts.previous_person_snapshot,
})
```

(d) Adicionar LEFT JOIN ao chain (depois do JOIN existente de persons):
```typescript
.leftJoin(prevPersons, eq(prevPersons.id, matchAttempts.previous_person_id))
```

(e) No mapper (`.map((row) => ({...}))`), adicionar:
```typescript
previous_person: row.previous_person_id ? {
  id: row.previous_person_id,
  // Fallback pro snapshot se person live foi deletada (FK SET NULL → row null)
  display_name: row.prev_display_name ?? (row.previous_person_snapshot?.display_name as string ?? null),
  person_type: (row.prev_person_type ?? row.previous_person_snapshot?.person_type ?? "anonymous") as "client" | "employee" | "anonymous",
  thumbnail_path: row.prev_thumbnail_path ?? (row.previous_person_snapshot?.thumbnail_path as string ?? null),
} : undefined,
```

> **Verificar antes:** ler `match-pending.ts` inteiro pra ver shape exato do select/join/mapper atual. Drizzle aliasing requer `aliasedTable` import correto e nome distinto pra evitar SQL ambiguity.

- [ ] **Step 4: Run test (pass)**

`bash packages/edge/scripts/run-integration-tests.sh tests/integration/api/match-pending-prev.test.ts` → 2 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/edge/src/api/match-pending.ts \
        packages/edge/tests/integration/api/match-pending-prev.test.ts
git commit -m "feat(edge): Onda 9-A — match-pending enriquece com previous_person via aliasedTable"
```

---

### Task 7: Shared type MatchPendingEnriched + previous_person

**Spec ref:** §5.1.

**Files:**
- Modify: `packages/shared/src/types/index.ts` (ou onde MatchPendingEnriched estiver)

- [ ] **Step 1: Localizar tipo**

```bash
cd packages/shared && grep -rn "MatchPendingEnriched" src/
```

Path verificado: `packages/shared/src/types/index.ts` (interface começa na linha 61).

- [ ] **Step 2: Add campo opcional**

Editar a interface `MatchPendingEnriched` (linhas 61-75 do arquivo). Adicionar campo APÓS `candidates`:
```typescript
export interface MatchPendingEnriched {
  // ... campos existentes (match_attempt_id, decided_at, notes, checkin, candidates) ...
  /**
   * Onda 9-A: presente apenas quando match_attempts.previous_person_id != null
   * (caso divergente reid+ERP). UI mostra warning block com info de W.
   * `| null` (não só `undefined`) pq backend pode enviar null explicit quando
   * o JOIN com prev_persons devolve linha mas FK SET NULL zerou no live state.
   */
  previous_person?: {
    id: string;
    display_name: string | null;
    person_type: "client" | "employee" | "anonymous";
    thumbnail_path: string | null;
  } | null;
}
```

- [ ] **Step 3: Run typecheck shared + edge + web**

```bash
bun --filter '*' typecheck
```
Expected: tudo verde. Edge enrichment (Task 6) e web component (Task 8) ambos referenciam esse tipo.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/index.ts
git commit -m "feat(shared): Onda 9-A — MatchPendingEnriched.previous_person opcional"
```

---

### Task 8: Web `match-detail.tsx` warning block

**Spec ref:** §5.2.

**Files:**
- Modify: `packages/web/src/components/match-detail.tsx`
- Test: `packages/web/tests/unit/components/match-detail-divergent.test.tsx` (create)

- [ ] **Step 1: Failing test (4 edge cases)**

> **Pré-requisito:** ler `packages/web/src/components/match-detail.tsx` E `packages/web/tests/unit/components/match-detail.test.tsx` (sibling) antes de escrever. Padrões obrigatórios verificados na sibling:
> - `mock.module(...)` p/ `../../../src/lib/queries/matches` (useResolveMatch + useRejectMatch) e `../../../src/lib/api-client` (snapshotUrl) DEVE rodar ANTES do `await import("...match-detail")` — usar dynamic import dentro de cada `test`, não static import no topo.
> - Componente real recebe `match: MatchPendingEnriched` com `checkin: {...}` (NÃO `detection`) + `candidates: DetectionThumbnail[]` + `decided_at` + `notes`. Sem QueryClientProvider necessário (os hooks ficam mockados).
> - Componente tem candidate buttons "É essa pessoa" per-item E um único botão "Rejeitar" embaixo. NÃO existe global `handleAccept`/`candidateName`/`prevName`.

`packages/web/tests/unit/components/match-detail-divergent.test.tsx`:
```typescript
import { describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import type { MatchPendingEnriched } from "@vipcam/shared";
import * as React from "react";

let resolveCalls = 0;
let rejectCalls = 0;

const installMocks = () => {
  mock.module("../../../src/lib/queries/matches", () => ({
    useResolveMatch: () => ({
      mutate: () => {
        resolveCalls += 1;
      },
      isPending: false,
    }),
    useRejectMatch: () => ({
      mutate: () => {
        rejectCalls += 1;
      },
      isPending: false,
    }),
  }));
  mock.module("../../../src/lib/api-client", () => ({
    apiFetch: async () => ({}),
    snapshotUrl: (p: string | null) => (p ? `/snapshots/${p}` : null),
    ApiError: class extends Error {},
  }));
};
installMocks();

const baseMatch: MatchPendingEnriched = {
  match_attempt_id: "11111111-1111-1111-1111-111111111111",
  decided_at: "2026-05-26T14:00:00Z",
  notes: null,
  checkin: {
    erp_id: "chk-1",
    client_name: "Maria",
    client_phone: "11999",
    erp_client_id: "cli-y",
    person_id: "22222222-2222-2222-2222-222222222222",
    occurred_at: "2026-05-26T14:00:00Z",
    event_type: "appointment_confirmed",
  },
  candidates: [
    {
      id: "33333333-3333-3333-3333-333333333333",
      detected_at: "2026-05-26T14:00:30Z",
      snapshot_path: null,
      face_attrs: { age: 32, gender: "Female" },
      dominant_emotion: "happy",
      emotion_confidence: 0.8,
      session_id: "ss1",
      camera_id: "cam-1",
    },
  ],
};

describe("MatchDetail divergent (Onda 9-A)", () => {
  test("clássico (sem previous_person) → não renderiza warning block", async () => {
    installMocks();
    const { MatchDetail } = await import("../../../src/components/match-detail");
    render(<MatchDetail match={baseMatch} />);
    expect(screen.queryByText(/já está ligada/i)).toBeNull();
  });

  test("divergente com W nomeado → warning block visível com nome", async () => {
    installMocks();
    const { MatchDetail } = await import("../../../src/components/match-detail");
    const m: MatchPendingEnriched = {
      ...baseMatch,
      previous_person: {
        id: "p-W",
        display_name: "Wagner",
        person_type: "client",
        thumbnail_path: "2026-05-20/wagner.jpg",
      },
    };
    render(<MatchDetail match={m} />);
    expect(screen.getByText(/já está ligada/i)).toBeTruthy();
    expect(screen.getByText(/Wagner/)).toBeTruthy();
  });

  test("W com display_name=null → fallback 'Anônima <prefix>'", async () => {
    installMocks();
    const { MatchDetail } = await import("../../../src/components/match-detail");
    const m: MatchPendingEnriched = {
      ...baseMatch,
      previous_person: {
        id: "p-anon-1234abcd",
        display_name: null,
        person_type: "anonymous",
        thumbnail_path: null,
      },
    };
    render(<MatchDetail match={m} />);
    expect(screen.getByText(/Anônima p-anon-1/i)).toBeTruthy();
  });

  test("W sem thumbnail → sem img com alt 'previous'", async () => {
    installMocks();
    const { MatchDetail } = await import("../../../src/components/match-detail");
    const m: MatchPendingEnriched = {
      ...baseMatch,
      previous_person: {
        id: "p-W",
        display_name: "W",
        person_type: "anonymous",
        thumbnail_path: null,
      },
    };
    render(<MatchDetail match={m} />);
    const imgs = screen.queryAllByRole("img");
    const wImg = imgs.find((i) => i.getAttribute("alt")?.toLowerCase().includes("previous"));
    expect(wImg).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test (fail — warning não-renderiza)**

`cd packages/web && bun test tests/unit/components/match-detail-divergent.test.tsx`

- [ ] **Step 3: Implement warning block**

Editar `packages/web/src/components/match-detail.tsx`. Estrutura atual do componente (verificada):
- header (linhas 31-44) — checkin client_name + phone + event_type + notes
- grid de candidates (linhas 46-89) — cada item tem botão `"É essa pessoa"` que chama `handleResolve(det)`
- footer (linhas 91-102) — único botão `"Rejeitar"` que chama `reject.mutate(...)` inline

(a) Inserir o warning block ENTRE o header e o grid de candidates (depois da linha 44, antes da linha 46):

```tsx
{match.previous_person && (
  <div className="bg-yellow-50 border border-yellow-300 rounded-md p-3 flex items-center gap-3">
    <div className="flex-shrink-0">
      {match.previous_person.thumbnail_path ? (
        <img
          src={snapshotUrl(match.previous_person.thumbnail_path) ?? ""}
          alt="W previous person"
          className="w-12 h-12 rounded-full object-cover"
        />
      ) : (
        <div className="w-12 h-12 rounded-full bg-slate-200 flex items-center justify-center text-slate-500 text-sm">
          ?
        </div>
      )}
    </div>
    <div className="text-sm">
      <div className="font-semibold">⚠ Esta detection já está ligada a:</div>
      <div>
        <span className="font-bold">
          {match.previous_person.display_name ??
            `Anônima ${match.previous_person.id.slice(0, 10)}`}
        </span>
        <span className="text-xs text-slate-500 ml-1">
          ({match.previous_person.person_type}) — auto-matched pelo reid
        </span>
      </div>
    </div>
  </div>
)}
```

(b) Adaptar os labels dos botões existentes quando `previous_person` está presente. A copy precisa do nome de Y (do checkin) e do nome de W (fallback p/ "Anônima <prefix>" quando display_name null). Extrair em const no topo do componente, depois do `useRejectMatch()`:

```tsx
const prevName =
  match.previous_person?.display_name ??
  (match.previous_person ? `Anônima ${match.previous_person.id.slice(0, 10)}` : null);
const candidateName = match.checkin.client_name ?? "Cliente sem nome";
const isDivergent = match.previous_person != null;
```

Trocar o label do botão per-candidate (linha 83 atual `É essa pessoa`):
```tsx
<Button
  size="sm"
  className="w-full text-xs"
  disabled={resolve.isPending}
  onClick={() => handleResolve(det)}
>
  {isDivergent
    ? `É ${candidateName} — merge ${prevName} → ${candidateName}`
    : "É essa pessoa"}
</Button>
```

Trocar o label do botão "Rejeitar" (linha 100 atual):
```tsx
<Button
  variant="outline"
  size="sm"
  disabled={reject.isPending}
  onClick={() =>
    reject.mutate({ id: match.match_attempt_id, reason: "operator rejection" })
  }
>
  {isDivergent ? `Não é ${candidateName} — manter ${prevName}` : "Rejeitar"}
</Button>
```

> **Edge case** (spec §5.2): se `match.previous_person.id === match.checkin.person_id` (W já é Y — stale state que escapou da dedup), renderizar warning + texto "Já é o mesmo cliente — aguardando dedup automática", desabilitar os botões. Implementar via:
> ```tsx
> const isStaleSame = match.previous_person?.id === match.checkin.person_id;
> ```
> e usar `disabled={resolve.isPending || isStaleSame}` nos botões + mostrar mensagem condicional no warning block.

- [ ] **Step 4: Run test (pass)**

`cd packages/web && bun test tests/unit/components/match-detail-divergent.test.tsx` → 4 PASS.

- [ ] **Step 5: Run web build pra confirmar typecheck integrado**

```bash
cd packages/web && bun run build
```
Expected: build OK; `/matches` route compila.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/match-detail.tsx \
        packages/web/tests/unit/components/match-detail-divergent.test.tsx
git commit -m "feat(web): Onda 9-A — match-detail warning block divergent + botões adaptativos"
```

---

### Task 9: Final verification + smoke pré-deploy

**Spec ref:** §6, §9.

**Files:** nenhum novo — só verificação.

- [ ] **Step 0: Baseline counts**

Antes de qualquer mudança da Onda 9-A (idealmente registrar no início do trabalho, mas verificar agora se ainda não registrou):

```bash
git stash  # se houver mudanças soltas
git checkout master
cd packages/edge && bun run test 2>&1 | tail -3   # registrar: edge_baseline
cd ../web && bun test 2>&1 | tail -3              # registrar: web_baseline
git checkout onda-9a-reid-erp-divergent
git stash pop  # se aplicável
```

Se o baseline já passou voou, use `git log --since="2 weeks" --oneline` p/ achar o último commit em master antes da Onda 9-A e fazer o checkout temporário. Anotar `edge_baseline` e `web_baseline` p/ comparar em Step 1.

- [ ] **Step 1: Offline gates completos**

```bash
bun --filter '*' typecheck       # 3/3 packages
bun run lint                     # exit 0 esperado
cd packages/edge && bun run test
cd packages/web && bun test
cd packages/web && bun run build
```

Esperado:
- typecheck 3/3 ✓
- lint exit 0
- edge unit: `edge_baseline` + novos testes (Task 1: 3, Task 4: 5, Task 5: 3) = baseline + 11 unit. Integration tests (Tasks 2, 3, 6) DB-deferred — não contam aqui.
- web unit: `web_baseline` + 4 novos (Task 8)
- web build ✓ (compila `/matches`)

- [ ] **Step 2: DB-deferred tests inventory**

DB-deferred (rodar no VPS pós-deploy):
- `tests/integration/persistence/detections-find-in-window.test.ts` (Task 2)
- `tests/integration/match-temp/divergent.test.ts` (Task 3)
- `tests/integration/api/match-pending-prev.test.ts` (Task 6)

- [ ] **Step 3: Pré-merge sanity**

```bash
git log --oneline master..HEAD
git diff master --stat | tail -15
```

Sequência esperada (8 commits Onda 9-A + spec/plan já em branch): Task 1 (schema), Task 2 (findInWindow), Task 3 (orchestrator 2-pass), Task 4 (resolveDivergent), Task 5 (HTTP mapping), Task 6 (enrichment), Task 7 (shared type), Task 8 (web warning). Spec commits (3) + plan commits (1-2) já estavam antes. Total = baseline branch + 8 task commits.

- [ ] **Step 4: Operational follow-up checklist (FOR HUMAN)**

Pós-merge no VPS:

```bash
cd /opt/vipcamv2
sudo -u vipcam git pull          # traz Onda 9-A
./deploy.sh                      # rebuild edge + migrations 0008 auto
sudo systemctl restart vipcam-edge
sleep 5
sudo journalctl -u vipcam-edge -n 20 --no-pager | grep "scheduler started"

# Smoke health
KEY=$(sudo grep '^API_KEY=' /etc/vipcam/edge.env | cut -d= -f2)
curl -s -H "X-API-Key: $KEY" 'https://monitoramento.../api/health' | jq .

# Verifica nova coluna existe
sudo -u vipcam psql "$(sudo grep '^DATABASE_URL=' /etc/vipcam/edge.env | cut -d= -f2)" -c "\d match_attempts" | grep previous_person

# Aguardar primeira detection identificada + checkin coincidente
# (espera natural — operador valida no /matches quando ambiguous divergente aparecer)
```

- [ ] **Step 5: Verdict + handoff pra finishing-a-development-branch**

Se todos gates verdes → invocar `superpowers:finishing-a-development-branch` pra merge/PR.

---

## Calibração pós-deploy (14 dias)

Per spec §9, monitorar via SQL semanalmente:

```sql
SELECT
  date_trunc('day', decided_at) AS dia,
  count(*) FILTER (WHERE previous_person_id IS NOT NULL) AS divergentes,
  count(*) FILTER (WHERE previous_person_id IS NULL AND decision='ambiguous') AS classicos,
  count(*) AS total
FROM match_attempts
WHERE decided_at > now() - interval '14 days'
GROUP BY 1 ORDER BY 1;
```

Triggers de tuning `REID_DIST_STRICT` documentados em §9 do spec.

Onda 9-A fechada após 14 dias estáveis + report em `2026-XX-XX-onda-9a-report.md`.
