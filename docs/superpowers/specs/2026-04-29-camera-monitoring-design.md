# Design: Monitoramento de Atributos da Câmera DH-IPC-HFW5442T-ASE

**Data:** 2026-04-29
**Status:** Aprovado (rascunho de design, pendente plano de implementação)
**Autor(es):** Rafael Vaz + Claude (brainstorming session)
**Contexto:** Substitui o projeto `vipcam` (face analytics com pipeline GPU local) por uma abordagem leve baseada em metadados nativos da câmera Dahua DH-IPC-HFW5442T-ASE.

---

## 1. Objetivo

Construir um sistema de monitoramento em tempo real que:

1. Consome **metadados de detecção facial e atributos** já produzidos pela IA embarcada da câmera Dahua (sem GPU local).
2. **Empilha** detecções da mesma pessoa ao longo do tempo, registrando variações de sentimento.
3. Integra com o **ERP próprio** (MySQL local) para catalogar pessoas como **clientes** ou **funcionários** com nome real.
4. Roda num mini PC on-premise na Barbearia VIP (1ª unidade para validação), com arquitetura preparada para expansão futura para 30 unidades.

## 2. Decisões consolidadas

| Tópico | Decisão |
|---|---|
| Escopo | Substituir vipcam — projeto novo do zero |
| Fonte de dados | Metadados nativos da câmera Dahua (sem GPU local pesado) |
| Validação prévia | Fase 1 = discovery dos endpoints reais da câmera (bloqueante) |
| Re-identificação | Estratégia A (Face DB embarcado da câmera) com failover B (InsightFace `buffalo_s` em CPU via sidecar Python) |
| Deployment | Edge agent + backend co-localizados num mini PC on-premise (modular para extração futura para cloud) |
| MVP scope | Discovery + agent + dashboard + cadastro de faces + failover re-id + ERP integration |
| ERP | Próprio, MySQL local na mesma máquina |
| Identificação cliente | Match temporal (check-in ERP × face anônima na janela ±5min) |
| Identificação funcionário | Cadastro proativo via fotos do ERP → upload para Face DB da câmera |
| Privacidade (MVP) | Snapshots de anônimos mantidos indefinidamente (A2); 1 thumbnail principal por pessoa identificada (B1); histórico granular 30d + agregado depois (C3); sem mecanismo formal de consentimento/opt-out (D3) — **débito técnico explícito a revisitar antes da expansão para múltiplas unidades** |
| Dashboard MVP | Stack vertical de cards (B) principal + timeline de tendência (A) como aba secundária; perfil técnico (apenas dev/dono usa no v1) |
| Stack | Bun + Hono + Drizzle ORM + PostgreSQL (backend); Next.js 14 + Tailwind + shadcn/ui (frontend); WebSocket nativo; sidecar Python (FastAPI + InsightFace) opcional |
| Volume operacional | 50–160 clientes/dia + 15 funcionários, 8h30–21h30, câmera frontal na recepção |

## 3. Arquitetura de alto nível

Monólito modular: **um único processo Bun principal (`vipcam-edge`)** + **sidecar Python opcional (`vipcam-reid`)** + **PostgreSQL local**. Tudo num mini PC.

```
┌─ Mini PC barbearia ─────────────────────────────────────────────┐
│                                                                  │
│  ┌──────────┐                                                    │
│  │  Câmera  │ ─── HTTP CGI / SDK callbacks ──▶ ┐                │
│  │  Dahua   │ ◀── REST (cadastro Face DB) ──── │                │
│  └──────────┘                                  │                 │
│                                                ▼                 │
│  ┌──────────┐                          ┌──────────────────┐     │
│  │  ERP     │  ◀─── leitura SQL ────── │                  │     │
│  │  MySQL   │                          │  vipcam-edge     │     │
│  └──────────┘                          │  (Bun + Hono)    │     │
│                                        │                  │     │
│  ┌──────────┐                          │  ┌─ ingest      │     │
│  │ vipcam-  │ ◀─── HTTP localhost ──── │  ├─ reid-mgr    │     │
│  │ reid     │ ──── snapshot+embedding  │  ├─ erp-sync    │     │
│  │ (Python) │                          │  ├─ match-temp  │     │
│  └──────────┘                          │  ├─ api-rest    │     │
│      ↑ failover B só                   │  └─ api-ws      │     │
│                                        └────────┬─────────┘     │
│                                                 │               │
│                                        ┌────────▼─────────┐    │
│                                        │  PostgreSQL      │    │
│                                        │  (vipcam DB)     │    │
│                                        └──────────────────┘    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
                  ▲
                  │ HTTP/WS (rede local)
                  │
       ┌──────────┴──────────┐
       │  Frontend Next.js   │ (mesmo PC ou notebook do dev)
       └─────────────────────┘
```

