# Onda 9-C — Checkin Ingestion Fix Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer `pollCheckins` voltar a ingerir checkins do ERP (tabela `agendas`),
desbloqueando o match-temporal e o tab `/matches`.

**Architecture:** Três peças. (1) Pool mysql2 fixa `timezone:-03:00` pra `agendas.data`
(wall-clock BRT) virar instante UTC correto. (2) `pollCheckins` troca o cursor monotônico
(quebrado: a coluna `data_alteracao` é NULL) por **janela deslizante** `data >= now−lookback`
com clock injetável, deduplicando por `erp_id` via insert batch `ON CONFLICT DO NOTHING`.
(3) A query real (`data AS occurred_at`) é atualizada no `/etc/vipcam/edge.env` no deploy.

**Tech Stack:** Bun + Hono + Drizzle + Postgres (edge); mysql2/promise (replica ERP);
bun:test.

**Spec:** `docs/superpowers/specs/2026-05-31-onda-9c-checkin-ingestion-fix-design.md` (ff7a0a5)

---

## File Structure

| Arquivo | Responsabilidade | Mudança |
|---|---|---|
| `packages/edge/src/config/env.ts` | env schema | `+ERP_TZ_OFFSET` (def `-03:00`), `+ERP_CHECKINS_LOOKBACK_HOURS` (def 24) |
| `packages/edge/src/erp-sync/mysql-client.ts` | pool mysql2 | extrai `buildErpPoolConfig(env)` puro; pool com `timezone` |
| `packages/edge/src/persistence/repositories/erp.repo.ts` | repo ERP | `+insertCheckinsIgnore(rows)` batch |
| `packages/edge/src/erp-sync/checkins.ts` | poll de checkins | reescrita: janela deslizante + clock + dedup batch; remove cursor |
| `packages/edge/tests/unit/erp-sync/mysql-client.test.ts` | **novo** | `buildErpPoolConfig` inclui timezone |
| `packages/edge/tests/integration/persistence/erp-checkins-insert-ignore.test.ts` | **novo** | dedup batch |
| `packages/edge/tests/unit/erp-sync/checkins-window.test.ts` | **novo** | `computeSince` puro |
| `packages/edge/tests/integration/erp-sync/checkins.test.ts` | existente | reescrito p/ nova semântica |

**Sem migration.** Nenhuma mudança de schema.

**Patterns a seguir:**
- Defaults de env genéricos; produção sobrescreve via `edge.env` (não mudar a default da query).
- mysql2: `mysql.createPool(config)` (vide `mysql-client.ts` atual).
- Repo: drizzle `insert().onConflictDoNothing({target}).returning(...)` (espelha `upsertCheckin`).
- Testes integração: `truncateAll()` em `beforeEach`, `closeDb()` em `afterAll`,
  `mock.module("../../../src/erp-sync/queries.js", ...)` p/ stubar `fetchErpCheckinsSince`.

---

## Chunk 1: Implementação

### Task 1: Pool mysql2 com timezone (`buildErpPoolConfig` + `ERP_TZ_OFFSET`)

Causa do bug latente de tz: o edge roda em UTC; sem `timezone` no mysql2, `agendas.data`
(`'2026-05-30 20:30:00'` BRT) seria lido como `20:30Z` (3h errado) e a janela ±5min nunca
casaria com `detected_at` (UTC verdadeiro do `RealUTC` da câmera). Fix: fixar
`timezone: ERP_TZ_OFFSET` (`-03:00`). O seam testável é uma função pura que monta a config
do pool (não dá pra unit-testar o parser interno do mysql2 sem conexão real).

**Files:**
- Modify: `packages/edge/src/config/env.ts` (bloco ERP, após linha 49)
- Modify: `packages/edge/src/erp-sync/mysql-client.ts:5-19`
- Create: `packages/edge/tests/unit/erp-sync/mysql-client.test.ts`

- [ ] **Step 1: Add env var `ERP_TZ_OFFSET`**

Em `env.ts`, logo após o bloco `ERP_CHECKINS_INITIAL_LOOKBACK_HOURS` (linha 49):

