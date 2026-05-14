# Design: Onda 3 — Frontend de Visibilidade & Resolução

**Data:** 2026-05-14
**Status:** Aprovado (saiu de brainstorming, pendente plano de implementação)
**Autor(es):** Rafael Vaz + Claude
**Contexto:** Onda 2 entregou ingest + match temporal + ERP sync funcionando em produção (369 funcionários sincronizados, scheduler rodando, 1 match ambíguo já parado), mas **toda visibilidade depende de curl/SQL**. Onda 3 entrega o dashboard web mínimo viável pra recepcionista usar o sistema.

---

## 1. Objetivo

Construir o frontend Next.js que dê **visibilidade operacional** do que a câmera + ERP + match temporal estão produzindo, e permita **resolução manual de matches ambíguos**. Sem isso, o sistema funciona "às cegas" — dados acumulam mas ninguém consegue agir sobre eles.

Ondas seguintes (Failover B, Métricas, Hardening LGPD) ficam fora de escopo desta onda.

---

## 2. Decisões consolidadas (do brainstorming 2026-05-14)

### Stack & arquitetura

| Dimensão | Decisão |
|---|---|
| Frontend base | Next.js 14 (App Router) + Tailwind 3.4 + React 18 (já existe em `packages/web`) |
| Componentes UI | **shadcn/ui** (Radix UI por baixo) |
| Data fetching | **React Query (TanStack)** — caching, retry, refetch on focus |
| Realtime | **Server-Sent Events (SSE)** via `Hono streamSSE` |
| Auth | **Sem login. `NEXT_PUBLIC_API_KEY` no bundle** (kiosk LAN-trancado) |
| Snapshots | Endpoint público `GET /snapshots/:filename` no edge (sem auth) |
| Estado | React Query + URL params (sem Redux/Zustand) |

### Telas e layouts

| Tela | Layout escolhido | Justificativa |
|---|---|---|
| Navegação geral | **Topbar horizontal** (B) | Mais espaço pra tabelas/grids; vibe dashboard moderno (Vercel/Linear) |
| `/people` (lista) | **Tabela densa** (A — Linear/Notion style) | Operador busca cliente específico — task-oriented, não browse visual |
| `/people/[id]` (perfil) | **Stack vertical de visitas** (A) | Narrativa visual; "ver a vida desse cliente" |
| `/matches` (review) | **Inbox split** (B — sidebar + detalhe) | Escala bem com volume + familiar (UX email) |
| `/live` (stream) | **Stream vertical** (A — cards aparecendo no topo) | Demo/wow factor; pausável quando user scrolla |

Mockups das decisões: `.superpowers/brainstorm/<session>/{nav,people-list,profile,matches,live}.html`

---

## 3. Endpoints novos no edge

Onda 2 mountou `apiKeyMiddleware` por prefixo (`/api/discovery/*`, `/api/erp/*`, `/api/matches/*`). **Os novos prefixos PRECISAM ser explicitamente protegidos** (não há wildcard global hoje). Adicionar em `server.ts`:

```ts
app.use("/api/persons/*", requireKey);
app.use("/api/sessions/*", requireKey);
app.use("/api/dashboard/*", requireKey);
app.use("/api/events/*", requireKey);  // ⚠ ver nota SSE abaixo
```

`/snapshots/*` fica fora — público (nginx restringe por IP da LAN).

### ⚠ Auth do SSE — caso especial

`EventSource` nativo do browser **não permite headers customizados** — então X-API-Key via header não funciona. 2 opções:

| Opção | Decisão |
|---|---|
| (a) Aceitar `?api_key=` query param em `/api/events/stream` | **Escolhida.** Simples; key aparece em access log do nginx mas o kiosk LAN aceita. Logs rotacionam. |
| (b) fetch-based SSE polyfill que suporta headers | Rejeitada. Bundle +20kb por uma feature que kiosk LAN não precisa. |

`apiKeyMiddleware` precisa ser estendido pra também aceitar a key via query param **APENAS** no path `/api/events/stream` (nunca em endpoints mutativos).

### People

```
GET /api/persons?type=client|employee&search=&limit=50&offset=0
→ { items: PersonSummary[], total: number }

GET /api/persons/:id
→ PersonSummary & {
    avg_dominant_emotion?: string,
    first_seen_at: ISO8601,
    avg_visit_duration_min?: number
  }

GET /api/persons/:id/sessions?limit=20
→ { items: SessionWithDetections[] }
```

### Sessions

