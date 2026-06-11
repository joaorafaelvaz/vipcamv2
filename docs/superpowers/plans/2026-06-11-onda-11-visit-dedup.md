# Onda 11 — Dedup de Visitas (gap 12h) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `persons.total_visits` conta visitas distintas — só incrementa quando o gap
desde `last_seen_at` é > `VISIT_GAP_HOURS` (default 12).

**Architecture:** `incrementVisitCount` vira `recordSighting(id, detectedAt, gapHours)`
— UPDATE único atômico (CASE p/ incremento condicional + GREATEST p/ last_seen_at,
robusto a eventos fora de ordem). Repo permanece puro (gap vem por parâmetro); os 2
call sites resolvem `env.VISIT_GAP_HOURS`. Forward-only, sem migration, sem backfill.

**Tech Stack:** edge Bun+Hono+Drizzle+Postgres; bun:test.

**Spec:** `docs/superpowers/specs/2026-06-11-onda-11-visit-dedup-design.md` (dd812ec)

---

## File Structure

| Arquivo | Mudança |
|---|---|
| `packages/edge/src/config/env.ts` | `+VISIT_GAP_HOURS` (default 12) |
| `packages/edge/src/persistence/repositories/persons.repo.ts:48-57` | `incrementVisitCount` → `recordSighting` gap-aware |
| `packages/edge/src/ingest/pipeline.ts:127` | call site matched_strict |
| `packages/edge/src/persistence/repositories/reid-match-attempts.repo.ts:110` | call site resolução manual (`+import getEnv`) |
| `packages/edge/tests/unit/ingest/pipeline-reid.test.ts:38` | rename no mock |
| `packages/edge/tests/integration/persistence/persons.repo.test.ts:91` | rename na chamada |
| `packages/edge/tests/integration/persistence/persons-record-sighting.test.ts` (**novo**) | comportamento do gap |
| `packages/edge/tests/unit/config/env-onda9d.test.ts` (ou novo) | default do env |

**Sem migration.**

---

## Task 1: Env `VISIT_GAP_HOURS`

- [ ] **Step 1: Failing test** — append em `tests/unit/config/env-onda9d.test.ts`
  (arquivo já cobre defaults recentes; evita arquivo novo p/ 2 asserts):

```ts
  test("VISIT_GAP_HOURS default 12 + override (Onda 11)", () => {
    expect(parseEnv(BASE).VISIT_GAP_HOURS).toBe(12);
    expect(parseEnv({ ...BASE, VISIT_GAP_HOURS: "14" }).VISIT_GAP_HOURS).toBe(14);
  });
```

- [ ] **Step 2: Run → FAIL** — `cd packages/edge && bun test tests/unit/config/env-onda9d.test.ts`

- [ ] **Step 3: Implement** em `env.ts` (após `STAFF_MIN_ACTIVE_HOURS`):

```ts
    // Onda 11: dedup de visitas — um avistamento só vira visita NOVA se o gap
    // desde persons.last_seen_at exceder N horas. Sem isso, cada detecção
    // matched_strict incrementava total_visits (mesma pessoa 5× numa hora = +5).
    VISIT_GAP_HOURS: z.coerce.number().int().positive().default(12),
```

- [ ] **Step 4: Run → PASS** + typecheck.
- [ ] **Step 5: Commit** — `feat(edge): Onda 11 — VISIT_GAP_HOURS (default 12)`

## Task 2: `recordSighting` no repo (com teste de integração)

- [ ] **Step 1: Failing test** — Create
  `tests/integration/persistence/persons-record-sighting.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getDb } from "../../../src/persistence/db.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";

const created: string[] = [];
afterEach(async () => {
  for (const id of created) await getDb().execute(sql`DELETE FROM persons WHERE id = ${id}`);
  created.length = 0;
});

async function person(lastSeen: Date) {
  const p = await personsRepo.create({ person_type: "anonymous", last_seen_at: lastSeen });
  created.push(p.id);
  return p;
}

const H = 3_600_000;
const T0 = new Date("2026-06-10T12:00:00Z");

describe("personsRepo.recordSighting (Onda 11 — dedup por gap)", () => {
  test("gap > gapHours → +1 visita e last_seen atualizado", async () => {
    const p = await person(T0);
    await personsRepo.recordSighting(p.id, new Date(T0.getTime() + 13 * H), 12);
    const r = await personsRepo.findById(p.id);
    expect(r?.total_visits).toBe(2); // default 1 + 1
    expect(r?.last_seen_at?.toISOString()).toBe(new Date(T0.getTime() + 13 * H).toISOString());
  });

  test("gap < gapHours → contador inalterado, last_seen atualizado (mesma visita)", async () => {
    const p = await person(T0);
    await personsRepo.recordSighting(p.id, new Date(T0.getTime() + 2 * H), 12);
    const r = await personsRepo.findById(p.id);
    expect(r?.total_visits).toBe(1);
    expect(r?.last_seen_at?.toISOString()).toBe(new Date(T0.getTime() + 2 * H).toISOString());
  });

  test("out-of-order (detectedAt < last_seen) → contador inalterado, last_seen preservado", async () => {
    const p = await person(T0);
    await personsRepo.recordSighting(p.id, new Date(T0.getTime() - 5 * H), 12);
    const r = await personsRepo.findById(p.id);
    expect(r?.total_visits).toBe(1);
    expect(r?.last_seen_at?.toISOString()).toBe(T0.toISOString()); // GREATEST preserva
  });

  test("gapHours custom (1h) respeitado", async () => {
    const p = await person(T0);
    await personsRepo.recordSighting(p.id, new Date(T0.getTime() + 2 * H), 1);
    const r = await personsRepo.findById(p.id);
    expect(r?.total_visits).toBe(2); // 2h > 1h
  });
});
```