### 3.1 Módulos internos do `vipcam-edge`

Cada módulo tem responsabilidade única, contratos tipados, e pode ser testado em isolamento:

- **`ingest/`** — escuta a câmera (HTTP listener + poller CGI conforme decidido na Fase 1), normaliza eventos brutos da Dahua em eventos canônicos do domínio (`PersonDetectedEvent`, `FaceAttributesEvent`).
- **`reid-mgr/`** — decide se o evento já vem identificado pela câmera (Face DB hit) ou cai no failover B. Aplica a estratégia A→B.
- **`match-temp/`** — observa eventos de check-in do ERP e tenta vincular faces anônimas dentro da janela temporal. Aplica regras de ambiguidade.
- **`erp-sync/`** — sincroniza dados do ERP (funcionários e fotos → Face DB câmera; clientes e check-ins → DB local).
- **`api/`** — REST (CRUD, queries) + WebSocket (push em tempo real).
- **`persistence/`** — Drizzle ORM, repositórios tipados, migrações.
- **`config/`** — env vars, conexões.
- **`obs/`** — logging estruturado (pino), métricas, event bus interno (EventEmitter tipado).

### 3.2 Comunicação entre módulos

In-process via TypeScript imports + um event bus interno simples (EventEmitter tipado) para desacoplar produtores/consumidores quando útil (ex: `ingest` emite `person.detected`; `reid-mgr` e `match-temp` consomem).

### 3.3 Justificativa para sidecar Python (não Rust/WASM) no failover B

InsightFace é Python-nativo, modelos prontos, comunidade grande. Sidecar via HTTP localhost é trivial, isola crashes, overhead desprezível para ~1 chamada/segundo no failover.

## 4. Modelo de dados

PostgreSQL + Drizzle ORM. Entidades núcleo:

```
┌──────────────┐         ┌──────────────────┐
│  cameras     │◄────────│  detections      │
└──────────────┘ camera_ │  (granular,      │
                  id     │   1 por evento)  │
                         └────────┬─────────┘
                                  │ person_id (nullable)
                                  ▼
┌──────────────┐         ┌──────────────────┐         ┌──────────────────┐
│  erp_clients │◄────────│  persons         │────────►│  face_records    │
│  (cache ERP) │ erp_id  │  (cliente,       │ person_ │  (snapshot +     │
└──────────────┘         │   funcionário,   │  id     │   embedding +    │
┌──────────────┐         │   anônimo)       │         │   camera_face_id)│
│ erp_employees│◄────────│                  │         └──────────────────┘
│  (cache ERP) │ erp_id  └────┬─────────────┘
└──────────────┘              │ person_id
                              ▼
                        ┌──────────────────┐         ┌──────────────────┐
                        │  sessions        │────────►│ sentiment_records│
                        │  (visita lógica) │ session │ (granular 30d +  │
                        └──────────────────┘  _id    │  agregado depois)│
                                                     └──────────────────┘
┌──────────────────┐                ┌──────────────────────┐
│  erp_checkins    │ ──── match ──► │  match_attempts      │
│  (eventos do ERP)│   temporal     │  (auditoria +        │
└──────────────────┘                │   confidence + dec.) │
                                    └──────────────────────┘
```

### 4.1 Tabelas

**`persons`** — entidade central.
- `id` (uuid), `display_name`, `person_type` (`client` | `employee` | `anonymous`), `erp_client_id?` (FK), `erp_employee_id?` (FK), `first_seen_at`, `last_seen_at`, `total_visits`, `avg_satisfaction`, `estimated_age`, `estimated_gender`, `thumbnail_path`, `notes`, `metadata` (JSONB).

**`face_records`** — vínculo entre uma pessoa e suas representações faciais.
- `id`, `person_id` (FK), `camera_face_id?` (string — ID retornado pelo Face DB da câmera), `embedding?` (vector(512), pgvector — populado só se failover B usado), `snapshot_path` (filesystem), `created_at`, `is_primary` (bool).