```
GET /api/sessions/:id/detections
→ { items: DetectionThumbnail[] }
```
(Usado pra hidratar fotos do card de visita no perfil.)

### Matches enriched

`GET /api/matches/pending` **já existe** mas devolve `MatchAttempt[]` cru. Refatorar pra devolver `MatchPendingEnriched[]` com:
- Dados do `erp_client` correspondente ao checkin (nome, telefone)
- Lista expandida de detections candidatas (snapshot_path + face_attrs + session_id + detected_at)
- Campo `notes` do match_attempt original (útil pra mostrar contexto: "3 candidates" vs threshold reasons)

⚠ **Breaking change:** o response shape muda. Aceitável porque Onda 2 acabou de subir e nenhum cliente externo consome esse endpoint ainda — o smoke test do operator usa `/api/matches/pending` mas via curl manual. Sem versionamento de API por ora.

`POST /api/matches/:id/{resolve,reject}` **já existem** — sem mudança.

### Live feed (SSE)

```
GET /api/events/stream?api_key=<KEY>
Content-Type: text/event-stream
→ Stream de mensagens:
  data: {"type":"detection","detection":{...},"person":{...}|null}\n\n

→ Heartbeat (cada 15s):
  : ping\n\n
```

Implementação: novo módulo `api/events/event-bus.ts` (singleton EventEmitter) + rota SSE em `api/routes/events.ts` que subscribe ao bus. `ingest/pipeline.ts` publica no bus após appendDetection (não-bloqueante; tolerar zero subscribers).

Heartbeat de 15s evita timeout de proxy (nginx default = 60s) e detecta clientes mortos quando não há detection real por muito tempo.

### Dashboard summary

```
GET /api/dashboard/summary
→ {
    pending_matches: number,
    last_detection_at: ISO8601 | null,
    detections_today: number,
    persons_total: { client: number, employee: number }
  }
```

Usado pelo topbar pra mostrar badge de matches pendentes em real-time (poll a cada 30s + invalidate on visibilitychange).

### Snapshots

```
GET /snapshots/:filename
Content-Type: image/jpeg
→ binary
```

Serve direto do filesystem (`/var/lib/vipcam/snapshots/`). Validação: filename só pode conter `[a-z0-9_.-]+\.jpg` (anti path traversal). Cache headers `public, max-age=86400, immutable`.

---

## 4. Tipos compartilhados (`packages/shared/src/types`)

```ts
export interface PersonSummary {
  id: UUID;
  display_name: string | null;
  person_type: 'client' | 'employee' | 'anonymous';
  photo_path: string | null;
  last_seen_at: ISO8601 | null;
  total_visits: number;
  erp_client_id: string | null;
  erp_employee_id: string | null;
  phone: string | null;          // join com erp_clients.phone
}

export interface DetectionThumbnail {
  id: UUID;
  detected_at: ISO8601;
  snapshot_path: string | null;  // → URL: /snapshots/<basename>
  face_attrs: Record<string, unknown>;
  dominant_emotion: string | null;
  emotion_confidence: number | null;
  session_id: UUID | null;
  camera_id: UUID;               // necessário pro LiveDetectionEvent + UI mostrar fonte
}

export interface SessionWithDetections {
  id: UUID;
  started_at: ISO8601;
  ended_at: ISO8601 | null;
  detection_count: number;
  dominant_emotion: string | null;
  linked_erp_checkin_id: string | null;
  detections: DetectionThumbnail[];   // limite 20 por session no payload
}

export interface MatchPendingEnriched {
  match_attempt_id: UUID;
  decided_at: ISO8601;
  notes: string | null;          // contexto do orchestrator (ex: "3 candidates")
  checkin: {
    erp_id: string;
    client_name: string | null;
    client_phone: string | null;
    erp_client_id: string;
    person_id: UUID | null;      // Person.id resolvido via JOIN persons.erp_client_id
    occurred_at: ISO8601;
    event_type: string;
  };
  candidates: DetectionThumbnail[];
}

export interface LiveDetectionEvent {
  type: 'detection';
  detection: DetectionThumbnail;    // já inclui camera_id
  person: PersonSummary | null;     // null se ainda anônimo
}

export interface DashboardSummary {
  pending_matches: number;
  last_detection_at: ISO8601 | null;
  detections_today: number;
  persons_total: { client: number; employee: number };
}
```

---

## 5. Estrutura `packages/web`

