# Onda 9-C — Reanimar a ingestão de checkins (ERP → match-temporal)

> **Status:** design aprovado (brainstorming 2026-05-31). Próximo passo: writing-plans.

**Goal:** Fazer `pollCheckins` voltar a ingerir checkins do ERP, desbloqueando todo o
match-temporal e o tab `/matches` (vazios há 19 dias em produção).

## 1. Problema

O tab `/matches` (Temporal) está vazio em produção. Investigação sistemática
(systematic-debugging) provou que **não é** o gating do tab nem o seeding de
funcionários: é que a **ingestão de checkins está morta**.

Evidência coletada na VPS (2026-05-31):

| Sinal | Valor | Leitura |
|---|---|---|
| `erp_checkins` total / processed | 1 / 1 | só 1 checkin, de **12/mai** (19 dias atrás) |
| `match_attempts` por decisão | só `rejected: 3` | nenhum `ambiguous`/`auto_matched` |
| `detections` total / última | 17.158 / **30/mai 18:39** | câmera + reid gravando OK |
| detections em ±300s de algum checkin | **0** | o único checkin não casa com nada |
| logs `checkins poll complete` | `fetched:0` a cada 30s | poll roda, mas a fonte devolve 0 |

## 2. Causa-raiz

A query configurada em `ERP_QUERY_CHECKINS_SINCE` (no `/etc/vipcam/edge.env`) é:

```sql
SELECT id, cliente AS client_id,
       CASE WHEN checkin=1 AND checkout=1 THEN 'service_completed'
            WHEN checkin=1 THEN 'appointment_confirmed' ELSE 'scheduled' END AS event_type,
       data_alteracao AS occurred_at,
       JSON_OBJECT(...) AS metadata
FROM agendas
WHERE checkin = 1 AND data_alteracao >= ?
ORDER BY data_alteracao
```

A coluna-cursor `agendas.data_alteracao` é **NULL nas 3,9 milhões de linhas** (o ERP
nunca a popula — confirmado: até rows criadas hoje têm `data_alteracao=NULL`). Como
`NULL >= '...'` nunca é verdadeiro, a query devolve **0 linhas, sempre**. Há
**1.326.346** agendas com `checkin=1` na fonte; nenhuma chega ao Postgres.

O "1 checkin de 12/mai" foi ingerido quando a query/env estava diferente; depois mudou
para `data_alteracao` e secou.

### 2.1 Bug latente de timezone (mascarado pela ingestão zerada)

`detected_at` vem do `RealUTC` da câmera (epoch Unix → `new Date(realUtc*1000)`):
**instante UTC verdadeiro**. Já `agendas.data` é wall-clock **BRT** (ex:
`'2026-05-30 20:30:00'` = 20:30 BRT). O serviço edge roda em **UTC** (systemd; vide
comentário em `deploy.sh`). Com o mysql2 no default `timezone:'local'=UTC`, ele leria
`'20:30:00'` como `20:30Z` — **3h errado**. A janela ±5min nunca casaria com as
detecções, mesmo com a ingestão consertada. Precisa ser corrigido junto.

## 3. Schema relevante (`agendas`)

| coluna | tipo | nota |
|---|---|---|
| `id` | int PK auto_increment | vira `erp_id` (text) no cache |
| `cliente` | int NULL | → `client_id` |
| `data` | datetime NOT NULL | **horário do slot** (wall-clock BRT) — único proxy de chegada |
| `data_criacao` | datetime NOT NULL | quando a agenda foi criada (longe da chegada se pré-agendada) |
| `data_alteracao` | datetime **NULL sempre** | inútil como cursor |
| `checkin` | tinyint(1) default 0 | flag; **sem timestamp** de quando virou 1 |
| `checkout` | tinyint(1) | usado no `event_type` |
| `origem`, `observacao` | varchar | vão pro metadata |

Não existe coluna com o timestamp do check-in. `data` (slot) é o melhor proxy
disponível para "quando a pessoa está fisicamente no salão".

## 4. Decisões (brainstorming)

- **`occurred_at` = `data`** (horário do slot). Único proxy de chegada.
- **Janela ±5min** (mantém `MATCH_WINDOW_SECONDS=300`). Recall baixo aceito em troca de
  precisão; é env-ajustável depois.
- **Forward-only.** Sem replay retroativo; a janela deslizante de ~24h cobre "hoje pra
  frente" naturalmente.

## 5. Abordagem (3 peças)

### 5.1 Query corrigida (config — `/etc/vipcam/edge.env`, fora do repo)

```sql
SELECT id, cliente AS client_id,
       CASE WHEN checkin=1 AND checkout=1 THEN 'service_completed'
            WHEN checkin=1 THEN 'appointment_confirmed' ELSE 'scheduled' END AS event_type,
       data AS occurred_at,
       JSON_OBJECT('agenda_id', id, 'data_agendada', data, 'origem', origem, 'observacao', observacao) AS metadata
FROM agendas
WHERE checkin = 1 AND data >= ?
ORDER BY data
```

Troca `data_alteracao` → `data` no SELECT, no WHERE e no ORDER BY. É uma mudança de
**configuração** (não de código), aplicada no `edge.env` da VPS no deploy.

### 5.2 Polling deslizante (código — `erp-sync/checkins.ts`)