**`detections`** — cada evento bruto da câmera.
- `id`, `camera_id`, `person_id?` (null quando ainda anônimo), `track_id`, `session_id?`, `bbox` (jsonb), `face_attrs` (jsonb: age, gender, glasses, mask, etc.), `dominant_emotion`, `emotion_confidence`, `snapshot_path?`, `detected_at`, `raw_event` (jsonb — auditoria do payload Dahua original). **Retenção: 30 dias.**

**`sessions`** — visita lógica = agrupamento de detecções consecutivas da mesma pessoa/track (gap < 30s).
- `id`, `person_id?`, `camera_id`, `started_at`, `ended_at?`, `detection_count`, `dominant_emotion`, `avg_emotion_scores` (jsonb), `linked_erp_checkin_id?`. **Retenção: indefinida.**

**`sentiment_records`** — registros de sentimento.
- Granular (por detection) por 30 dias; após isso, agregado consolidado em `sessions.avg_emotion_scores`.
- `id`, `detection_id?`, `session_id`, `person_id`, `emotion`, `confidence`, `recorded_at`.

**`erp_clients` / `erp_employees`** — cache local dos cadastros do ERP (espelho leve, atualizado pelo `erp-sync`).

**`erp_checkins`** — eventos relevantes lidos do ERP (cliente confirmou agendamento, abriu comanda).
- `id`, `erp_client_id`, `event_type`, `occurred_at`, `processed_at?`, `metadata` (jsonb).

**`match_attempts`** — auditoria do match temporal.
- `id`, `detection_id`, `erp_checkin_id`, `confidence_score`, `decision` (`auto_matched` | `ambiguous` | `rejected`), `decided_at`, `decided_by` (`system` | `user`), `notes?`.

**`cameras`** — config das câmeras (preparado para multi-câmera futura).
- `id`, `name`, `ip_address`, `credentials_ref` (env var, não senha em DB), `face_db_capacity`, `face_db_used`, `is_active`.

### 4.2 Decisões-chave do modelo

1. `person_id` em `detections` é nullable — uma face pode ser detectada antes de ser identificada. Promove para "anonymous" quando session fecha sem match.
2. `embedding` como `vector(512)` (pgvector) prepara para failover B (vazio enquanto só A é usada).
3. `raw_event` JSONB em `detections` preserva o payload original por 30d — fundamental para debug do discovery.
4. `sessions` desacopla "visita" de "detecção".
5. `erp_*` são cache, não fonte de verdade.
6. `match_attempts` cria histórico auditável.

## 5. Fluxos críticos

### 5.1 Ingest com Face DB hit (caminho feliz)

```
Câmera Dahua → ingest (normalize) → reid-mgr (camera_face_id presente)
  → lookup face_record → person_id resolvido
  → persistence (detection + session upsert)
  → event bus emite "person.detected"
  → api-ws push aos clientes WS conectados
```

Latência dominada por uma query indexada (sub-ms).

### 5.2 Re-id failover B (anônimo desconhecido)

```
ingest → reid-mgr (sem camera_face_id) → HTTP POST localhost:5005/embed
  → vipcam-reid Python (InsightFace buffalo_s) → embedding 512-d
  → pgvector ANN search em face_records (LIMIT 1, distance < 0.4)
  → MATCH: reuse person_id
  → MISS: cria pessoa anônima + insere face_record com embedding
```

Threshold (~0.35–0.45 cosine para `buffalo_s`) é calibrado durante discovery.

### 5.3 Match temporal (anônimo → cliente do ERP)

Janela ±5min em torno do checkin. Conservador: auto_match só quando há **uma única** candidata anônima.

```
erp_checkin lido → janela [T-300s, T+300s]
  → busca detections com person_id=anonymous OU sessions abertas sem person_id
  → COUNT == 1: auto_match → vincula → upload snapshot ao Face DB câmera → registra match_attempt
  → COUNT > 1: registra match_attempt {decision: ambiguous} → WS notifica frontend para revisão manual
  → COUNT == 0: registra match_attempt {decision: rejected, reason: no_candidate}
```

Sucesso de match dispara upload retroativo da face anônima ao Face DB da câmera → próximas visitas já vêm identificadas (estratégia A funciona).

### 5.4 Sync de funcionários (cadastro proativo)

```
erp-sync (cron horário + on-demand)
  → SELECT employees WHERE photo_url IS NOT NULL
  → para cada: já existe person? não → cria + baixa foto + POST Face DB câmera
                                 sim → checa hash; mudou? → re-upload
```

Idempotente. Capacidade do Face DB monitorada (alerta a partir de 80%).

## 6. API contracts

### 6.1 REST (Hono, validação Zod)

