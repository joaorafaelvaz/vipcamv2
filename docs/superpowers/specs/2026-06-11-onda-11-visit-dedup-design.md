# Onda 11 — Dedup de visitas por gap de 12h (forward-only)

> **Status:** design aprovado (brainstorming 2026-06-11). Próximo: writing-plans.

**Goal:** `persons.total_visits` passa a contar **visitas distintas** — um novo
avistamento só incrementa se o gap desde `last_seen_at` for **> VISIT_GAP_HOURS**
(default 12, configurável). Hoje incrementa a CADA detecção `matched_strict`
(mesma pessoa 5× numa hora = +5), e a inflação só piora com o reid relaxado
(0.50, Onda 9-D) e a identificação manual de funcionários (Onda 10).

## 1. Decisões (brainstorming)

- **Gap:** 12h (usuário mencionou 14h numa conversa anterior; 12h é a palavra
  mais recente). Env `VISIT_GAP_HOURS` — ajustável sem rebuild.
- **Forward-only:** contadores existentes (inflados) NÃO são recalculados.
  Backfill por histórico de detecções foi oferecido e recusado.
- **Fora do escopo (deliberado):** métricas do dashboard (usam *sessions* —
  outra definição de visita); rollup do `mergeInto` (continua somando — N
  fragmentos merged somam N; limitação conhecida, decresce conforme o dedup
  atua na origem); criação de pessoa segue `total_visits=1` (primeira visita).

## 2. Mutation sites de `total_visits` (mapeados)

| Local | Hoje | Depois |
|---|---|---|
| `ingest/pipeline.ts:127` (matched_strict) | `incrementVisitCount` +1/detecção | `recordSighting` gap-aware |
| `reid-match-attempts.repo.ts:110` (resolução manual borderline) | idem | idem |
| `personsRepo.mergeInto` | soma contadores | inalterado |
| criação (schema default) | `total_visits=1` | inalterado |

## 3. Design

### 3.1 Env
`VISIT_GAP_HOURS: z.coerce.number().int().positive().default(12)` em
`packages/edge/src/config/env.ts`.

### 3.2 Repo — `incrementVisitCount` → `recordSighting(id, detectedAt, gapHours)`
UPDATE único e atômico (sem read-modify-write, sem race):

```sql
UPDATE persons SET
  total_visits = total_visits
    + CASE WHEN <detectedAt> - last_seen_at > make_interval(hours => <gapHours>)
           THEN 1 ELSE 0 END,
  last_seen_at = GREATEST(last_seen_at, <detectedAt>),
  updated_at = now()
WHERE id = <id>
```

Propriedades:
- gap ≤ 12h → só atualiza `last_seen_at` (mesma visita continua).
- gap > 12h → +1 visita.
- Evento fora de ordem (`detectedAt < last_seen_at`): CASE dá gap negativo →
  não incrementa; `GREATEST` preserva o `last_seen_at` mais recente.

Rename (`recordSighting`) deixa a semântica honesta nos call sites — ambos
precisam ser tocados de qualquer jeito (passar `env.VISIT_GAP_HOURS`).

### 3.3 Call sites
- `pipeline.ts` matched_strict: `personsRepo.recordSighting(personId, detectedAt, env.VISIT_GAP_HOURS)`.
- `reid-match-attempts.repo.ts` resolve "matched_to_candidate" sem merge: idem
  (gap vem de `getEnv()` no próprio repo ou parâmetro — decidir no plano
  mantendo o pattern do arquivo).

## 4. Testes

- **Integração (Postgres)** `persons-record-sighting.test.ts`:
  gap > 12h → +1 e last_seen atualizado; gap < 12h → contador inalterado e
  last_seen atualizado; out-of-order → contador inalterado e last_seen
  preservado; gapHours custom (ex.: 1h) respeitado.
- **Unit:** `VISIT_GAP_HOURS` default 12 + override.
- Call sites cobertos por typecheck + suíte existente.

## 5. Deploy

Sem migration, sem env obrigatório (default 12). `deploy.sh` normal.
Verificação: pessoa re-detectada em sequência não ganha visitas novas
(logs/DB); `total_visits` só cresce entre dias.
