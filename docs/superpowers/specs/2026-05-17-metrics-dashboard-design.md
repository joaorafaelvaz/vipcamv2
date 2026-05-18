# Design: Onda 5 — Dashboard de Métricas de Negócio

**Data:** 2026-05-17
**Status:** Aprovado (saiu de brainstorming, pendente plano de implementação)
**Autor(es):** Rafael Vaz + Claude
**Contexto:** Onda 3 entregou visibilidade operacional (pessoas, matches, live). Onda 4 pagou débitos. O dono da barbearia ainda não tem leitura **analítica/agregada** do que a câmera+ERP produzem — só listas e o feed ao vivo. Esta onda entrega um dashboard de métricas de negócio. Não-gated: implementável 100% offline (sem câmera/VPS); validação de integração precisa do Postgres `vipcam_test`.

---

## 1. Objetivo

Dar ao **dono da barbearia** uma tela única que responda 4 perguntas de negócio:

1. O movimento está crescendo? (**fluxo de visitas + tendência**)
2. Quando escalar/alocar equipe? (**horários de pico**)
3. A fidelização funciona? (**recorrência: novos vs recorrentes**)
4. Os clientes saem satisfeitos? (**sentimento dos clientes**)

Sem mudança de comportamento de produto existente. Adiciona uma rota read-only.

---

## 2. Decisões consolidadas (brainstorming 2026-05-17)

| Dimensão | Decisão |
|---|---|
| Público | Dono da barbearia (decisão de negócio; não-técnico) |
| Métricas v1 | Fluxo+tendência, horários de pico, recorrência, sentimento (as 4) |
| Escopo de anônimos | Fluxo/pico/sentimento contam **todas as sessões exceto funcionários** (anônimos incluídos). Recorrência **só clientes identificados via ERP** + label honesto de base |
| Período | Presets fixos **7d / 30d**. Sem date-range custom (era "depois" na Onda 3 §11; YAGNI) |
| Cômputo dos agregados | **SQL on-demand** (GROUP BY no request, range limitado). Sem rollup table. Espelha `dashboard.queries.ts`. Rollup vira futuro p/ multi-unidade |
| API | **1 endpoint combinado** `GET /api/metrics/overview?days=7\|30` (1 page-load = 1 request; espelha `/api/dashboard/summary`) |
| Gráficos | Recharts (de-facto com shadcn/ui; única dep nova) |
| Layout | **B — hero + 3 secundários** (Fluxo em destaque largura total; pico/recorrência/sentimento numa linha abaixo) |
| Refresh | React Query, `staleTime` ~5min + refetch on focus + toggle 7d/30d via state local (sem URL param) |

### Tipos de gráfico

| Métrica | Gráfico |
|---|---|
| Fluxo de visitas | Área/linha por dia + linha de tendência (HERO, largura total) |
| Horários de pico | Heatmap dia-da-semana × hora-do-dia |
| Recorrência | Donut novos×recorrentes + label "base: N de M visitas identificadas (X%)" |
| Sentimento | Barras horizontais por emoção (bucket explícito "n/d" p/ null) |

---

## 3. Escopo de dados (definições precisas)

Fonte: tabelas `sessions`, `persons`, `erp_clients` (já existentes). **A unidade de "visita" é a `session`**, e o vínculo autoritativo sessão→pessoa é a coluna **`sessions.person_id`** (setada no match por `sessionsRepo` — `sessions.repo.ts:111` faz `.set({ person_id, linked_erp_checkin_id })`; há índice `sessions_person_idx`). **Não** usar `detections.person_id` para classificar sessões (seria ambíguo p/ sessões com detections mistas e não-autoritativo).