```ts
    // Onda 9-C: offset do timezone em que o ERP grava DATETIMEs (agendas.data é
    // wall-clock BRT). O edge roda em UTC; sem isso o mysql2 leria '20:30' como
    // 20:30Z (3h errado) e a janela do match-temporal nunca casaria com
    // detected_at (UTC do RealUTC da câmera). Brasil sem DST desde 2019 → offset
    // fixo é seguro. Formato mysql2: "±HH:MM".
    ERP_TZ_OFFSET: z
      .string()
      .regex(/^[+-]\d{2}:\d{2}$/, "ERP_TZ_OFFSET must look like -03:00")
      .default("-03:00"),
```

- [ ] **Step 2: Write the failing test**

Create `packages/edge/tests/unit/erp-sync/mysql-client.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildErpPoolConfig } from "../../../src/erp-sync/mysql-client.js";

describe("buildErpPoolConfig", () => {
  test("inclui timezone do env (BRT->UTC correto) + uri", () => {
    const cfg = buildErpPoolConfig({
      ERP_MYSQL_URL: "mysql://u:p@h:3306/db",
      ERP_TZ_OFFSET: "-03:00",
    });
    expect(cfg.uri).toBe("mysql://u:p@h:3306/db");
    expect(cfg.timezone).toBe("-03:00");
    // pool defensivo: limites preservados
    expect(cfg.connectionLimit).toBe(5);
    expect(cfg.waitForConnections).toBe(true);
    expect(cfg.queueLimit).toBe(0);
  });

  test("propaga offset custom (ex: outro fuso)", () => {
    const cfg = buildErpPoolConfig({
      ERP_MYSQL_URL: "mysql://x",
      ERP_TZ_OFFSET: "+00:00",
    });
    expect(cfg.timezone).toBe("+00:00");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/edge && bun test tests/unit/erp-sync/mysql-client.test.ts`
Expected: FAIL — `buildErpPoolConfig` não existe (import error).

- [ ] **Step 4: Implement `buildErpPoolConfig` + wire no pool**

Em `mysql-client.ts`, substituir o topo do arquivo (linhas 1-19) por:

```ts
import mysql, { type Pool, type PoolConnection, type PoolOptions } from "mysql2/promise";
import { getEnv } from "../config/env.js";
import { logger } from "../obs/logger.js";

let _pool: Pool | undefined;

/**
 * Monta a config do pool mysql2. Função pura (testável) — o `timezone` é a peça
 * crítica: faz o mysql2 interpretar os DATETIMEs do ERP (wall-clock BRT) como o
 * instante UTC correto, tanto na leitura (agendas.data → Date) quanto na
 * serialização do `?` (since: Date → literal). Sem isso, o edge (UTC) leria
 * '20:30' como 20:30Z e o match-temporal erraria 3h. (Onda 9-C)
 */
export function buildErpPoolConfig(env: {
  ERP_MYSQL_URL: string;
  ERP_TZ_OFFSET: string;
}): PoolOptions {
  return {
    uri: env.ERP_MYSQL_URL,
    timezone: env.ERP_TZ_OFFSET,
    connectionLimit: 5,
    waitForConnections: true,
    queueLimit: 0,
  };
}

export function getErpPool(): Pool {
  if (_pool) return _pool;
  const env = getEnv();
  if (!env.ERP_MYSQL_URL) throw new Error("ERP_MYSQL_URL is required");
  _pool = mysql.createPool(buildErpPoolConfig({
    ERP_MYSQL_URL: env.ERP_MYSQL_URL,
    ERP_TZ_OFFSET: env.ERP_TZ_OFFSET,
  }));
  logger.info({ timezone: env.ERP_TZ_OFFSET }, "ERP MySQL pool initialized");
  return _pool;
}
```