```
packages/web/src/
├── app/
│   ├── layout.tsx                # Topbar + main slot + React Query provider + Toaster
│   ├── page.tsx                  # Redirect server-side → /live
│   ├── live/
│   │   └── page.tsx              # Stream vertical (A)
│   ├── people/
│   │   ├── page.tsx              # Tabela densa (A)
│   │   └── [id]/page.tsx         # Stack visitas (A)
│   ├── matches/
│   │   └── page.tsx              # Inbox split (B)
│   ├── discovery/                # já existe — mantém
│   ├── globals.css               # Tailwind + shadcn theme tokens
│   └── providers.tsx             # QueryClientProvider, Toaster
├── components/
│   ├── ui/                       # shadcn/ui copy-paste (button, table, dialog, badge, avatar, card, input, separator, skeleton, sonner)
│   ├── topbar.tsx                # nav + badge contador matches pendentes
│   ├── person-table.tsx          # tabela com search/filter
│   ├── visit-card.tsx            # card de uma visita no perfil
│   ├── visit-card-detections.tsx # mini grid de fotos da visita
│   ├── match-list-item.tsx       # item da sidebar do inbox
│   ├── match-detail.tsx          # painel direito com candidates + buttons
│   ├── detection-card.tsx        # card único do live feed
│   └── live-feed.tsx             # container do stream + pause control
├── lib/
│   ├── api-client.ts             # fetch wrapper c/ X-API-Key, JSON parse, errors
│   ├── env.ts                    # parse de NEXT_PUBLIC_API_KEY + NEXT_PUBLIC_API_URL
│   └── queries/
│       ├── persons.ts            # usePeople, usePerson, usePersonSessions
│       ├── matches.ts            # useMatchesPending, useResolveMatch, useRejectMatch
│       └── dashboard.ts          # useDashboardSummary
├── hooks/
│   ├── use-sse.ts                # subscriber SSE c/ auto-reconnect (3s backoff)
│   └── use-live-feed.ts          # combina use-sse + ring buffer dos últimos N
└── tests/
    ├── unit/                     # componentes isolados
    └── integration/              # páginas com MSW pra mock api
```

### Configuração & ambiente

- `packages/web/.env.example` — adiciona `NEXT_PUBLIC_API_URL=http://localhost:4000` e `NEXT_PUBLIC_API_KEY=change-me`
- `next.config.js` — talvez adicionar headers de cache pra `/snapshots/*` se proxiar via Next; mas no setup deploy real a nginx que faz isso
- `tailwind.config.ts` — atualiza com paths do shadcn (`./components/ui/**`)

---

## 6. Mudanças no edge existente

| Arquivo | Mudança |
|---|---|
| `src/api/server.ts` | Mount de novas rotas: `events`, `persons`, `sessions`, `dashboard`, `snapshots` (esse último fora de `/api/*`). **Adicionar `app.use("/api/persons/*", requireKey)` + similares pra `/sessions/*`, `/dashboard/*`, `/events/*`** — Onda 2 não tem wildcard global. |
| `src/api/middleware/api-key.ts` | Estender pra aceitar `?api_key=` query param **somente** no path `/api/events/stream` (SSE limitation — EventSource não passa headers). Outros endpoints só aceitam header. |
| `src/api/routes/events.ts` | **Novo:** SSE endpoint subscribed no event bus + heartbeat 15s |
| `src/api/routes/persons.ts` | **Novo:** GET /persons*, GET /sessions/*/detections |
| `src/api/routes/dashboard.ts` | **Novo:** GET /summary |
| `src/api/routes/matches.ts` | Refatorar `GET /pending` pra retornar enriched (join com erp_clients + detections) |
| `src/api/routes/snapshots.ts` | **Novo:** serve filesystem; validação anti path-traversal |
| `src/api/events/event-bus.ts` | **Novo:** singleton EventEmitter; tolera zero subscribers |
| `src/ingest/pipeline.ts` | Publica detection no bus após appendDetection (try/catch — falha não bloqueia ingest) |
| `src/persistence/repositories/persons.repo.ts` | Adicionar `listWithFilters({type, search, limit, offset})`, `findByIdWithStats(id)`, `getDashboardCounts()` |
| `src/persistence/repositories/sessions.repo.ts` | Adicionar `listByPerson(personId, limit)` retornando SessionWithDetections (join detections) |

---

## 7. Plano de implementação (chunks)

| Chunk | Conteúdo | Estimativa |
|---|---|---|
| **3.1 — REST endpoints novos (read-heavy)** | persons*, sessions/*/detections, matches enriched, dashboard/summary; tipos compartilhados; testes unit + integration | 2 dias |
| **3.2 — Snapshots + SSE infrastructure** | `/snapshots/:filename` (validação anti-traversal) + middleware extension pra `?api_key=` em /events + event-bus + /events/stream + pipeline publish + use-sse hook + tests | 1 dia |
| **3.3 — Frontend foundation** | shadcn/ui setup + React Query provider + topbar + base layout + .env config + 1 página teste | 1 dia |
| **3.4 — People & Profile** | /people (tabela com search/filter/pagination) + /people/[id] (stack visitas + visit cards) | 2 dias |
| **3.5 — Matches & Live** | /matches (inbox split + detail panel + resolve/reject flow) + /live (stream + pause control) | 2 dias |
| **3.6 — Polish & deploy** | acessibilidade básica (focus rings, aria-labels), error boundaries, loading skeletons, deploy + smoke test no VPS | 1 dia |