Sob `/api`:

| Categoria | Endpoints |
|---|---|
| **Pessoas** | `GET /persons`, `GET /persons/:id`, `GET /persons/:id/sessions`, `GET /persons/:id/sentiment-timeline`, `PATCH /persons/:id`, `POST /persons/:id/promote`, `DELETE /persons/:id` (soft) |
| **Detecções/sessões** | `GET /detections/recent`, `GET /sessions/active`, `GET /sessions/:id` |
| **Match temporal** | `GET /matches/pending`, `POST /matches/:id/resolve`, `POST /matches/:id/reject` |
| **ERP** | `POST /erp/sync/employees`, `POST /erp/sync/clients`, `GET /erp/sync/status`, `POST /erp/checkin-webhook` (opcional) |
| **Câmera/admin** | `GET /cameras`, `GET /cameras/:id/face-db`, `POST /cameras/:id/face-db`, `DELETE /cameras/:id/face-db/:faceId`, `GET /cameras/:id/health` |
| **Discovery** | `POST /discovery/probe`, `GET /discovery/last-report` |
| **Sistema** | `GET /health`, `GET /metrics` (Prometheus) |

**Auth (MVP):** `X-API-Key` estática via env var. Suficiente para rede local. Trocar por OAuth/JWT na expansão para cloud — endpoint contracts ficam intactos.

### 6.2 WebSocket

Endpoint único: `WS /api/ws`. Cliente assina **tópicos** via mensagem `subscribe`. Mensagens JSON tipadas com `type` discriminator.

| Tópico | Quando dispara |
|---|---|
| `person.detected` | Cada detecção persistida |
| `session.started` / `session.ended` | Início/fim de sessão |
| `match.ambiguous` | Match temporal precisou de revisão |
| `match.resolved` | Match resolvido (auto ou manual) |
| `erp.sync.progress` | Progresso de sync em background |
| `camera.health` | Mudança de status da câmera |

Cliente envia: `subscribe`, `unsubscribe`, `ping`. Reconexão com `?since=<lastEventId>` (replay de até 5min). Backpressure: cliente atrasado é dropado após 100 mensagens não-acks.

## 7. Estrutura de pastas

Monorepo com workspaces Bun. Três pacotes principais: `edge`, `web`, `reid`, mais `shared` para tipos.

```
DH-IPC-HFW5442T-ASE/
├── package.json (workspaces)
├── bun.lockb
├── docker-compose.yml          # Postgres + (opcional) reid sidecar
├── docs/superpowers/specs/
├── packages/
│   ├── shared/                  # types + Zod schemas (importado por edge e web)
│   ├── edge/                    # backend Bun + Hono
│   │   └── src/
│   │       ├── main.ts
│   │       ├── config/
│   │       ├── ingest/          # dahua-client, http-listener, poller, normalizer
│   │       ├── reid-mgr/        # strategy, lookup, failover
│   │       ├── match-temp/      # window, matcher, upload-back
│   │       ├── erp-sync/        # mysql-client, employees, clients, checkins, scheduler
│   │       ├── persistence/     # drizzle schema + repositories + migrations
│   │       ├── api/             # routes + middleware + ws
│   │       ├── discovery/       # prober + report
│   │       ├── obs/             # logger, metrics, event-bus
│   │       └── retention/       # cleanup job
│   ├── web/                     # Next.js 14 (App Router) + Tailwind + shadcn/ui
│   │   └── src/
│   │       ├── app/             # pages: /, /persons, /persons/[id], /matches, /discovery, /settings
│   │       ├── components/      # PersonStackCard, SentimentTimeline, LiveDetectionFeed, MatchAmbiguityResolver
│   │       ├── hooks/           # useWebSocket, useApi
│   │       └── lib/             # api-client, ws-client
│   └── reid/                    # sidecar Python (FastAPI + InsightFace buffalo_s)
├── scripts/                     # dev.sh, seed-camera.ts, seed-test-data.ts
└── infra/                       # systemd units + deploy.md
```

### Princípios

1. `packages/shared` garante zero drift de tipos entre backend e frontend.
2. Cada módulo do `edge` tem `index.ts` exportando apenas a interface pública.
3. `repositories/` isolam Drizzle das outras camadas.
4. `tests/` espelha estrutura de `src/`.
5. `infra/` separado de código.
6. `reid/` é autônomo — pode rodar fora ou nem rodar (estratégia A não precisa).

## 8. Tratamento de erros e observabilidade

### 8.1 Estratégia por categoria