(O restante do arquivo — `withErpConn`, `closeErpPool` — fica inalterado.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/edge && bun test tests/unit/erp-sync/mysql-client.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck**

Run: `cd packages/edge && bun run typecheck`
Expected: sem erros (atenção: `PoolOptions` importado de `mysql2/promise`).

- [ ] **Step 7: Commit**

```bash
git add packages/edge/src/config/env.ts packages/edge/src/erp-sync/mysql-client.ts packages/edge/tests/unit/erp-sync/mysql-client.test.ts
git commit -m "feat(edge): Onda 9-C — pool mysql2 fixa timezone ERP (-03:00) p/ DATETIMEs corretos"
```

---

### Task 2: `insertCheckinsIgnore` batch no repo

Re-scan de ~1 dia a cada 30s precisa de dedup barato. Hoje é `findCheckinByErpId` por
linha (N selects). Troca por 1 insert batch `ON CONFLICT (erp_id) DO NOTHING`, retornando
só as linhas realmente inseridas (conflitos não são retornados → contagem de novos).

**Files:**
- Modify: `packages/edge/src/persistence/repositories/erp.repo.ts` (seção Checkins, após `upsertCheckin`, ~linha 103)
- Create: `packages/edge/tests/integration/persistence/erp-checkins-insert-ignore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/edge/tests/integration/persistence/erp-checkins-insert-ignore.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb } from "../../../src/persistence/db.js";
import { erpRepo } from "../../../src/persistence/repositories/index.js";
import { truncateAll } from "./_helpers.js";

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await closeDb();
});

function row(erpId: string) {
  return {
    erp_id: erpId,
    erp_client_id: "100",
    event_type: "appointment_confirmed",
    occurred_at: new Date("2026-05-30T23:30:00Z"),
    metadata: {},
  };
}

describe("erpRepo.insertCheckinsIgnore", () => {
  test("insere todos quando nenhum existe; retorna count", async () => {
    const n = await erpRepo.insertCheckinsIgnore([row("10"), row("11")]);
    expect(n).toBe(2);
    expect(await erpRepo.findCheckinByErpId("10")).not.toBeNull();
    expect(await erpRepo.findCheckinByErpId("11")).not.toBeNull();
  });

  test("pula erp_id já existente (ON CONFLICT DO NOTHING) e NÃO reseta processed_at", async () => {
    await erpRepo.insertCheckinsIgnore([row("10")]);
    await erpRepo.markCheckinProcessed("10");

    // segunda leva: '10' repetido + '12' novo
    const n = await erpRepo.insertCheckinsIgnore([row("10"), row("12")]);
    expect(n).toBe(1); // só o 12 é novo

    const c10 = await erpRepo.findCheckinByErpId("10");
    expect(c10?.processed_at).not.toBeNull(); // preservado, não clobrado
    expect(await erpRepo.findCheckinByErpId("12")).not.toBeNull();
  });

  test("lista vazia → 0, sem query", async () => {
    expect(await erpRepo.insertCheckinsIgnore([])).toBe(0);
  });
});
```

> NOTA: confirme o caminho do helper `truncateAll` — testes em
> `tests/integration/persistence/` importam de `./_helpers.js` (mesmo dir). Os de
> `tests/integration/erp-sync/` importam de `../persistence/_helpers.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/edge && bun test tests/integration/persistence/erp-checkins-insert-ignore.test.ts`
Expected: FAIL — `insertCheckinsIgnore` não existe.

- [ ] **Step 3: Implement `insertCheckinsIgnore`**

Em `erp.repo.ts`, importar `NewErpCheckin` já existe (linha 7). Adicionar após
`upsertCheckin` (antes de `findCheckinByErpId`, ~linha 104):

```ts
  /**
   * Insert batch idempotente: pula erp_ids já existentes (ON CONFLICT DO NOTHING).
   * Retorna o nº de linhas REALMENTE inseridas (conflitos não voltam no returning).
   * Usado pelo pollCheckins (Onda 9-C) que re-escaneia a janela deslizante a cada
   * 30s — dedup barato em 1 round-trip, sem clobber de metadata/processed_at das
   * já cacheadas (diferente de upsertCheckin, que faz DO UPDATE).
   */
  async insertCheckinsIgnore(rows: NewErpCheckin[]): Promise<number> {
    if (rows.length === 0) return 0;
    const inserted = await getDb()
      .insert(erpCheckins)
      .values(rows)
      .onConflictDoNothing({ target: erpCheckins.erp_id })
      .returning({ erp_id: erpCheckins.erp_id });
    return inserted.length;
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/edge && bun test tests/integration/persistence/erp-checkins-insert-ignore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/edge/src/persistence/repositories/erp.repo.ts packages/edge/tests/integration/persistence/erp-checkins-insert-ignore.test.ts
git commit -m "feat(edge): Onda 9-C — erpRepo.insertCheckinsIgnore (dedup batch ON CONFLICT DO NOTHING)"
```

---

### Task 3: `computeSince` puro (janela deslizante)

A semântica nova: cada poll busca `data >= now − lookbackHours`. Extraímos o cálculo
numa função pura testável antes de reescrever o `pollCheckins`.

**Files:**
- Modify: `packages/edge/src/config/env.ts` (após `ERP_TZ_OFFSET`)
- Create: `packages/edge/tests/unit/erp-sync/checkins-window.test.ts`
- Modify: `packages/edge/src/erp-sync/checkins.ts` (export `computeSince` — implementação completa na Task 4)

- [ ] **Step 1: Add env var `ERP_CHECKINS_LOOKBACK_HOURS`**

Em `env.ts`, após o bloco `ERP_TZ_OFFSET` (Task 1):

```ts
    // Onda 9-C: tamanho da janela deslizante do pollCheckins. Cada poll re-escaneia
    // `data >= now − N horas` (sem cursor monotônico — `agendas.data` não é
    // monotônico com o instante do check-in). 24h cobre um dia de operação +
    // gaps de restart; dedup por erp_id evita re-inserção. Substitui o papel de
    // ERP_CHECKINS_INITIAL_LOOKBACK_HOURS (que era só p/ greenfield).
    ERP_CHECKINS_LOOKBACK_HOURS: z.coerce.number().int().positive().default(24),
```

- [ ] **Step 2: Write the failing test**

Create `packages/edge/tests/unit/erp-sync/checkins-window.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { computeSince } from "../../../src/erp-sync/checkins.js";

describe("computeSince", () => {
  test("subtrai lookbackHours do now", () => {
    const now = new Date("2026-05-31T14:00:00Z");
    const since = computeSince(now, 24);
    expect(since.toISOString()).toBe("2026-05-30T14:00:00.000Z");
  });

  test("lookback diferente (12h)", () => {
    const now = new Date("2026-05-31T14:00:00Z");
    expect(computeSince(now, 12).toISOString()).toBe("2026-05-31T02:00:00.000Z");
  });

  test("não muta o now recebido", () => {
    const now = new Date("2026-05-31T14:00:00Z");
    computeSince(now, 24);
    expect(now.toISOString()).toBe("2026-05-31T14:00:00.000Z");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/edge && bun test tests/unit/erp-sync/checkins-window.test.ts`
Expected: FAIL — `computeSince` não existe.

- [ ] **Step 4: Add `computeSince` to `checkins.ts`**

(A reescrita completa do arquivo vem na Task 4; aqui só garanta que a função exista e o
teste passe. Se preferir, implemente já a Task 4 inteira e rode os dois testes juntos.)

```ts
/** Início da janela deslizante: now − lookbackHours. Pura (Onda 9-C). */
export function computeSince(now: Date, lookbackHours: number): Date {
  return new Date(now.getTime() - lookbackHours * 3_600_000);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/edge && bun test tests/unit/erp-sync/checkins-window.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/edge/src/config/env.ts packages/edge/src/erp-sync/checkins.ts packages/edge/tests/unit/erp-sync/checkins-window.test.ts
git commit -m "feat(edge): Onda 9-C — computeSince + ERP_CHECKINS_LOOKBACK_HOURS (janela deslizante)"
```

---

### Task 4: Reescrita do `pollCheckins` (janela deslizante + clock + dedup batch)

Substitui o cursor monotônico (in-memory, reconciliado no boot) por janela deslizante com
clock injetável. Remove `cursor`, `getInitialCursor`, `_resetCursor`.

**Files:**
- Modify: `packages/edge/src/erp-sync/checkins.ts` (reescrita completa)
- Modify: `packages/edge/tests/integration/erp-sync/checkins.test.ts` (reescrita)

- [ ] **Step 1: Rewrite the integration test first (red)**

Substituir TODO `packages/edge/tests/integration/erp-sync/checkins.test.ts` por:

```ts
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { pollCheckins } from "../../../src/erp-sync/checkins.js";
import * as queries from "../../../src/erp-sync/queries.js";
import { closeDb } from "../../../src/persistence/db.js";
import { erpRepo } from "../../../src/persistence/repositories/index.js";
import { truncateAll } from "../persistence/_helpers.js";

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await closeDb();
});

const NOW = new Date("2026-05-31T14:00:00Z");
const clock = () => NOW;

function stubFetch(rows: unknown[], capture?: (since: Date) => void) {
  mock.module("../../../src/erp-sync/queries.js", () => ({
    ...queries,
    fetchErpCheckinsSince: async (since: Date) => {
      capture?.(since);
      return rows as never;
    },
  }));
}

describe("pollCheckins (janela deslizante)", () => {
  test("passa since = now − lookback (default 24h) pro fetch", async () => {
    let seen: Date | undefined;
    stubFetch([], (s) => {
      seen = s;
    });
    await pollCheckins({ now: clock });
    expect(seen?.toISOString()).toBe("2026-05-30T14:00:00.000Z");
  });

  test("insere todos os rows novos; metadata parseado", async () => {
    stubFetch([
      {
        id: 10,
        client_id: 100,
        event_type: "appointment_confirmed",
        occurred_at: new Date("2026-05-31T13:30:00Z"),
        metadata: '{"service":"cut"}',
      },
      {
        id: 11,
        client_id: 100,
        event_type: "appointment_confirmed",
        occurred_at: new Date("2026-05-31T13:45:00Z"),
        metadata: null,
      },
    ]);
    const r = await pollCheckins({ now: clock });
    expect(r.fetched).toBe(2);
    expect(r.new_).toBe(2);
    const c = await erpRepo.findCheckinByErpId("10");
    expect(c?.event_type).toBe("appointment_confirmed");
    expect(c?.metadata).toEqual({ service: "cut" });
  });

  test("re-poll dos mesmos rows: dedup por erp_id → new_=0 (idempotência sem cursor)", async () => {
    stubFetch([
      {
        id: 10,
        client_id: 100,
        event_type: "x",
        occurred_at: new Date("2026-05-31T13:30:00Z"),
        metadata: null,
      },
    ]);
    await pollCheckins({ now: clock });
    const r = await pollCheckins({ now: clock });
    expect(r.fetched).toBe(1);
    expect(r.new_).toBe(0);
  });

  test("metadata malformado vira {} sem crashar", async () => {
    stubFetch([
      {
        id: 50,
        client_id: 1,
        event_type: "x",
        occurred_at: new Date("2026-05-31T13:30:00Z"),
        metadata: "not-json{",
      },
    ]);
    const r = await pollCheckins({ now: clock });
    expect(r.new_).toBe(1);
    expect((await erpRepo.findCheckinByErpId("50"))?.metadata).toEqual({});
  });

  test("row com client_id null é pulado (defensivo) e não derruba o batch", async () => {
    stubFetch([
      {
        id: 60,
        client_id: null,
        event_type: "x",
        occurred_at: new Date("2026-05-31T13:30:00Z"),
        metadata: null,
      },
      {
        id: 61,
        client_id: 5,
        event_type: "x",
        occurred_at: new Date("2026-05-31T13:31:00Z"),
        metadata: null,
      },
    ]);
    const r = await pollCheckins({ now: clock });
    expect(r.fetched).toBe(2);
    expect(r.new_).toBe(1); // só o 61 entra
    expect(await erpRepo.findCheckinByErpId("60")).toBeNull();
    expect(await erpRepo.findCheckinByErpId("61")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/edge && bun test tests/integration/erp-sync/checkins.test.ts`
Expected: FAIL — `pollCheckins` ainda tem assinatura antiga (sem `{now}`) / `_resetCursor`
removido referenciado em outros lugares. (Erros de compilação esperados antes da Task 4 Step 3.)

- [ ] **Step 3: Rewrite `checkins.ts`**

Substituir TODO `packages/edge/src/erp-sync/checkins.ts` por:

```ts
import { getEnv } from "../config/env.js";
import { logger } from "../obs/logger.js";
import type { NewErpCheckin } from "../persistence/schema/erp-cache.js";
import { erpRepo } from "../persistence/repositories/index.js";
import { fetchErpCheckinsSince } from "./queries.js";

/** Início da janela deslizante: now − lookbackHours. Pura (Onda 9-C). */
export function computeSince(now: Date, lookbackHours: number): Date {
  return new Date(now.getTime() - lookbackHours * 3_600_000);
}

export interface PollCheckinsOptions {
  /** Clock injetável (testes). Default: () => new Date(). */
  now?: () => Date;
}

/**
 * Onda 9-C — janela deslizante (substitui o cursor monotônico).
 *
 * `agendas.data` (horário do slot, usado como occurred_at) NÃO é monotônico com o
 * instante em que `checkin` vira 1 (atrasados dão check-in p/ slot passado;
 * adiantados, p/ slot futuro). Um cursor high-water-mark perderia esses
 * permanentemente. Em vez disso, cada poll re-escaneia `data >= now − LOOKBACK`
 * e deduplica por `erp_id` (insert batch ON CONFLICT DO NOTHING). Restart-safe
 * por construção; forward-only (só olha ~1 dia pra trás).
 *
 * Dedup é a fonte de verdade da idempotência — sem estado in-memory entre polls.
 */
export async function pollCheckins(
  opts: PollCheckinsOptions = {},
): Promise<{ fetched: number; new_: number }> {
  const env = getEnv();
  const now = (opts.now ?? (() => new Date()))();
  const since = computeSince(now, env.ERP_CHECKINS_LOOKBACK_HOURS);

  const rows = await fetchErpCheckinsSince(since);

  const toInsert: NewErpCheckin[] = [];
  let skippedNullClient = 0;
  for (const row of rows) {
    // Defensivo: erp_client_id é NOT NULL no cache; um row sem cliente derrubaria
    // o INSERT batch inteiro (atômico). A query já filtra `cliente IS NOT NULL`,
    // mas guardamos aqui também. (checkin=1 sempre tem cliente em operação normal.)
    if (row.client_id === null || row.client_id === undefined) {
      skippedNullClient += 1;
      continue;
    }
    toInsert.push({
      erp_id: String(row.id),
      erp_client_id: String(row.client_id),
      event_type: row.event_type,
      occurred_at: new Date(row.occurred_at),
      metadata: row.metadata ? safeJsonParse(row.metadata) : {},
    });
  }

  let new_ = 0;
  try {
    new_ = await erpRepo.insertCheckinsIgnore(toInsert);
  } catch (err) {
    // Batch é atômico — se 1 row viola constraint, nada entra nesta rodada.
    // Próximo poll re-escaneia a mesma janela e re-tenta (sem perda permanente).
    logger.warn(
      { err, fetched: rows.length, to_insert: toInsert.length },
      "checkins insert batch failed — próxima rodada re-tenta (janela ainda cobre)",
    );
    return { fetched: rows.length, new_: 0 };
  }

  if (skippedNullClient > 0) {
    logger.warn(
      { skipped_null_client: skippedNullClient, fetched: rows.length },
      "checkins poll: rows sem cliente puladas",
    );
  }
  logger.info(
    { fetched: rows.length, new_, since: since.toISOString() },
    "checkins poll complete",
  );
  return { fetched: rows.length, new_ };
}

function safeJsonParse(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
```

Notas:
- Removidos `cursor`, `getInitialCursor`, `_resetCursor`, e o import de `sql`/`getDb`/
  `erpCheckins`/`ERP_CHECKINS_INITIAL_LOOKBACK_HOURS` que não são mais usados.
- `ERP_CHECKINS_INITIAL_LOOKBACK_HOURS` continua no env.ts (não remover — pode estar em
  uso por outro código ou docs; YAGNI sobre removê-lo agora). Verifique com grep no Step 5.

- [ ] **Step 4: Run the rewritten integration test**

Run: `cd packages/edge && bun test tests/integration/erp-sync/checkins.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Verify no dangling references to removed exports**

Run: `cd packages/edge && grep -rn "_resetCursor\|getInitialCursor\|ERP_CHECKINS_INITIAL_LOOKBACK_HOURS" src tests`
Expected: nenhuma referência a `_resetCursor`/`getInitialCursor`. Se `ERP_CHECKINS_INITIAL_LOOKBACK_HOURS`
só aparecer na definição do env, deixá-lo (inerte, não quebra). Se aparecer noutro lugar, avaliar.

- [ ] **Step 6: Typecheck + full edge test suite**

Run: `cd packages/edge && bun run typecheck && bun test`
Expected: typecheck limpo; suíte verde (atenção a testes que importavam `_resetCursor`).

- [ ] **Step 7: Commit**

```bash
git add packages/edge/src/erp-sync/checkins.ts packages/edge/tests/integration/erp-sync/checkins.test.ts
git commit -m "feat(edge): Onda 9-C — pollCheckins janela deslizante (remove cursor monotônico quebrado)"
```

---

### Task 5: Deploy — query do ERP no `edge.env` + verificação

Mudança de **configuração de produção** (não vai no repo). A query atual cursoriza em
`data_alteracao` (NULL nas 3,9M linhas). Trocar por `data`.

**Files:** `/etc/vipcam/edge.env` na VPS (NÃO versionado).

- [ ] **Step 1: Deploy do código**

Na VPS (root): `cd /opt/vipcamv2 && sudo ./scripts/deploy.sh` (faz `git reset --hard
origin/onda-9c-checkin-ingestion` — garantir que a branch foi pushed/mergeada conforme o
fluxo de finishing-a-development-branch).

- [ ] **Step 2: Atualizar `ERP_QUERY_CHECKINS_SINCE` no `/etc/vipcam/edge.env`**

Substituir a linha `ERP_QUERY_CHECKINS_SINCE=...` por (em UMA linha, entre aspas):

```
ERP_QUERY_CHECKINS_SINCE="SELECT id, cliente AS client_id, CASE WHEN checkin=1 AND checkout=1 THEN 'service_completed' WHEN checkin=1 THEN 'appointment_confirmed' ELSE 'scheduled' END AS event_type, data AS occurred_at, JSON_OBJECT('agenda_id', id, 'data_agendada', data, 'origem', origem, 'observacao', observacao) AS metadata FROM agendas WHERE checkin = 1 AND cliente IS NOT NULL AND data >= ? ORDER BY data"
```

(Mudanças vs atual: `data_alteracao`→`data` em SELECT/WHERE/ORDER BY; `+cliente IS NOT NULL`.)

- [ ] **Step 3: Restart e verificação**

```bash
systemctl restart vipcam-edge.service
journalctl -u vipcam-edge --since "2 min ago" | grep "checkins poll complete" | tail -5
```
Expected: `fetched > 0` e `new_ > 0` na primeira rodada (backfill ~24h); rodadas seguintes
`new_` cai (dedup).

- [ ] **Step 4: Verificar no Postgres (DB_URL via edge.env)**

```bash
DB_URL="$(sudo grep -E '^DATABASE_URL=' /etc/vipcam/edge.env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
psql "$DB_URL" -c "SELECT count(*), max(occurred_at) FROM erp_checkins;"
psql "$DB_URL" -c "SELECT erp_id, occurred_at, event_type FROM erp_checkins ORDER BY occurred_at DESC LIMIT 3;"
```
Expected: count crescente; `occurred_at` em UTC **correto** (slot BRT + 3h — ex: slot 20:30
BRT → `23:30Z`). Se vier 3h adiantado, o `timezone` do pool não pegou — investigar Task 1.

- [ ] **Step 5: Verificar match-temporal fluindo (após alguns minutos)**

```bash
psql "$DB_URL" -c "SELECT decision, count(*) FROM match_attempts GROUP BY decision;"
```
Expected: aparecerem `auto_matched` e/ou `ambiguous`. O tab `/matches` deve popular
conforme tráfego real (refetch a cada 30s).

---

## Notas de execução

- **Sem mudança no scheduler** (`erp-sync/scheduler.ts`): ele chama `await pollCheckins()`
  (sem args) → usa o clock default. Confirmar que continua compilando após a nova
  assinatura `pollCheckins(opts = {})`.
- **`MATCH_WINDOW_SECONDS` inalterado** (±5min, decisão do brainstorming).
- **Ordem de merge:** a branch precisa estar em `origin` antes do `deploy.sh` (ele faz
  `git reset --hard origin/<branch>`). Usar finishing-a-development-branch.
- **Rollback:** o `deploy.sh` tem auto-rollback por health-check; a query no `edge.env` é
  reversível manualmente (voltar pra `data_alteracao` — mas isso re-quebra a ingestão).
```