- **Sessão anônima** = `sessions.person_id IS NULL`. **Incluída** em fluxo/pico/sentimento.
- **Sessão de funcionário** = `sessions.person_id` aponta p/ um person com `persons.person_type = 'employee'`. **Excluída de todas as métricas.**
- **Sessão não-funcionário** (base de fluxo/pico/sentimento) = `LEFT JOIN persons ON persons.id = sessions.person_id WHERE persons.person_type IS NULL OR persons.person_type <> 'employee'` (null = anônima, entra; client/anonymous entram; só employee sai). Obs: o enum `persons.person_type` tem 3 valores (`client|employee|anonymous`) — por isso o filtro é `<> 'employee'`, **não** `= 'client'`.
- **Cliente identificado** = sessão cujo person tem `persons.person_type = 'client'`.
- **Fluxo de visitas:** nº de sessões não-funcionário por dia (bucket de `sessions.started_at`, ver Timezone) no período. Tendência = regressão linear simples (mínimos quadrados) sobre os pontos diários — função pura testável.
- **Horários de pico:** contagem de sessões não-funcionário por (dia-da-semana, hora-do-dia) de `sessions.started_at` (ver Timezone).
- **Recorrência (só clientes identificados):** "primeira visita" de um cliente = **`MIN(sessions.started_at)` daquele `person_id`** (derivado de sessões — mesma convenção já usada em `persons.repo.ts:145`; **não** usar a coluna `persons.first_seen_at`, que é `defaultNow()` na criação da row e não reflete a 1ª visita real). No período `[janelaInício, agora]`, para cada cliente com ≥1 sessão na janela:
  - **novo** = `MIN(sessions.started_at do cliente) >= janelaInício` (1ª visita de todas caiu na janela)
  - **recorrente** = `MIN(sessions.started_at do cliente) < janelaInício` (já tinha visita antes da janela)
  - resposta inclui `identified_visits` (sessões de clientes na janela) e `total_visits` (todas as sessões não-funcionário na janela) p/ o label honesto. `identified_visits = 0` → UI mostra "Sem clientes identificados no período" (não donut vazio).
- **Sentimento:** distribuição de `sessions.dominant_emotion` (já é o rollup por sessão via `mode()` — consistente com a unidade "visita"; **não** reagregar `detections`) das sessões não-funcionário no período; `null` → bucket explícito `"n/d"`. Tendência ao longo do tempo é v1.1 opcional (não bloqueia).
- **Timezone (decisão definida aqui — não há convenção pré-existente):** todos os timestamps são `timestamptz` (UTC) e o codebase **não tem** tratamento de TZ. Como a barbearia é local (Brasil), buckets de dia/hora em UTC ficariam deslocados ~3h e distorceriam pico/fluxo. Decisão: **nova env `METRICS_TZ` (default `America/Sao_Paulo`)** validada no schema de env (Zod, junto das demais). Buckets calculados em SQL via `(${sessions.started_at} AT TIME ZONE 'UTC' AT TIME ZONE :METRICS_TZ)::date` / `EXTRACT(...)`. Os testes de integração fixam `METRICS_TZ` explícito e asseguram que uma sessão perto da meia-noite cai no dia local correto.

---

## 4. Arquitetura técnica

Segue os padrões do codebase (`dashboard.queries.ts` + `createDashboardRoutes` + rotas `force-dynamic`).

### Edge (Bun+Hono+Drizzle)

- **`packages/edge/src/api/metrics.queries.ts`** — uma função pura por métrica: `visitsFlow(db, days, tz)`, `peakHours(db, days, tz)`, `recurrence(db, days)`, `sentiment(db, days)`. Cada uma roda GROUP BY sobre `sessions` (LEFT JOIN `persons` p/ excluir funcionário, ver §3) com `WHERE` de range. Espelha `dashboard.queries.ts`. `tz` = `env.METRICS_TZ`.
- **Env:** adicionar `METRICS_TZ` (string, default `America/Sao_Paulo`) ao schema Zod de env do edge (`config/env.ts`) + ao `edge.env.example`.
- **`packages/edge/src/api/routes/metrics.ts`** — `createMetricsRoutes(deps)` exportando `GET /overview`. Valida `days` como enum `{7,30}` (default 7); inválido → `400` tipado (mesmo padrão dos outros routes).
- **`server.ts`** — montar `app.route("/api/metrics", createMetricsRoutes({...}))` + proteger o prefixo com o mesmo middleware dos demais `/api/*` (a const local `requireKey`, produzida por `apiKeyMiddleware(env.API_KEY, …)` em `server.ts`; confirmar o símbolo real ao implementar — é o mesmo usado em `/api/persons/*` etc.).
- **`overviewMetrics(db, days)`** — orquestra as 4 funções e devolve `MetricsOverview`. Em caso de período vazio, retorna estrutura vazia tipada (arrays `[]`, contadores `0`) — nunca `NaN`/throw.

### Shared

`packages/shared/src/types` — novos tipos:

