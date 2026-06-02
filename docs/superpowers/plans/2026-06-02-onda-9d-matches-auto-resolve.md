# Onda 9-D — Auto-resolução do /matches Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduzir o retrabalho no /matches — colapsar attempts por-detecção, excluir
onipresentes (staff) dos candidatos, e auto-resolver quando sobra 1 candidato específico.

**Architecture:** Lógica de decisão por checkin extraída pura (`candidates.ts`, testável sem
DB); o `processCheckin` vira "classifica candidatos → decide → executa". Exclusão de staff via
heurística de presença (`persons.isStaffLike`). Auto-resolução reusa `personsRepo.mergeInto`.
Backfill opt-in dry-run-first drena a fila existente.

**Tech Stack:** Bun + Hono + Drizzle + Postgres + pgvector; bun:test.

**Spec:** `docs/superpowers/specs/2026-06-02-onda-9d-matches-auto-resolve-design.md`

---

## File Structure

| Arquivo | Responsabilidade | Mudança |
|---|---|---|
| `packages/edge/src/config/env.ts` | env | default `REID_DIST_STRICT` 0.40; `+STAFF_LOOKBACK_DAYS`(7), `+STAFF_MIN_ACTIVE_HOURS`(20) |
| `packages/edge/src/match-temp/candidates.ts` (**novo**) | decisão pura por checkin | `classifyDetection`, `decideCheckinMatch` |
| `packages/edge/src/persistence/repositories/detections.repo.ts` | window query | `findInWindow` retorna `person_type` |
| `packages/edge/src/persistence/repositories/persons.repo.ts` | presença | `+isStaffLike(personId, lookbackDays, minHours)` |
| `packages/edge/src/match-temp/orchestrator.ts` | processCheckin | usa `decideCheckinMatch` + executa decisão (B1+B2+B3) |
| `packages/edge/scripts/backfill-rematch.ts` (**novo**) | drenar fila existente | `--dry-run` (default) / `--apply` |
| Testes | unit puras + integração orchestrator + isStaffLike | vários |

**Sem migration.** A heurística de staff é derivada de `detections` (sem coluna nova).

**APIs existentes reusadas (confirmadas):**
- `personsRepo.mergeInto(srcId, dstId, userId)` — merge anon→cliente, migra detections/sessions/
  face_records, rollup visitas, audit, delete src. Lança `/not found/` em race.
- `matchAttemptsRepo.create(...)`, `matchAttempts` schema: `detection_id?`, `erp_checkin_id`,
  `decision`, `decided_by`, `notes?`, `previous_person_id?`, `previous_person_snapshot?`.
- `person_type` enum: `client | employee | anonymous`.

---

## Chunk 1: Part A — consolidação no ingest (env)

### Task 1: Defaults de env (REID_DIST_STRICT 0.40 + thresholds de staff)

**Files:**
- Modify: `packages/edge/src/config/env.ts`
- Modify: `packages/edge/tests/unit/config/env.test.ts` (se existir; senão criar teste mínimo)

- [ ] **Step 1: Write the failing test**

Criar/!append `packages/edge/tests/unit/config/env-onda9d.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseEnv } from "../../../src/config/env.js";

describe("Onda 9-D env defaults", () => {
  const base = { API_KEY: "x" };
  test("REID_DIST_STRICT default 0.40", () => {
    expect(parseEnv(base).REID_DIST_STRICT).toBe(0.4);
  });
  test("STAFF_LOOKBACK_DAYS / STAFF_MIN_ACTIVE_HOURS defaults", () => {
    const e = parseEnv(base);
    expect(e.STAFF_LOOKBACK_DAYS).toBe(7);
    expect(e.STAFF_MIN_ACTIVE_HOURS).toBe(20);
  });
  test("strict < loose ainda vale com 0.40", () => {
    expect(parseEnv(base).REID_DIST_STRICT).toBeLessThan(parseEnv(base).REID_DIST_LOOSE);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/edge && bun test tests/unit/config/env-onda9d.test.ts`
Expected: FAIL (REID_DIST_STRICT=0.35, STAFF_* undefined).

- [ ] **Step 3: Implement**

Em `env.ts`: mudar default do `REID_DIST_STRICT` de `0.35` para `0.4`. Adicionar após `REID_DIST_LOOSE`:

