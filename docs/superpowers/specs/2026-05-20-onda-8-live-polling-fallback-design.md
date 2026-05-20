# Design: Onda 8 — `/live` Resiliente (Polling-Only, Substitui SSE)

**Data:** 2026-05-20
**Status:** Aprovado (saiu de brainstorming, pendente plano de implementação)
**Autor(es):** Rafael Vaz + Claude
**Contexto:** O `/live` SSE entrou em loop de reconexão (`ERR_HTTP2_PROTOCOL_ERROR` no browser; `INTERNAL_ERROR`/`upstream prematurely closed` no nginx). Investigação sistemática (2026-05-19/20) provou que a falha é **independente da versão do nginx** (idêntica em 1.18 e 1.30.1 oficial) — está na interação `Bun/Hono streamSSE × proxy HTTP/2 do nginx`, não no nginx em si. Tentativas de upgrade do nginx (`ppa:ondrej/nginx` irresoluble; `nginx.org` migration causou outage e foi rollback) provaram que C não é viável. F (polling) é o caminho confiável, ours-only, independente de infra. **Onda 7 (Failover B) permanece pausada na Seção 2 até esta entregar.**

---

## 1. Objetivo & escopo

**Objetivo:** restaurar `/live` em produção via polling DB-backed (~3-5 s), removendo a dependência do SSE — empiricamente inconsertável neste setup. Latência ~3-5 s é adequada pra feed ambiente da recepção.

### Em escopo
- **Edge:** novo `GET /api/events/recent?limit=50` (DB-backed); rota `events.ts` reescrita; query module novo `events.queries.ts`.
- **Web:** hook novo `useRecentDetections()` (React Query, `refetchInterval` ~3 s, pausa quando tab oculta); `live-feed.tsx` adaptado (UI idêntica; estado simplificado).
- **Cleanup:** delete rota `streamSSE`, `useSse` hook + seus testes, ajuste do `apiKeyMiddleware` (sem `allowQueryOn` p/ stream).

### Fora de escopo (YAGNI)
- Cursor incremental (`?since=...`) — bandwidth de "últimos 50 a cada 3-5 s" é trivial; adicionar depois se telemetria mostrar necessidade.
- Mudança de UI/UX — cards/contagem/botão Pausar idênticos; só muda o transporte.
- Tocar no `event-bus`/`eventBus.publish()` do ingest (mantém dormente; custo zero; útil pra futuros consumidores).
- **Onda 7 (Failover B)** — permanece pausada até esta entregar.

### Sucesso
- `/live` exibe detecções com lag ≤5 s.
- Logs do nginx **param de acumular** `upstream prematurely closed connection while reading upstream` pro `/api/events/stream`.
- Zero dependência de proxy de stream; deploy 100% pelo `deploy.sh` (zero apt/nginx/infra).
- Estado vazio é o do SSE atual ("Aguardando primeira detecção…") — em horas calmas é OK (a Onda 6 confirmou ~10 detec/hora).

---

## 2. Decisões consolidadas (brainstorming 2026-05-20)

| Dimensão | Decisão |
|---|---|
| Causa-raiz do SSE | Bun/Hono `streamSSE` × proxy HTTP/2 (provado: 1.18 e 1.30.1 falham idêntico) — não é nginx defect |
| Transporte | **Polling-only** (remove EventSource do `/live`) |
| Source | **DB-backed** (`detections` LEFT JOIN `persons`), não ring buffer em memória |
| Shape | Reusa `LiveDetectionEvent[]` existente em `@vipcam/shared` (zero alteração de tipos) |
| Endpoint | `GET /api/events/recent?limit=50` (default 50, cap 200) |
| Ordem | `detected_at DESC, id DESC` (tie-breaker determinístico) |
| Filtro | **Sem filtro** — inclui anônimos e funcionários (paridade com SSE atual; consistente com "está acontecendo agora") |
| Pagination | YAGNI — sempre top-N (limit) |
| Intervalo de polling | ~3 s (cliente); pausa quando tab oculta (Page Visibility via React Query `refetchIntervalInBackground:false`) |
| Cleanup | Remove `/api/events/stream`, `useSse` hook (+ teste); event-bus + publish() do ingest **mantidos** dormentes |
| Onda 7 | Pausada até esta entregar |

---

## 3. Arquitetura & componentes (7 unidades)

### Edge (Bun+Hono)