```ts
export interface VisitsFlow {
  points: { date: string; count: number }[];        // ISO date (dia)
  trend: { slope: number; direction: 'up'|'down'|'flat' };
}
export interface PeakHours {
  cells: { weekday: number; hour: number; count: number }[]; // weekday 0-6, hour 0-23
}
export interface RecurrenceBreakdown {
  new_count: number;
  returning_count: number;
  identified_visits: number;
  total_visits: number;
}
export interface SentimentBreakdown {
  buckets: { emotion: string; count: number }[];     // inclui "n/d"
}
export interface MetricsOverview {
  days: 7 | 30;
  visits: VisitsFlow;
  peak: PeakHours;
  recurrence: RecurrenceBreakdown;
  sentiment: SentimentBreakdown;
}
```

### Web (Next 14 + shadcn/ui + Recharts)

- **`packages/web/src/app/metrics/page.tsx`** — `export const dynamic = "force-dynamic"` (igual /people, /live). Layout **B**: faixa de KPIs no topo (visitas totais, média/dia, % recorrentes, emoção predominante) → "Fluxo" hero largura total → linha com pico/recorrência/sentimento.
- **`packages/web/src/lib/queries/metrics.ts`** — `useMetricsOverview(days: 7|30)`, `staleTime` ~5min, refetch on focus.
- **Componentes de gráfico** (`packages/web/src/components/metrics/`): `visits-flow-chart.tsx`, `peak-hours-heatmap.tsx`, `recurrence-donut.tsx`, `sentiment-bars.tsx`, `metric-kpis.tsx`. Cada um: dados → render; estado vazio explícito.
- **Topbar** — adicionar link "Métricas".
- **Dep nova:** `recharts` em `packages/web/package.json`.

---

## 5. Edge cases & erros

- **Período sem dados:** estrutura vazia tipada → UI mostra "Sem dados nos últimos Nd" por bloco; nunca quebra/`NaN`.
- **Recorrência base pequena:** label honesto sempre visível; `identified_visits=0` → mensagem dedicada.
- **Sentimento null:** bucket `"n/d"` explícito.
- **`days` inválido:** `400` tipado.
- **Falha de DB:** handler propaga; React Query mostra erro + "tentar de novo" (padrão Onda 3).
- **Auth:** `requireKey` como os demais `/api/*`.

---

## 6. Estratégia de testes

- **Edge integration (Postgres `vipcam_test`):** seed via `sessionsRepo` cobrindo — sessão anônima (`person_id NULL`) + sessão de cliente identificado + sessão de funcionário (`person_id` → person `employee`, deve sumir de TODAS as métricas); cliente **novo** (`MIN(sessions.started_at)` dentro da janela) vs **recorrente** (1ª sessão antes da janela + sessão na janela); sessão com `dominant_emotion` NULL (→ bucket `"n/d"`); período totalmente vazio (estrutura vazia tipada). **TZ:** com `METRICS_TZ` fixo, uma sessão `started_at` perto da meia-noite UTC deve cair no dia/hora **local** correto. Assertar os 4 blocos do `overview`. Mesma estrutura dos testes `match-pending`/repos.
- **Edge unit:** validação do enum `days`; função pura de tendência (slope/direction).
- **Web:** render de cada componente de gráfico com mock + estado vazio (rodar de `packages/web`).
- **Sem E2E** (continua fora de escopo — Onda 3 §11).

---

## 7. Out of scope (YAGNI)

- Demografia idade/gênero, duração média de visita, NPS.
- Métricas de funcionário (presença/horas).
- Date-range custom, comparação período-vs-período, export CSV.
- Rollup table / job de agregação — documentado como evolução futura quando multi-unidade exigir.
- Tendência de sentimento ao longo do tempo (v1 só distribuição; trend é v1.1 opcional, não bloqueia).
- E2E (Playwright).
- Edição/gestão de Person, Failover B (onda futura gated), retention/LGPD (onda própria).

---

## 8. Próximos passos

1. Spec aprovado (este doc) → spec-document-reviewer valida.
2. `superpowers:writing-plans` gera plano detalhado por chunk (TDD onde aplicável).
3. Execução por `superpowers:subagent-driven-development`.
4. Validação de integração quando houver Postgres `vipcam_test`; deploy/operacional quando houver VPS.