`data` (slot) **não é monotônico** com o instante em que `checkin` vira 1: um cliente
atrasado dá check-in para um slot já passado; um adiantado, para um slot futuro. O
cursor high-water-mark atual (`occurred_at > cursor`) **perderia esses
permanentemente** (caem abaixo do cursor).

Troca por **janela deslizante**: cada poll busca `data >= now − ERP_CHECKINS_LOOKBACK_HOURS`
(default 24h), re-escaneando a janela inteira e deduplicando por `erp_id`. Propriedades:

- Restart-safe por construção (sem estado de cursor a reconciliar).
- Captura check-ins fora de ordem (o flag virou 1 a qualquer momento; basta o slot estar
  dentro da janela).
- Forward-only de graça (só olha ~1 dia pra trás).

Remove `cursor`, `getInitialCursor`, `_resetCursor`. Função vira essencialmente:
`since = now − lookback` → fetch → dedup → insert novos → log `fetched`/`new_`.

`now()` deve ser injetável (param/clock) para testabilidade determinística.

### 5.3 Timezone (código — `erp-sync/mysql-client.ts` + `config/env.ts`)

Fixar `timezone: env.ERP_TZ_OFFSET` (default `-03:00`) no pool mysql2. Assim `data`
vira o instante UTC correto **independente** do TZ do processo, e o `?` (since, um `Date`
UTC) serializa de volta para `-03:00` simetricamente. Brasil sem DST desde 2019 → offset
fixo é seguro.

Teste-âncora: `'2026-05-30 20:30:00'` (BRT) → `2026-05-30T23:30:00.000Z`.

### 5.4 Dedup em batch (código — `persistence/repositories/erp.repo.ts`)

Hoje: `findCheckinByErpId` por linha. Com re-scan de ~1 dia a cada 30s isso seriam N
selects/poll. Troca por **insert em batch `ON CONFLICT (erp_id) DO NOTHING`**:

- 1 round-trip;
- não faz UPDATE à toa em rows já cacheadas (evita o clobber de `metadata` notado no M3
  de `upsertCheckin`);
- preserva `processed_at` das já processadas.

Novo método `erpRepo.insertCheckinsIgnore(rows)`. O `upsertCheckin` existente permanece
(usado pelo endpoint manual `/api/erp/sync/checkins`).

## 6. Arquivos

| Arquivo | Mudança |
|---|---|
| `packages/edge/src/erp-sync/mysql-client.ts` | pool com `timezone: env.ERP_TZ_OFFSET` |
| `packages/edge/src/config/env.ts` | `+ERP_TZ_OFFSET` (default `-03:00`), `+ERP_CHECKINS_LOOKBACK_HOURS` (default 24) |
| `packages/edge/src/erp-sync/checkins.ts` | reescrita: janela deslizante + dedup batch; remove cursor |
| `packages/edge/src/persistence/repositories/erp.repo.ts` | `+insertCheckinsIgnore(rows)` batch |
| `packages/edge/tests/unit/erp-sync/checkins.test.ts` | janela deslizante, dedup, forward-only, clock injetável |
| `packages/edge/tests/unit/erp-sync/mysql-tz.test.ts` | trava conversão BRT→UTC |

**Sem migration** — zero mudança de schema.

## 7. Testes

- **checkins.ts (unit):** com `now` injetado, `since == now − lookback`; rows já em cache
  são puladas (dedup); rows novas inseridas; `fetched`/`new_` corretos; nenhuma
  dependência de estado entre chamadas (idempotência por re-scan).
- **mysql tz (unit):** parse de `'2026-05-30 20:30:00'` sob `timezone:'-03:00'` →
  `…T23:30:00.000Z`. (Se exigir conexão real, isolar a lógica de offset numa função pura
  testável; senão, validar via mysql2 `parseISO` config.)
- **validateErpQueries:** continua exigindo as colunas (`id, client_id, event_type,
  occurred_at`); a nova query as fornece via alias.

## 8. Deploy & verificação

1. Atualizar `ERP_QUERY_CHECKINS_SINCE` no `/etc/vipcam/edge.env` (query §5.1).
2. `git pull` + build + restart via `scripts/deploy.sh`.
3. Verificar:
   - logs `checkins poll complete` com `fetched > 0`, `new_ > 0` na 1ª rodada;
   - `SELECT count(*), max(occurred_at) FROM erp_checkins` crescendo;
   - um checkin com `occurred_at` em UTC correto (slot BRT + 3h);
   - após alguns minutos, `match_attempts` com `auto_matched`/`ambiguous` aparecendo;
   - `/matches` populando conforme tráfego real.

## 9. Riscos & premissas

- **(a)** `data` ≈ chegada dentro de ±5min — decisão do operador; atrasos maiores não
  correlacionam mesmo ingerindo o checkin.
- **(b)** Offset fixo `-03:00` (Brasil sem DST desde 2019). Configurável via `ERP_TZ_OFFSET`.
- **(c)** Re-scan de ~1 dia a cada 30s é barato (algumas centenas de linhas; 1 SELECT
  MySQL + 1 INSERT batch).
- **(d)** A query real vive no `edge.env` de produção; a `default` em `env.ts` permanece
  genérica (schema `checkins`) — não afeta produção, que tem override explícito.