```ts
    // Onda 9-D: heurística "staff-like" pro match-temporal. Um anônimo presente
    // em ≥ STAFF_MIN_ACTIVE_HOURS slots de hora distintos nos últimos
    // STAFF_LOOKBACK_DAYS dias é tratado como staff/onipresente e EXCLUÍDO do
    // conjunto de candidatos do checkin (não é quem deu checkin). Thresholds
    // validados empiricamente (ver plano Task 4); ajustar por env se preciso.
    STAFF_LOOKBACK_DAYS: z.coerce.number().int().positive().default(7),
    STAFF_MIN_ACTIVE_HOURS: z.coerce.number().int().positive().default(20),
```

E `REID_DIST_STRICT: z.coerce.number().min(0).max(2).default(0.4),`

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/edge && bun test tests/unit/config/env-onda9d.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
cd packages/edge && bun run typecheck
git add packages/edge/src/config/env.ts packages/edge/tests/unit/config/env-onda9d.test.ts
git commit -m "feat(edge): Onda 9-D — REID_DIST_STRICT 0.40 + thresholds staff-like"
```

---

## Chunk 2: Lógica de decisão pura (`candidates.ts`)

### Task 2: `decideCheckinMatch` + classificação (sem DB)

A decisão por checkin, isolada e testável. Recebe os detections da janela já com
`person_type` + o conjunto de personIds staff-like; devolve a ação a executar.

**Files:**
- Create: `packages/edge/src/match-temp/candidates.ts`
- Create: `packages/edge/tests/unit/match-temp/candidates.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/edge/tests/unit/match-temp/candidates.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { decideCheckinMatch, type WindowDetection } from "../../../src/match-temp/candidates.js";

const Y = "client-Y";
function det(over: Partial<WindowDetection>): WindowDetection {
  return { id: "d", person_id: null, person_type: null, session_id: null, ...over };
}