- [ ] **Step 2: Verify red** — typecheck acusa `recordSighting` inexistente.

- [ ] **Step 3: Implement** — substituir `incrementVisitCount` em
  `persons.repo.ts:48-57`:

```ts
  /**
   * Onda 11 — registra um avistamento da pessoa. Só conta VISITA NOVA se o
   * gap desde last_seen_at exceder gapHours (dedup: mesma pessoa detectada
   * várias vezes no mesmo período = 1 visita). UPDATE único atômico:
   * - CASE: gap > gapHours → +1; senão (inclusive out-of-order, gap negativo) +0.
   * - GREATEST: last_seen_at nunca regride com evento fora de ordem.
   * Substitui incrementVisitCount (que incrementava a cada detecção).
   */
  async recordSighting(id: string, detectedAt: Date, gapHours: number): Promise<void> {
    await getDb()
      .update(persons)
      .set({
        total_visits: sql`${persons.total_visits} + CASE WHEN ${detectedAt} - ${persons.last_seen_at} > make_interval(hours => ${gapHours}) THEN 1 ELSE 0 END`,
        last_seen_at: sql`GREATEST(${persons.last_seen_at}, ${detectedAt})`,
        updated_at: sql`now()`,
      })
      .where(eq(persons.id, id));
  },
```

  > NOTA drizzle: parâmetros `Date` dentro de `sql` template são bound como
  > timestamptz; se o driver reclamar do tipo, usar
  > `${detectedAt.toISOString()}::timestamptz` explicitamente.

- [ ] **Step 4: Atualizar referências existentes** (rename mecânico):
  - `tests/unit/ingest/pipeline-reid.test.ts:38`: `incrementVisitCount: async () => undefined` → `recordSighting: async () => undefined`.
  - `tests/integration/persistence/persons.repo.test.ts:91`: `incrementVisitCount(recent.id, new Date())` → `recordSighting(recent.id, new Date(), 12)`.
  - Grep final: `grep -rn incrementVisitCount packages/edge/src packages/edge/tests` → vazio.

- [ ] **Step 5: Typecheck** (integração roda na VPS). 
- [ ] **Step 6: Commit** — `feat(edge): Onda 11 — recordSighting (visita só com gap > VISIT_GAP_HOURS)`

## Task 3: Call sites + gates finais

- [ ] **Step 1: `pipeline.ts:126-128`** (env já disponível via `getEnv()` no arquivo):

```ts
    } else if (reidOut?.status === "matched_strict" && personId) {
      await personsRepo.recordSighting(personId, detectedAt, getEnv().VISIT_GAP_HOURS);
    }
```
  (conferir se o arquivo já tem `getEnv` em escopo no ponto — senão usar a
  referência existente de env do pipeline.)

- [ ] **Step 2: `reid-match-attempts.repo.ts:110`** — adicionar
  `import { getEnv } from "../../config/env.js";` e:

```ts
        await personsRepo.recordSighting(
          att.candidate_person_id,
          att.det_detected_at,
          getEnv().VISIT_GAP_HOURS,
        );
```

- [ ] **Step 3: Gates** — `cd packages/edge && bun run typecheck && bun test tests/unit`
  → limpo + suíte verde. Biome nos arquivos tocados.
- [ ] **Step 4: Commit** — `feat(edge): Onda 11 — call sites usam recordSighting com VISIT_GAP_HOURS`
- [ ] **Step 5:** finishing-a-development-branch → merge master → push → `deploy.sh`.

## Verificação pós-deploy (VPS)

```bash
# pessoa re-detectada em sequência NÃO deve ganhar visitas:
psql "$DB_URL" -c "SELECT id, total_visits, last_seen_at FROM persons WHERE person_type='employee' ORDER BY last_seen_at DESC NULLS LAST LIMIT 3;"
# anotar total_visits, esperar novas detecções da mesma pessoa no mesmo dia, re-checar: deve ficar igual.
```
