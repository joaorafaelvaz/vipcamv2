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

Fonte: tabelas `sessions`, `detections`, `persons`, `erp_clients` (já existentes).

- **Funcionário** = `persons.person_type = 'employee'`. Sessões ligadas a um person funcionário (via `detections.person_id → persons`) são **excluídas** de todas as métricas.
- **Sessão anônima** = nenhuma detection da sessão tem `person_id` (não casada). **Incluída** em fluxo/pico/sentimento.
- **Cliente identificado** = `persons.person_type = 'client'` (casado via ERP).
- **Fluxo de visitas:** nº de sessões/dia no período, exceto funcionários. Tendência = regressão linear simples sobre os pontos diários (função pura testável).
- **Horários de pico:** contagem de sessões por (dia-da-semana, hora-do-dia) de `sessions.started_at`, exceto funcionários.
- **Recorrência (só clientes identificados):** no período,
  - **novo** = `persons.first_seen_at >= início_janela`
  - **recorrente** = `persons.first_seen_at < início_janela` E tem ≥1 sessão na janela
  - resposta inclui `identified_visits` e `total_visits` (todas as visitas não-funcionário) p/ o label honesto. `identified_visits = 0` → UI mostra "Sem clientes identificados no período" (não donut vazio).
- **Sentimento:** distribuição de `detections.dominant_emotion` no período (exceto funcionários); `null` → bucket explícito `"n/d"`. Tendência opcional v1.1 (não bloqueia).
- **Timezone:** agregação por dia/hora usa o TZ configurado da app (mesma convenção de `occurred_at`/`detected_at`). O spec do plano deve registrar a const/env de TZ usada e os testes fixam um TZ determinístico.

---

## 4. Arquitetura técnica

Segue os padrões do codebase (`dashboard.queries.ts` + `createDashboardRoutes` + rotas `force-dynamic`).

### Edge (Bun+Hono+Drizzle)

- **`packages/edge/src/api/metrics.queries.ts`** — uma função pura por métrica: `visitsFlow(db, days)`, `peakHours(db, days)`, `recurrence(db, days)`, `sentiment(db, days)`. Cada uma roda GROUP BY com `WHERE` de range + exclusão de funcionário. Espelha `dashboard.queries.ts`.
- **`packages/edge/src/api/routes/metrics.ts`** — `createMetricsRoutes(deps)` exportando `GET /overview`. Valida `days` como enum `{7,30}` (default 7); inválido → `400` tipado (mesmo padrão dos outros routes).
- **`server.ts`** — montar `app.route("/api/metrics", createMetricsRoutes({...}))` + `app.use("/api/metrics/*", requireKey)` (igual aos demais prefixos `/api/`).
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

- **Edge integration (Postgres `vipcam_test`):** seed cobrindo — dia com mix anônimo+identificado; funcionário (deve sumir de todas as métricas); cliente novo vs recorrente (`first_seen_at` dentro/fora da janela); detection com `dominant_emotion` null; período totalmente vazio. Assertar os 4 blocos do `overview` + TZ determinístico. Mesma estrutura dos testes `match-pending`/repos.
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