describe("decideCheckinMatch", () => {
  test("convergente: existe detection já ligada a Y", () => {
    const r = decideCheckinMatch({
      candidatePersonId: Y,
      detections: [det({ id: "d1", person_id: Y, person_type: "client" })],
      staffPersonIds: new Set(),
    });
    expect(r.kind).toBe("convergent");
  });

  test("rejected: sem candidatos plausíveis", () => {
    const r = decideCheckinMatch({
      candidatePersonId: Y,
      detections: [det({ id: "e", person_id: "emp", person_type: "employee" })],
      staffPersonIds: new Set(),
    });
    expect(r.kind).toBe("rejected");
  });

  test("auto_merge_anon: exatamente 1 anônimo distinto (várias detecções) e 0 nulls", () => {
    const r = decideCheckinMatch({
      candidatePersonId: Y,
      detections: [
        det({ id: "d1", person_id: "A", person_type: "anonymous" }),
        det({ id: "d2", person_id: "A", person_type: "anonymous" }),
      ],
      staffPersonIds: new Set(),
    });
    expect(r).toEqual({ kind: "auto_merge_anon", anonPersonId: "A", representativeDetectionId: "d1" });
  });

  test("auto_link_null: exatamente 1 detection NULL e 0 anônimos", () => {
    const r = decideCheckinMatch({
      candidatePersonId: Y,
      detections: [det({ id: "n1", person_id: null, person_type: null, session_id: "s1" })],
      staffPersonIds: new Set(),
    });
    expect(r).toEqual({ kind: "auto_link_null", detectionId: "n1", sessionId: "s1" });
  });

  test("exclui staff: anônimo staff-like é removido; se era o único → rejected", () => {
    const r = decideCheckinMatch({
      candidatePersonId: Y,
      detections: [det({ id: "d1", person_id: "STAFF", person_type: "anonymous" })],
      staffPersonIds: new Set(["STAFF"]),
    });
    expect(r.kind).toBe("rejected");
  });

  test("exclui outro cliente (person_type client != Y)", () => {
    const r = decideCheckinMatch({
      candidatePersonId: Y,
      detections: [det({ id: "d1", person_id: "OUTRO", person_type: "client" })],
      staffPersonIds: new Set(),
    });
    expect(r.kind).toBe("rejected");
  });

  test("ambiguous colapsado: ≥2 anônimos distintos → 1 candidato por pessoa (não por detecção)", () => {
    const r = decideCheckinMatch({
      candidatePersonId: Y,
      detections: [
        det({ id: "a1", person_id: "A", person_type: "anonymous" }),
        det({ id: "a2", person_id: "A", person_type: "anonymous" }),
        det({ id: "b1", person_id: "B", person_type: "anonymous" }),
      ],
      staffPersonIds: new Set(),
    });
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.anonCandidates).toEqual([
        { personId: "A", detectionId: "a1" },
        { personId: "B", detectionId: "b1" },
      ]);
      expect(r.nullDetectionCount).toBe(0);
    }
  });

  test("ambiguous misto: 1 anônimo + 2 nulls → anon candidate + nullDetectionCount", () => {
    const r = decideCheckinMatch({
      candidatePersonId: Y,
      detections: [
        det({ id: "a1", person_id: "A", person_type: "anonymous" }),
        det({ id: "n1", person_id: null }),
        det({ id: "n2", person_id: null }),
      ],
      staffPersonIds: new Set(),
    });
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.anonCandidates).toEqual([{ personId: "A", detectionId: "a1" }]);
      expect(r.nullDetectionCount).toBe(2);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/edge && bun test tests/unit/match-temp/candidates.test.ts`
Expected: FAIL (module não existe).

- [ ] **Step 3: Implement `candidates.ts`**

```ts
/**
 * Onda 9-D — decisão pura do match-temporal por checkin.
 *
 * Classifica os detections da janela ±N seg em torno do checkin do cliente Y e
 * decide a ação. Pura (sem DB) — o caller (orchestrator) resolve person_type via
 * JOIN e calcula staffPersonIds antes de chamar. Veja spec §4 Part B.
 *
 * Regras:
 *  - detection ligada a Y               → convergente (match já existe).
 *  - person_type employee               → excluído (funcionário ≠ quem deu checkin).
 *  - person_type client e != Y          → excluído (outro cliente).
 *  - anônimo em staffPersonIds           → excluído (onipresente/staff).
 *  - anônimo (resto)                    → candidato (agrupado por person_id).
 *  - person_id NULL                     → candidato "não-ligado".
 *
 * Decisão (conservadora — auto-merge só com exatamente 1 candidato específico):
 *  - 0 candidatos                       → rejected.
 *  - 1 anônimo distinto, 0 null         → auto_merge_anon (mergeInto anon→Y).
 *  - 0 anônimo, 1 null                  → auto_link_null (link clássico).
 *  - ≥2 candidatos (qualquer mix)       → ambiguous (1 attempt por anônimo + nulls).
 */
export type PersonType = "client" | "employee" | "anonymous";

export interface WindowDetection {
  id: string;
  person_id: string | null;
  person_type: PersonType | null; // null sse person_id null
  session_id: string | null;
}

export interface DecideInput {
  candidatePersonId: string;
  detections: WindowDetection[];
  staffPersonIds: ReadonlySet<string>;
}

export type CheckinDecision =
  | { kind: "convergent" }
  | { kind: "rejected" }
  | { kind: "auto_merge_anon"; anonPersonId: string; representativeDetectionId: string }
  | { kind: "auto_link_null"; detectionId: string; sessionId: string | null }
  | {
      kind: "ambiguous";
      anonCandidates: Array<{ personId: string; detectionId: string }>;
      nullDetectionCount: number;
    };

export function decideCheckinMatch(input: DecideInput): CheckinDecision {
  const { candidatePersonId, detections, staffPersonIds } = input;

  // Convergente: qualquer detection já ligada a Y satisfaz o checkin.
  if (detections.some((d) => d.person_id === candidatePersonId)) {
    return { kind: "convergent" };
  }

  // Agrupa anônimos NÃO-staff por person_id (preserva 1ª detection como representante,
  // na ordem de entrada — caller ordena por detected_at asc). Conta nulls.
  const anonByPerson = new Map<string, string>(); // personId -> representativeDetectionId
  let nullDetectionCount = 0;
  let firstNull: { id: string; sessionId: string | null } | null = null;

  for (const d of detections) {
    if (d.person_id === null) {
      nullDetectionCount += 1;
      if (firstNull === null) firstNull = { id: d.id, sessionId: d.session_id };
      continue;
    }
    if (d.person_type === "employee") continue; // funcionário
    if (d.person_type === "client") continue; // outro cliente (Y já tratado acima)
    // anônimo:
    if (staffPersonIds.has(d.person_id)) continue; // onipresente/staff
    if (!anonByPerson.has(d.person_id)) anonByPerson.set(d.person_id, d.id);
  }

  const anonCount = anonByPerson.size;

  if (anonCount === 0 && nullDetectionCount === 0) return { kind: "rejected" };

  if (anonCount === 1 && nullDetectionCount === 0) {
    const [[anonPersonId, representativeDetectionId]] = [...anonByPerson.entries()];
    return { kind: "auto_merge_anon", anonPersonId, representativeDetectionId };
  }

  if (anonCount === 0 && nullDetectionCount === 1 && firstNull) {
    return { kind: "auto_link_null", detectionId: firstNull.id, sessionId: firstNull.sessionId };
  }

  return {
    kind: "ambiguous",
    anonCandidates: [...anonByPerson.entries()].map(([personId, detectionId]) => ({
      personId,
      detectionId,
    })),
    nullDetectionCount,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/edge && bun test tests/unit/match-temp/candidates.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
cd packages/edge && bun run typecheck
git add packages/edge/src/match-temp/candidates.ts packages/edge/tests/unit/match-temp/candidates.test.ts
git commit -m "feat(edge): Onda 9-D — decideCheckinMatch puro (classificação + decisão)"
```

---

## Chunk 3: Plumbing de DB (person_type na janela + isStaffLike)

### Task 3: `findInWindow` retorna `person_type` (JOIN persons)

**Files:**
- Modify: `packages/edge/src/persistence/repositories/detections.repo.ts`
- Test: `packages/edge/tests/integration/persistence/detections-find-in-window.test.ts` (existe — estender)

- [ ] **Step 1: Write the failing test (integração — roda onde há Postgres)**

Adicionar caso ao teste existente afirmando que `findInWindow` inclui `person_type`
(null p/ person_id null; 'anonymous'/'client'/'employee' conforme a person). Estrutura:
inserir 1 detection NULL, 1 ligada a person anonymous, 1 ligada a employee; chamar
`findInWindow(start,end)`; asserir `person_type` correto em cada.

```ts
test("findInWindow inclui person_type (null quando person_id null)", async () => {
  // ... cria camera, persons (anonymous + employee), detections ...
  const rows = await detectionsRepo.findInWindow(start, end);
  const byId = new Map(rows.map((r) => [r.id, r]));
  expect(byId.get(nullDetId)?.person_type).toBeNull();
  expect(byId.get(anonDetId)?.person_type).toBe("anonymous");
  expect(byId.get(empDetId)?.person_type).toBe("employee");
});
```

- [ ] **Step 2: Verify fail (typecheck)** — `person_type` não existe no retorno.
Run: `cd packages/edge && bun run typecheck` → erro de propriedade ausente no teste.

- [ ] **Step 3: Implement** — alterar `findInWindow` p/ LEFT JOIN persons e projetar person_type:

```ts
import { persons } from "../schema/persons.js";
// ...
async findInWindow(start: Date, end: Date): Promise<Array<{
  id: string; detected_at: Date; person_id: string | null;
  person_type: "client" | "employee" | "anonymous" | null;
  session_id: string | null; snapshot_path: string | null;
}>> {
  return getDb()
    .select({
      id: detections.id,
      detected_at: detections.detected_at,
      person_id: detections.person_id,
      person_type: persons.person_type,
      session_id: detections.session_id,
      snapshot_path: detections.snapshot_path,
    })
    .from(detections)
    .leftJoin(persons, eq(detections.person_id, persons.id))
    .where(between(detections.detected_at, start, end))
    .orderBy(asc(detections.detected_at));
}
```

(adicionar `eq` ao import de drizzle-orm se ausente.)

- [ ] **Step 4: Run** — `cd packages/edge && bun run typecheck` limpo; teste de integração passa onde há Postgres.

- [ ] **Step 5: Commit**

```bash
git add packages/edge/src/persistence/repositories/detections.repo.ts packages/edge/tests/integration/persistence/detections-find-in-window.test.ts
git commit -m "feat(edge): Onda 9-D — findInWindow projeta person_type (JOIN persons)"
```

### Task 4: `persons.isStaffLike` + **validação empírica do threshold**

**Files:**
- Modify: `packages/edge/src/persistence/repositories/persons.repo.ts`
- Test: `packages/edge/tests/integration/persistence/persons-staff-like.test.ts` (**novo**)

- [ ] **Step 1: VALIDAÇÃO EMPÍRICA (antes de fixar o default) — rodar na VPS**

Medir quantos anônimos seriam marcados staff em vários thresholds, e inspecionar se
"parecem staff". Rodar e COLAR no PR/discussão antes de confirmar STAFF_MIN_ACTIVE_HOURS:

```bash
DB_URL="$(sudo grep -E '^DATABASE_URL=' /etc/vipcam/edge.env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
psql "$DB_URL" -c "
WITH ah AS (
  SELECT person_id, count(DISTINCT date_trunc('hour', detected_at)) AS active_hours
  FROM detections
  WHERE person_id IS NOT NULL AND detected_at >= now() - interval '7 days'
  GROUP BY person_id
)
SELECT
  count(*) FILTER (WHERE active_hours >= 10) AS staff_thr10,
  count(*) FILTER (WHERE active_hours >= 20) AS staff_thr20,
  count(*) FILTER (WHERE active_hours >= 30) AS staff_thr30,
  count(*) AS total_persons
FROM ah;"
```
Ajustar `STAFF_MIN_ACTIVE_HOURS` (Task 1) se a contagem em 20 parecer alta/baixa demais.
**Não prosseguir sem revisar este número.**

- [ ] **Step 2: Write the failing test (integração)**

`persons-staff-like.test.ts`: inserir detections p/ 2 persons — uma com detecções
espalhadas em ≥ `minHours` slots de hora distintos (staff), outra com 1 slot (cliente);
asserir `isStaffLike(staffId, 7, 3) === true` e `isStaffLike(clientId, 7, 3) === false`.
(usar `minHours` pequeno no teste p/ não precisar gerar 20h de dados.)

- [ ] **Step 3: Implement**

```ts
/**
 * Onda 9-D — heurística "staff-like / onipresente": person com detecções em
 * >= minHours slots de hora distintos nos últimos lookbackDays dias. Proxy de
 * "presente o dia todo, todo dia" (≠ cliente ~1h). Excluído dos candidatos do
 * checkin no match-temporal. Query indexada (detections_person_idx + detected_idx).
 */
async isStaffLike(personId: string, lookbackDays: number, minHours: number): Promise<boolean> {
  const [row] = await getDb()
    .select({ activeHours: sql<number>`count(distinct date_trunc('hour', ${detections.detected_at}))::int` })
    .from(detections)
    .where(and(
      eq(detections.person_id, personId),
      sql`${detections.detected_at} >= now() - (${lookbackDays} || ' days')::interval`,
    ));
  return (row?.activeHours ?? 0) >= minHours;
}
```
(importar `detections` schema + `and`/`sql`/`eq` no persons.repo.ts.)

- [ ] **Step 4: Run** — typecheck limpo; teste passa onde há Postgres.

- [ ] **Step 5: Commit**

```bash
git add packages/edge/src/persistence/repositories/persons.repo.ts packages/edge/tests/integration/persistence/persons-staff-like.test.ts
git commit -m "feat(edge): Onda 9-D — persons.isStaffLike (heurística de onipresença)"
```

---

## Chunk 4: Integração no orchestrator (B1+B2+B3)

### Task 5: `processCheckin` usa `decideCheckinMatch` + executa a decisão

**Files:**
- Modify: `packages/edge/src/match-temp/orchestrator.ts`
- Test: `packages/edge/tests/integration/match-temp/orchestrator.test.ts` (existe — estender/ajustar)
- Test: `packages/edge/tests/integration/match-temp/divergent.test.ts` (existe — ajustar p/ novo comportamento colapsado)

- [ ] **Step 1: Ajustar/escrever os testes de integração (red)**

Cenários (mock/seed detections+persons+checkin, chamar `processCheckin`, asserir efeitos):
1. **1 anônimo distinto** na janela → `mergeInto(anon→Y)` ocorreu (anon sumiu, detections agora em Y) + `match_attempts` 1 row `auto_matched`/`system` com `previous_person_id=anon`.
2. **≥2 anônimos** → N attempts `ambiguous` (1 por pessoa, não por detecção) + nenhum merge.
3. **candidato employee/other-client** → excluído (não vira attempt; se era o único → rejected/no attempt).
4. **anônimo staff-like** (gerar presença alta com minHours baixo via env de teste) → excluído.
5. **convergente** (detection já em Y) → no-op (sem attempt, sem merge).
6. **idempotência**: 2ª chamada após `processed_at` setado → no-op.

- [ ] **Step 2: Run → fail** (comportamento antigo: per-detection divergent).

- [ ] **Step 3: Implement** — reescrever o miolo de `processCheckin`. Esqueleto:

```ts
// ... dentro de processCheckin, após computar window:
const env = getEnv();
const all = await detectionsRepo.findInWindow(window.start, window.end);

await getDb().transaction(async (tx) => {
  // bootstrap candidatePerson (Y) — IGUAL ao atual (lookup/insert persons by erp_client_id)
  // ... candidatePerson ...

  // B2: calcula staffPersonIds entre os anônimos distintos da janela
  const anonIds = [...new Set(
    all.filter((d) => d.person_type === "anonymous" && d.person_id).map((d) => d.person_id as string),
  )];
  const staffPersonIds = new Set<string>();
  for (const pid of anonIds) {
    if (await personsRepo.isStaffLike(pid, env.STAFF_LOOKBACK_DAYS, env.STAFF_MIN_ACTIVE_HOURS)) {
      staffPersonIds.add(pid);
    }
  }

  // decisão pura
  const decision = decideCheckinMatch({
    candidatePersonId: candidatePerson.id,
    detections: all.map((d) => ({
      id: d.id, person_id: d.person_id, person_type: d.person_type, session_id: d.session_id,
    })),
    staffPersonIds,
  });

  // executa
  switch (decision.kind) {
    case "convergent":
    case "rejected":
      break; // no-op
    case "auto_link_null":
      await tx.insert(matchAttempts).values({
        detection_id: decision.detectionId, erp_checkin_id: checkin.erp_id,
        decision: "auto_matched", decided_by: "system",
      });
      await tx.update(detections).set({ person_id: candidatePerson.id }).where(eq(detections.id, decision.detectionId));
      if (decision.sessionId) {
        await tx.update(sessions).set({ person_id: candidatePerson.id, linked_erp_checkin_id: checkin.erp_id }).where(eq(sessions.id, decision.sessionId));
      }
      break;
    case "auto_merge_anon":
      // mergeInto abre própria transação — chamar FORA desta tx (ver nota abaixo).
      break; // tratado pós-tx
    case "ambiguous":
      for (const c of decision.anonCandidates) {
        const [prev] = await tx.select().from(persons).where(eq(persons.id, c.personId)).limit(1);
        await tx.insert(matchAttempts).values({
          detection_id: c.detectionId, erp_checkin_id: checkin.erp_id,
          decision: "ambiguous", decided_by: "system",
          previous_person_id: c.personId,
          previous_person_snapshot: prev as unknown as Record<string, unknown>,
        });
      }
      if (decision.nullDetectionCount > 0) {
        await tx.insert(matchAttempts).values({
          erp_checkin_id: checkin.erp_id, decision: "ambiguous", decided_by: "system",
          notes: `${decision.nullDetectionCount} null candidates`,
        });
      }
      break;
  }

  await tx.update(erpCheckins).set({ processed_at: sql`now()` }).where(eq(erpCheckins.erp_id, checkin.erp_id));
});

// auto_merge_anon: mergeInto gerencia sua própria transação (lock FOR UPDATE) — não
// aninhar. Após marcar processed_at acima, fazer o merge + registrar o attempt.
// NOTA DE IMPLEMENTAÇÃO: para manter atomicidade, OU (a) mover o set processed_at p/
// depois do merge, OU (b) aceitar que merge roda logo após. Decidir no detalhe; o
// teste de idempotência cobre o caso de falha. Recomendado: fazer o merge ANTES de
// setar processed_at, fora da tx de attempts, com try/catch /not found/ → log e segue.
```

> **Decisão de implementação (resolver na execução):** `mergeInto` abre sua própria
> `db.transaction` com `FOR UPDATE`, então NÃO pode rodar dentro da `tx` acima (nested).
> Padrão recomendado: para `auto_merge_anon`, (1) `await personsRepo.mergeInto(anon,
> candidatePerson.id, "system")` tratando `/not found/` (race → log, cai p/ ambiguous ou
> skip), (2) inserir o `match_attempts` (`auto_matched`/`system`, `previous_person_id=anon`,
> `detection_id=representative`), (3) setar `processed_at`. Espelha `resolveDivergent`.

- [ ] **Step 4: Run → pass** (cenários 1-6). `cd packages/edge && bun run typecheck`.

- [ ] **Step 5: Rodar suíte unit completa** (garante que nada quebrou):

Run: `cd packages/edge && bun test tests/unit` → tudo verde.

- [ ] **Step 6: Commit**

```bash
git add packages/edge/src/match-temp/orchestrator.ts packages/edge/tests/integration/match-temp/*.test.ts
git commit -m "feat(edge): Onda 9-D — processCheckin colapsa + exclui staff + auto-resolve single"
```

---

## Chunk 5: Backfill (drenar a fila existente)

### Task 6: `scripts/backfill-rematch.ts` (--dry-run / --apply)

Re-avalia checkins com attempts `ambiguous` pendentes aplicando a mesma decisão, e
reporta (dry-run) ou aplica (merges + colapso). Idempotente.

**Files:**
- Create: `packages/edge/scripts/backfill-rematch.ts`

- [ ] **Step 1: Implement** (estrutura)

```ts
// Uso: bun scripts/backfill-rematch.ts [--apply]
// Default: --dry-run (só reporta). DATABASE_URL vem do env (systemd/edge.env).
import { getEnv } from "../src/config/env.js";
// ... imports: getDb, repos, decideCheckinMatch, computeWindow ...

const APPLY = process.argv.includes("--apply");

async function main() {
  // 1. distinct erp_checkin_id com attempts ambiguous pendentes
  // 2. para cada checkin: recomputa window + findInWindow + staffPersonIds + decideCheckinMatch
  // 3. agrega contadores: would_auto_merge, would_collapse_to_N, would_stay_ambiguous, would_reject
  // 4. se APPLY: dentro de tx por checkin — apaga os attempts ambiguous antigos do checkin,
  //    aplica a decisão nova (merge / link / insere attempts colapsados). Idempotente.
  // 5. imprime relatório agregado.
  console.log(JSON.stringify(report, null, 2));
}
main().then(() => process.exit(0));
```

> Detalhe: no `--apply`, para `auto_merge_anon`, usar `personsRepo.mergeInto`. Apagar os
> attempts antigos do checkin ANTES de inserir os novos (evita duplicar). Tudo por-checkin
> em transação; um checkin que falha não derruba os outros (try/catch + log).

- [ ] **Step 2: Smoke test local (typecheck + dry-run sintático)**

Run: `cd packages/edge && bun run typecheck`
(Execução real do dry-run é na VPS — Task 7 — pois precisa do Postgres com dados.)

- [ ] **Step 3: Commit**

```bash
git add packages/edge/scripts/backfill-rematch.ts
git commit -m "feat(edge): Onda 9-D — backfill-rematch (dry-run/apply) p/ drenar fila existente"
```

---

## Chunk 6: Deploy & verificação (VPS)

### Task 7: Deploy + validação + backfill

- [ ] **Step 1:** finishing-a-development-branch (merge p/ master) + `git push origin master`.
- [ ] **Step 2:** VPS: `cd /opt/vipcamv2 && sudo ./scripts/deploy.sh`.
- [ ] **Step 3:** `edge.env`: confirmar/ajustar `REID_DIST_STRICT=0.40` (e `STAFF_MIN_ACTIVE_HOURS`/`STAFF_LOOKBACK_DAYS` se override pós-validação). `systemctl restart vipcam-edge`.
- [ ] **Step 4:** rodar a **validação empírica** do threshold de staff (query da Task 4 Step 1); ajustar env se preciso.
- [ ] **Step 5:** **dry-run** do backfill e revisar:
  ```bash
  cd /opt/vipcamv2/packages/edge && sudo -u vipcam env DATABASE_URL="$DB_URL" bun scripts/backfill-rematch.ts
  ```
  Conferir os totais (auto_merge / colapso / mantidos ambíguos). Se fizer sentido:
- [ ] **Step 6:** **apply**: `... bun scripts/backfill-rematch.ts --apply`.
- [ ] **Step 7:** conferir `SELECT decision, count(*) FROM match_attempts GROUP BY decision;` — `ambiguous` despencou, `auto_matched` subiu. Observar a taxa de novos ambíguos/dia cair.

---

## Notas de execução

- **Integração precisa de Postgres de teste** (`vipcam_test`, débito pendente) — Tasks 3,4,5
  têm testes de integração que rodam na VPS/CI; gate local é typecheck + unit. Tasks 1,2 são unit (rodam local).
- **`mergeInto` não aninha** em transação externa (abre a própria com FOR UPDATE) — ver nota na Task 5.
- **Forward-only no runtime**; o backfill (Task 6/7) é o que limpa os 2152 atuais.
- **Sem migration.**