1. **`packages/edge/src/api/events.queries.ts` (novo)** — `recentDetections(db, limit): Promise<LiveDetectionEvent[]>`. Pura sobre `db`. Espelha o padrão de `dashboard.queries.ts`. Drizzle:
   ```sql
   SELECT detection-fields..., person-fields...
   FROM detections
   LEFT JOIN persons ON persons.id = detections.person_id
   ORDER BY detections.detected_at DESC, detections.id DESC
   LIMIT :limit
   ```
   Mapeia row → `{ type: "detection", detection: DetectionThumbnail, person: PersonSummary | null }`.

2. **`packages/edge/src/api/routes/events.ts` (reescrito)** — `createEventsRoutes(deps)` agora expõe **só** `GET /recent`:
   - Valida `?limit` (number, 1..200, default 50); inválido → 400 `{ error: "limit must be 1..200" }`.
   - Chama `deps.recent(limit)` → retorna `LiveDetectionEvent[]`.
   - Interface: `EventsDeps { recent: (limit: number) => Promise<LiveDetectionEvent[]> }`.
   - **Remove:** `subscribe`/`heartbeatMs` da `EventsDeps`; o handler `r.get("/stream", streamSSE(...))`.

3. **`packages/edge/src/api/server.ts`** — wiring:
   - **Remove** `allowQueryOn: "/api/events/stream"` da config do `apiKeyMiddleware` (sem mais EventSource; GET de polling usa X-API-Key em header via `apiFetch`).
   - `app.route("/api/events", createEventsRoutes({ recent: (limit) => recentDetections(getDb(), limit) }));`.
   - `/api/events/*` segue protegido por `requireKey`.

4. **Event-bus**: **mantém** `packages/edge/src/api/events/event-bus.ts` + `eventBus.publish()` no ingest pipeline. Dormante; custo zero (EventEmitter sem listeners é no-op); preservado pra futuros consumidores.

### Web (Next + React Query)

5. **`packages/web/src/lib/queries/events.ts` (novo)** — `useRecentDetections(opts)`:
   - Assinatura: `{ limit?: number; intervalMs?: number; enabled?: boolean }` (defaults: 50, 3000, true).
   - `useQuery<LiveDetectionEvent[]>` com `queryKey: ["events", "recent", limit]`, `queryFn: ({signal}) => apiFetch<LiveDetectionEvent[]>(\`/api/events/recent?limit=\${limit}\`, {signal})`.
   - `refetchInterval: enabled ? intervalMs : false`.
   - `refetchIntervalInBackground: false` — Page Visibility pausa quando tab oculta.
   - `placeholderData: keepPreviousData` — evita "piscada" entre refetches.

6. **`packages/web/src/components/live-feed.tsx` (refator)**:
   - Substitui `useSse` + `useState<events>` + `onMessage` por `useRecentDetections({ limit:50, intervalMs:3000, enabled:!paused })`.
   - Renderiza `data ?? []` direto (servidor já entrega top-50 DESC; **sem ring buffer client-side**).
   - Badge de estado: `pausado | atualizando | erro | ao vivo` derivado de `query.status` + `isFetching` + `isError`.
   - Botão Pausar/Retomar continua (controla `enabled` da query).
   - Key dos cards: `detection.id` (existing pattern; também serve de dedup natural quando o servidor devolve top-N com possíveis IDs repetidos entre polls).

7. **DELETE:**
   - `packages/web/src/hooks/use-sse.ts`
   - `packages/web/tests/unit/hooks/use-sse.test.ts`

### Tipos compartilhados
`LiveDetectionEvent`, `DetectionThumbnail`, `PersonSummary` em `@vipcam/shared` — **inalterados**. Reuso total.

---

## 4. Shape, query, ordenação

**Resposta** (array de `LiveDetectionEvent`, mesma shape do SSE atual):
```ts
[{
  type: "detection",
  detection: { id, detected_at, snapshot_path, face_attrs, dominant_emotion,
               emotion_confidence, session_id, camera_id },
  person: PersonSummary | null
}, ...]
```

**Query Drizzle:**
- `detections` LEFT JOIN `persons` ON `persons.id = detections.person_id` (maioria das detecções é anônima → person null).
- ORDER BY `detected_at DESC, id DESC` — secondary garante ordem estável entre polls com timestamps iguais.
- LIMIT `:limit` (1..200, default 50).
- Custo trivial: índice em `detections.detected_at` cobre o ordering; LIMIT 50 é ~ms.