| Categoria | Estratégia |
|---|---|
| Transientes câmera | Retry exponencial (3x: 1s/2s/4s), `warn`, continua pipeline |
| Persistentes câmera | `error`, WS `camera.health=down`, retry loop a cada 30s, banner no frontend |
| Transientes DB | Pool reconecta, fila in-memory bounded (max 1000), métrica `events.dropped` se estoura |
| Persistentes DB (>60s) | Modo degradado: WS continua do buffer, REST 503 |
| Transientes reid sidecar | Falha o failover B nessa detecção (`reid_failed=true`); pessoa fica anônima; tenta na próxima |
| Persistentes reid sidecar | Sistema continua só com estratégia A; alerta |
| Transientes ERP MySQL | Pool reconecta, sync retoma do cursor |
| Persistentes ERP MySQL | Match temporal pausa; cache cobre leituras; WS `erp.sync.degraded` |
| Erros de validação payload | Salva em `raw_event`, `warn` com hash; discovery report acumula |
| Bugs (uncaught) | Log + reinicia processo via systemd |

### 8.2 Princípios

1. Falha localizada nunca derruba o sistema (try/catch granular por evento).
2. Audit trail sempre (`raw_event`, `match_attempts`).
3. Backpressure explícito (filas bounded; métrica clara, nunca OOM).
4. Modo degradado > offline.

### 8.3 Logging

**Pino** estruturado (JSON em prod, pretty em dev). Níveis padrão (`trace` off em prod). Cada log carrega `correlation_id` propagado pelo pipeline daquele evento. Arquivos rotacionados via systemd/logrotate. Sem ELK no MVP.

### 8.4 Métricas

`/metrics` em formato Prometheus. Counters mínimos:

- `detections_received_total{camera_id}`
- `detections_persisted_total{camera_id, person_type}`
- `detections_dropped_total{reason}`
- `reid_strategy_total{strategy, result}`
- `reid_b_latency_ms` (histogram)
- `match_attempts_total{decision}`
- `erp_sync_duration_seconds{entity}` (histogram)
- `erp_sync_errors_total{entity}`
- `camera_health{camera_id}` (gauge)
- `face_db_capacity_used_ratio{camera_id}` (gauge)
- `ws_clients_connected` (gauge)

### 8.5 Health check

`GET /health` retorna 200 só se todas as deps essenciais estão OK. Resposta com detalhamento por subsystem (`db`, `camera`, `reid_sidecar`, `erp_mysql`). Status `degraded` (sistema funciona com perda de capacidade) é distinto de `down`. systemd não reinicia em `degraded`.

### 8.6 Alerting

MVP: sem alerting externo. Hook `Alerter` com impl noop, plugável depois (webhook Discord/Telegram).

## 9. Estratégia de testes

Pirâmide enxuta: ~80% unit, ~15% integration, ~5% E2E.

### 9.1 Unit (Bun test)

Cada módulo testado com IO mockado. Cobertura mínima:
- Módulos de regra de negócio (normalizer, matcher, strategy, retention): **>90%**
- Adapters (clients HTTP, repositories): smoke + cobertos por integration

Cada arquivo `foo.ts` em `src/` tem `tests/unit/foo.test.ts` espelhado.

### 9.2 Integration

**testcontainers** para Postgres + pgvector real, fakes HTTP para câmera Dahua e MySQL ERP. Cenários:

| Cenário | Valida |
|---|---|
| End-to-end ingest A | Evento com `camera_face_id` → DB correto + WS publicado |
| End-to-end ingest B (failover) | Evento sem `face_id` → embedding salvo, anônimo criado |
| Match temporal feliz | Checkin + única detection → vinculação + upload Face DB |
| Match ambíguo | 2 detections → `match_attempt {ambiguous}` + WS notifica |
| Sync funcionários | Fake ERP retorna mix → DB e Face DB câmera refletem corretamente |
| Recuperação de DB drop | Conexão derruba → buffer → DB volta → eventos processados em ordem |
| Idempotência | Sync ERP 5x consecutivas = mesmo resultado |
| Retention cleanup | Detections > 30d sumiram, sessions agregadas permanecem |

Tempo alvo: <30s para suíte inteira de integration.

### 9.3 E2E

Playwright contra stack completa em docker-compose de teste. Apenas caminhos felizes:

- Dashboard recebe detecção em tempo real (<2s)
- Resolução de match ambíguo via UI
- Discovery report

E2E não roda em CI no MVP — manual antes de release.