**Total estimado: ~9 dias** com folga.

---

## 8. Estratégia de testes

- **Unit (web):** componentes isolados via React Testing Library (Bun test). Cada query hook + cada componente "puro".
- **Integration (web):** MSW (Mock Service Worker) pra mockar respostas do edge e renderizar página inteira. Foco em interações chave: search, paginação, resolve/reject, SSE event arrival.
- **Unit/integration (edge):** padrão Onda 2 (TDD pra repos novos + smoke pra rotas com deps mockadas + integration com Postgres real via `vipcam_test`).
- **E2E:** **fora de escopo nesta onda.** Adicionar Playwright em onda dedicada se houver dor real.

---

## 9. Tratamento de erros e UX

- **Skeleton loaders** durante fetch inicial (shadcn `<Skeleton />`)
- **Error boundary** por página com mensagem genérica + botão "tentar de novo"
- **Toast notifications** (shadcn `<Sonner />`) pra resolve/reject success + falhas de SSE reconnect
- **SSE auto-reconnect:** 3s backoff exponencial até max 30s; UI mostra "● Desconectado" no topbar quando offline
- **Empty states:** ilustração + texto pra cada tela vazia ("Nenhum match pendente — tudo resolvido!", "Aguardando primeira detecção…")
- **Snapshot 404:** `<img onError>` substitui por placeholder genérico (avatar cinza) — snapshot pode ter sido removido por retention futuro ou corrompido

---

## 10. Riscos e débitos técnicos conhecidos

| # | Risco | Mitigação |
|---|---|---|
| R1 | API_KEY no bundle JS — qualquer um na LAN extrai | Aceito (kiosk fechado); revisitar se expor multi-unidade |
| R2 | SSE pode ficar com muitos subscribers (vazamento de memória) | Limite hard de N=10 conexões simultâneas; após que rejeitar com 503; um dashboard só costuma ter 1-2 abas |
| R3 | Snapshots públicos vazam fotos via LAN scan | nginx restringe `/snapshots/*` a IPs internos; LGPD débito pra Onda 4 |
| R4 | Live feed inunda navegador em hora de pico (30/min) | Ring buffer client-side com max 50 cards; novos empurram antigos |
| R5 | Tabela /people com 412+ rows lenta no client | Paginação server-side (limit 50); React Query cache evita re-fetch desnecessário |
| R6 | shadcn/ui copy-paste — manter atualizado é manual | Aceito; updates raros pro escopo MVP |

---

## 11. Out of scope explícito

- ❌ Failover B (re-id local com InsightFace + pgvector) — Onda futura
- ❌ Auth/login de operadores — kiosk LAN
- ❌ Dashboard de métricas agregadas (gráficos, trends, NPS) — depois
- ❌ Mobile responsive — kiosk desktop only
- ❌ Internacionalização — pt-BR hardcoded
- ❌ Retention/LGPD/opt-out de pessoas — Onda 4
- ❌ E2E tests (Playwright) — onda dedicada se necessário
- ❌ Filtros avançados (data range, tag, emoção) — depois de uso real
- ❌ Editar/deletar Person via UI — só read-only por ora

---

## 12. Próximos passos

1. Spec aprovado (este doc) + spec-reviewer subagent valida.
2. `superpowers:writing-plans` gera plano detalhado por chunk com tasks e critérios de aceite.
3. Execução por `superpowers:subagent-driven-development` (mesma estratégia da Onda 2).
4. Deploy para VPS + smoke test pós-merge de cada chunk.