**Edge cases:**
- Sem detecções → `[]` (200, não 404).
- Pessoa deletada (schema: `persons` `ON DELETE SET NULL` em `detections.person_id`) → `LEFT JOIN` rende `person: null` naturalmente.
- Tie em `detected_at` → resolvido por `id DESC`; render estável entre polls.

**Sem filtro** — inclui todos (anônimos, funcionários, clientes ERP). Paridade com SSE atual; consistente com semântica "está acontecendo agora".

---

## 5. Erros, edge cases, segurança

- **DB down/erro** → handler propaga; React Query mostra erro + retry (padrão Onda 3 R5).
- **`limit` inválido** → 400 tipado `{ error: "limit must be 1..200" }`.
- **Auth:** `requireKey` (header X-API-Key via `apiFetch`); **sem `allowQueryOn`** (não é mais stream).
- **Paused** (botão UI) → `enabled:false` → para de pollar; retomar → query imediata.
- **Tab oculta** → `refetchIntervalInBackground:false` pausa polling via Page Visibility — economia leve mas correta pro kiosk.
- **Dedup in-flight** → React Query desduplica por `queryKey`; toggles rápidos não disparam queries paralelas.
- **Estado vazio** → UI atual já trata ("Aguardando primeira detecção…").
- **Cut-over:** deletar `/api/events/stream` é breaking pra EventSource subscrito, mas a rota já falhava (`INTERNAL_ERROR` em loop) → corte limpo sem regressão real.

---

## 6. Estratégia de testes

- **Edge unit** (refator `tests/unit/api/routes/events.test.ts`): `GET /recent` — default 50, 1/200 boundaries OK, 0/201/`abc` → 400, `deps.recent` chamado com limit parseado, JSON retornado. Mock `deps.recent`.
- **Edge integration** (novo `tests/integration/api/events-recent.test.ts`, Postgres `vipcam_test`): seed (anônima + cliente ERP + funcionário) via repos, asserta: ordem DESC por `detected_at`, `limit` honrado, anônima com `person:null`, identificada com `person.display_name`, `[]` quando vazio. Padrão dos integration tests da Onda 4/5.
- **Web unit** (novo `tests/unit/lib/queries-events.test.ts`): `useRecentDetections` com fake timers + mock `apiFetch` — pollou no intervalo quando `enabled:true`; não pollou com `enabled:false`; respeita `refetchIntervalInBackground:false` (mock `document.visibilityState`).
- **Web component** (novo `tests/unit/components/live-feed-polling.test.tsx`): mock do hook — renderiza cards de `data`; botão "Pausar" alterna `enabled`; badge mostra estado correto.
- **DELETE:** `tests/unit/hooks/use-sse.test.ts`.

Sem testes E2E (continua fora de escopo per Onda 3 §11).

---

## 7. Validação operacional (pós-deploy)

1. `deploy.sh` no VPS (git pull + bun build + restart edge/web — zero apt/nginx).
2. `curl -H "X-API-Key: $KEY" https://monitoramento.franquiabv.com.br/api/events/recent?limit=10` → JSON array com até 10 detecções recentes.
3. `curl -i ".../api/events/stream?api_key=$KEY"` → **404** (rota removida — corte limpo confirmado).
4. Browser `/live`: cards aparecem dentro de ≤5 s da próxima detecção; badge "atualizando" pisca a cada poll; pausar/retomar funciona; visibilidade da aba pausa polling.
5. `tail -f /var/log/nginx/vipcam.error.log` — **sem novas** linhas `upstream prematurely closed ... /api/events/stream`.

---

## 8. Out of scope explícito

- Cursor incremental / paginação no `/recent`.
- Mexer no `event-bus` (mantido dormente).
- Retomar SSE depois (config preservada via comentário do nginx vhost; o caminho de re-habilitar exige nova investigação da causa-raiz Bun/Hono × H2, NÃO desta onda).
- Onda 7 (Failover B) — retoma após esta.

---

## 9. Próximos passos

1. Spec aprovado (este doc) → spec-document-reviewer valida.
2. `superpowers:writing-plans` gera plano por chunks (TDD onde aplicável).
3. Execução por `superpowers:subagent-driven-development`.
4. Deploy via `deploy.sh` + validação operacional §7.
5. Retomar **Onda 7 (Failover B)** onde paramos (Seção 2 do spec da Onda 7).