### 9.4 Frontend

Vitest + Testing Library para componentes isolados. Hooks (`useWebSocket`) com mock server. Sem snapshot tests.

### 9.5 Sidecar Python

Pytest. Fixtures de imagem. Valida embedding 512-d normalizado, similaridade entre fotos da mesma pessoa > threshold. ~5 testes.

### 9.6 Disciplina TDD

`superpowers:test-driven-development` aplicada nos módulos de regra de negócio (normalizer, matcher, strategy, retention). Para adapters, integration test primeiro depois implementação.

### 9.7 CI

GitHub Actions (ou pre-commit local): lint (biome), type check (tsc strict), unit + integration (Postgres em service container), build edge + web. E2E não em CI.

## 10. Fases de implementação

| Fase | Duração | Objetivo | Checkpoint |
|---|---|---|---|
| **0. Scaffolding** | 1–2d | Repo executável vazio com tooling certo | `bun dev` sobe edge + web |
| **1. Discovery câmera** ⚠ bloqueante | 3–5d | Mapear o que a câmera realmente entrega | Relatório de descoberta confirma/ajusta design; canal de ingest decidido |
| **2. Modelo + ingest** | 3–4d | Eventos viram linhas no DB | 1h ininterrupta gerando `detections`/`sessions` consistentes |
| **3. Re-id estratégia A + admin** | 3–4d | Identificação automática via Face DB câmera | Cadastro manual reconhecido, person aparece identificada |
| **4. ERP + match temporal + sync funcionários** | 4–6d | Funcionários auto-cadastrados, clientes vinculados via checkin | Cliente que confirma checkin tem face vinculada em <1min; próxima visita já vem identificada |
| **5. Frontend dashboard** | 3–5d | UI mínima para validação técnica | Detecções em tempo real; perfil com Stack B + Timeline A; ambíguos resolvíveis |
| **6. Failover B (re-id local)** | 3–4d | Identificação local sem cadastro no Face DB | Anônimo recorrente reconhecido como mesma pessoa entre visitas |
| **7. Hardening + deploy on-premise** | 2–3d | Sai da máquina de dev e entra no mini PC | Reinício do mini PC → tudo sobe sozinho → 24h sem intervenção |

**Estimativa total: ~22–33 dias úteis (≈4–7 semanas).**

### 10.1 Sequenciamento

- Fases 0 → 1 → 2 → 3 são sequenciais (cada uma habilita a próxima).
- Fases 4 e 5 podem ser paralelas se houver mais de um dev.
- Fase 6 pode ser adiada se 3 + match temporal cobrirem bem o uso real.
- Fase 7 só após estabilização das anteriores.

### 10.2 Fork de design na Fase 1

Se a câmera **não** entregar emoção nativa via API standard:
- (a) Aceitar e seguir só com idade/gênero (perde "stack de sentimento").
- (b) Adicionar inferência de emoção CPU-only no sidecar reid (HSEmotion ONNX, ~30ms/face) — adiciona ~1 semana de trabalho.

## 11. Riscos e débitos técnicos conhecidos

| # | Risco/Débito | Mitigação |
|---|---|---|
| R1 | Câmera não entrega emoção nativa via API | Fork de design na Fase 1 (opções a/b acima) |
| R2 | Capacidade do Face DB câmera (~10k) insuficiente para 30 unidades | Failover B (Fase 6) cobre — pgvector escala bem |
| R3 | Janela ±5min do match temporal falha em horários de pico (várias chegadas simultâneas) | UI de revisão manual de ambíguos (`/matches`); janela configurável; iteração com dados reais |
| R4 | Privacidade/LGPD: snapshots de anônimos indefinidos + sem opt-out | Débito explícito a revisitar antes da expansão multi-unidade; Person.delete soft já implementado prepara o terreno |
| R5 | Match temporal pode falsificar identidade (vincular face errada a cliente) | Decisão conservadora (só auto-match com 1 candidata); auditoria via `match_attempts`; UI permite reverter |
| R6 | Sidecar Python crash deixa Fase 6 inoperante | Sistema continua só com estratégia A; alerta + restart automático via systemd |
| R7 | Migração futura para multi-unidade exigirá extrair edge agent | Modularidade interna do monólito facilita refactor; `ingest/` já é o "edge agent" embrionário |

## 12. Próximos passos

1. Aprovar este design.
2. Criar plano de implementação detalhado (skill `superpowers:writing-plans`) por fase.
3. Iniciar Fase 0 (scaffolding).
