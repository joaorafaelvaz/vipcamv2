# Onda 7 — Failover B (re-id local) + Snapshots no /live — Design

**Status:** Aprovado (saiu de brainstorming, pendente plano de implementação)
**Autor(es):** Rafael Vaz + Claude
**Data:** 2026-05-20
**Gate de entrada:** Onda 6 — Camera Image-Source Probe (relatório `docs/superpowers/specs/2026-05-18-camera-image-source-probe-report.md`). Decisão humana 2026-05-19: VIÁVEL via `snapshot.cgi` + crop pela bbox do evento.

---

## 1. Objetivo

Identificar anônimos recorrentes como a mesma pessoa entre visitas, sem cadastro no Face DB da câmera, e exibir o rosto recortado nos cards do `/live`. Resolve simultaneamente:

- **Snapshots blank no `/live`** (visto em produção 2026-05-20) — `detection.snapshot_path` nunca é populado pelo pipeline atual.
- **Failover B** — re-identificação local via InsightFace + pgvector (Estratégia B do design original; Estratégia A refutada na Onda 6 porque o hardware DH-IPC-HFW5442T-ASE não tem Face DB embarcado via CGI).

### Não-objetivos
- Multi-câmera (1 câmera só hoje; layout do disco prevê expansão).
- Re-embedding em background quando trocar modelo (deferred; documentado como débito).
- LGPD opt-out / retenção configurável por pessoa (Onda futura; retenção global 30d entra).
- Substituir match temporal (continua sendo a fonte de "ground truth" pra ligar a clientes do ERP — reid é heurística complementar).

### Sucesso operacional
- Cards do `/live` mostram rosto recortado para >80% das detecções (taxa de utilização do crop, condicionada ao gate da Onda 6).
- Pessoa que volta após primeira visita é re-identificada automaticamente (`person_id` populado por reid antes do INSERT).
- Conflitos reid vs ERP nunca auto-resolvem silenciosamente — todos viram `match_attempts` ambíguos pra revisão humana.

---

## 2. Snapshot persistence

### 2.1 O que gravar
Apenas o **crop pela bbox** do evento (`FaceDetection` event traz `x,y,w,h`). Frame inteiro NÃO é gravado — sidecar reid faz crop em memória e devolve só embedding+det_score. O crop final (~150 KB típico) é serializado em JPEG e escrito em disco.

Justificativa: gate da Onda 6 mostrou que rostos no frame inteiro (~87 px) ficam abaixo do limiar usável; crop é o que viabiliza tanto o embedding quanto a UI.

### 2.2 Layout de diretório
```
/var/lib/vipcam/snapshots/<YYYY-MM-DD>/<detection-uuid>.jpg
```
- Hierárquico por data → retention via `find -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +` (zero query no DB).
- `<detection-uuid>` = `detections.id` → mapeamento 1:1 trivial; `ls` por dia é rápido (~1k arquivos/pasta).

### 2.3 Schema
`detections.snapshot_path` (text nullable, já existe) armazena **path relativo**: `"2026-05-20/abc.jpg"`. URL servida via `GET /snapshots/2026-05-20/abc.jpg`.

A regex anti-traversal no route `/snapshots/:filename` (hoje `^[a-zA-Z0-9_.-]+\.jpg$`) muda pra aceitar segmento de data: rota vira `/snapshots/:date/:filename` com duas validações Hono (date `^\d{4}-\d{2}-\d{2}$`, filename `^[a-zA-Z0-9-]+\.jpg$`).

### 2.4 Retention
**30 dias**, cron diário 03:00 BRT no scheduler edge (mesmo módulo que hospeda `scheduler_checkins` e `scheduler_clients`). `find -mtime +30` no nível de diretório de dia. Job aparece em `getJobHealth()` → `checks.scheduler_snapshots` no `/api/health`.

Coluna `snapshot_path` em detections antigas pode apontar pra arquivo inexistente após retention — `GET /snapshots/:date/:filename` já retorna 404 graceful, não quebra o `/live` (UI mostra placeholder).

### 2.5 Write timing
**Sync sequencial** dentro do `processEvent`:
```
normalize → capture snapshot.cgi → POST /embed (sidecar faz crop em memória) →
ANN query pgvector → decide person_id → write crop em disco (await fs.writeFile) →
INSERT detection com snapshot_path + person_id
```

Garante: quando detection vira visível no `/live`, snapshot JÁ está em disco. Sem race condition. Latência total estimada: ~1s/evento (~720 ms snapshot.cgi + ~30 ms embed warm + ~10 ms write). Throughput limite ~3.6k eventos/h sequencial — folga absurda vs carga real (~40/h).

---

## 3. Sidecar contract + deploy (`vipcam-reid`)

### 3.1 Endpoint novo: `POST /embed`
Adicionado ao `packages/reid/src/main.py`. Não toca `/detect` da Onda 6 (probe one-shot ainda usa).

**Request:** `multipart/form-data`
- `file`: bytes do frame inteiro (~600 KB, JPEG)
- `x, y, w, h`: form fields inteiros (bbox do evento Dahua, em coordenadas do frame)

**Response:** JSON
```json
{
  "embedding": [0.123, -0.456, ...],   // 512 floats
  "det_score": 0.92,                    // confiança da detecção pós-crop
  "infer_ms": 28,
  "model_name": "buffalo_s",
  "model_revision": "insightface-0.7.3"
}
```

Sidecar valida bbox dentro do frame (fallback: erro 400 se inválido). PIL faz `Image.open(BytesIO).crop((x, y, x+w, y+h))` antes do `model.get(...)`. Crop fica em memória — sidecar não escreve em disco. Edge usa o crop devolvido para o write em disco (Seção 2).

> **Decisão de design:** crop no sidecar (não no edge) para evitar dependência de bib de imagem JS no Bun (sharp/jimp/ffmpeg). Payload `localhost` 600 KB via loopback é ~5 ms — desprezível.

### 3.2 Cliente edge (`reid-client.ts`)
Ganha função nova `embed(reidBaseUrl, frameBytes, bbox, timeout=3000)`. `detect(...)` existente intocado.

```typescript
export async function embed(
  reidBaseUrl: string,
  frameBytes: Buffer,
  bbox: { x: number; y: number; w: number; h: number },
  timeoutMs = 3_000,
): Promise<EmbedResult>
```

`EmbedResult` em `packages/shared`: `{ embedding: number[]; det_score: number; infer_ms: number; model_name: string; model_revision: string }`.

### 3.3 Cold start: pre-warm via `ExecStartPost`
Systemd unit `infra/systemd/vipcam-reid.service` ganha:
```
ExecStartPost=/bin/sh -c '\
  curl --fail --silent --retry 30 --retry-delay 1 \
    -F file=@/opt/vipcamv2/packages/reid/assets/warmup.jpg \
    -F x=0 -F y=0 -F w=64 -F h=64 \
    http://127.0.0.1:5005/embed > /dev/null'
```

Imagem dummy 64×64 vendorizada em `packages/reid/assets/warmup.jpg`. Sidecar fica warm antes do `systemctl start` retornar — cold start (~5,5s) nunca afeta pipeline runtime. Cliente edge usa timeout **3s** normal.

### 3.4 Health: `checks.reid`
`GET /api/health` ganha ping sync ao `/health` do sidecar (timeout 1s). Retorno:
```json
{
  "reid": {
    "ok": true,
    "latency_ms": 8,
    "model_name": "buffalo_s",
    "model_revision": "insightface-0.7.3"
  }
}
```

`reid.ok=false` degrada o `status` geral para `"degraded"` (HTTP 503) — monitoring/uptime alerta. Sem cache.

### 3.5 Failure mode: graceful degrade
Quando `embed()` falha (timeout, 5xx, fetch error):
- Pipeline continua. Snapshot é capturado e escrito normalmente.
- `resolvePersonId` retorna `null`.
- INSERT detection com `person_id=null` + `face_attrs.reid_status='unavailable'` + `face_attrs.reid_error=<message>`.
- Log `warn` com a falha.
- Nenhum `face_record` criado.

Reid volta → próxima detecção passa direto. Zero perda de dados de detecção (vs fail-hard, que perderia detections durante outage).

### 3.6 Versionamento de modelo
`model_name` e `model_revision` são retornados pelo sidecar e gravados pelo edge em **cada** `face_record`. Permite mudar modelo no futuro sem invalidar face_records existentes em uma query — filtros `WHERE model_name=$current AND model_revision=$current` no SELECT de match descartam embeddings incompatíveis automaticamente.

Política inicial (Onda 7): `buffalo_s` / `insightface-0.7.3`. Re-embedding em background quando trocar modelo é **débito documentado**, não escopo da Onda 7.

---

## 4. Schema pgvector + decisão de match

### 4.1 Deltas no schema
**`face_records`** (tabela já existe desde Onda 2 com `vector(512)` + HNSW cosine, FK pra persons CASCADE, `snapshot_path`, `is_primary`):
- ADD `model_name text NOT NULL DEFAULT 'buffalo_s'`
- ADD `model_revision text NOT NULL DEFAULT 'insightface-0.7.3'`
- ADD `det_score real` (qualidade do crop pra debug + filtrar matches contra crops ruins)
- ALTER `embedding` SET NOT NULL (safe: tabela está vazia hoje porque Failover B nunca existiu)

Índice HNSW já cobre `embedding`; queries de match filtram por `model_name`/`model_revision` no WHERE pós-ANN. Sem novo índice necessário.

**`reid_match_attempts`** (NOVA, separada de `match_attempts` temporal):
```
id                          uuid PK
detection_id                uuid NOT NULL FK detections(id) CASCADE
candidate_face_record_id    uuid NOT NULL FK face_records(id) CASCADE
candidate_person_id         uuid NOT NULL FK persons(id) CASCADE
distance                    real NOT NULL
decision                    enum('ambiguous'|'matched_to_candidate'|'rejected_new_person') NOT NULL
decided_by                  enum('system'|'user') NOT NULL DEFAULT 'system'
decided_at                  timestamptz NOT NULL DEFAULT now()
notes                       text
```
Índice parcial `pending_idx ON (decided_at) WHERE decision='ambiguous'` (espelha pattern de `match_attempts`).

### 4.2 Top-K=5 com FIFO eviction (no app code)
`faceRecordsRepo.insertAndEvict(person_id, payload)` transacional:
```
BEGIN
  INSERT INTO face_records (...) RETURNING id
  SELECT id FROM face_records WHERE person_id=$1 ORDER BY created_at DESC OFFSET 5
  DELETE FROM face_records WHERE id IN (...)
COMMIT
```

Lógica em TS, unit-test com mocks de Drizzle. Sem trigger Postgres (segue padrão Drizzle-first do projeto).

### 4.3 Match policy (ANN top-1 + dual threshold)
```sql
SELECT person_id, embedding <=> $new AS dist
FROM face_records
WHERE model_name=$1 AND model_revision=$2
ORDER BY dist
LIMIT 1
```

Decisão:
| Distance | Ação | persons/face_records ops |
|---|---|---|
| `dist ≤ 0.35` | **MATCH strict** (auto-link) | UPDATE persons.last_seen_at, total_visits+=1; INSERT face_record(person_id=match, is_primary=false); eviction FIFO |
| `0.35 < dist ≤ 0.55` | **BORDERLINE** (review humana) | INSERT detection com person_id=null + face_attrs.reid_status='ambiguous' + reid_distance; INSERT reid_match_attempt(decision='ambiguous'); SEM face_record (humano decide) |
| `dist > 0.55` | **PERSON NOVA** | INSERT persons(type='anonymous'); INSERT face_record(is_primary=true) |
| (sem resultados — DB vazio) | **PERSON NOVA** | mesmo do `dist > 0.55` |

Thresholds via ENV (`REID_DIST_STRICT=0.35`, `REID_DIST_LOOSE=0.55`) pra tuning empírico sem rebuild.

Voting top-K fica adiável (top-1 é suficiente pra começar; se falsos positivos forem altos, vira otimização).

---

## 5. Person bootstrap + ERP linkage

### 5.1 Conflito reid vs match temporal → sempre ambiguous
Match temporal (orchestrator existente da Onda 2/3) continua rodando em background após cada checkin ERP novo. Quando vê detection candidata na janela ±5min:

| `detection.person_id` | Sugestão ERP | Ação |
|---|---|---|
| `NULL` | 1 cliente | Comportamento atual: auto-match |
| `NULL` | 2+ clientes | Comportamento atual: ambiguous |
| `= cliente do ERP` | mesmo cliente | NO-OP |
| `= cliente X` (anônimo) | cliente Y | **AMBIGUOUS** — humano decide merge X→Y ou reject |
| `= cliente W` (já cliente) | cliente Y | **AMBIGUOUS** — reid pode estar errado |

Nunca auto-link silencioso quando há divergência. Tabela usada: a já-existente `match_attempts` (temporal), porque a sugestão é de checkin → continua semanticamente correta.

### 5.2 Person Merge transacional (hard merge)
Quando humano resolve ambiguous "X é Y" no `/matches`:
```
BEGIN
  UPDATE detections     SET person_id=Y WHERE person_id=X
  UPDATE sessions       SET person_id=Y WHERE person_id=X
  UPDATE face_records   SET person_id=Y WHERE person_id=X
  -- eviction FIFO em Y se total>5
  DELETE FROM face_records WHERE person_id=Y AND id IN
    (SELECT id FROM face_records WHERE person_id=Y ORDER BY created_at DESC OFFSET 5)
  UPDATE persons
    SET total_visits = total_visits + (SELECT total_visits FROM persons WHERE id=X),
        first_seen_at = LEAST(first_seen_at, (SELECT first_seen_at FROM persons WHERE id=X))
    WHERE id=Y
  INSERT INTO person_merge_audit (src_id, dst_id, merged_at, merged_by, src_snapshot)
    VALUES (X, Y, now(), $user, row_to_json(X))
  DELETE FROM persons WHERE id=X
  -- CASCADE limpa reid_match_attempts.candidate_person_id refs
COMMIT
```

Helper `personsRepo.mergeInto(srcId, dstId)` compartilhado entre `resolveAmbiguous` (existente, match temporal) e `resolveReidAmbiguous` (novo).

Irreversível (sem undo). `person_merge_audit` permite reconstruir o que X tinha pra fins de auditoria, mas refs já viraram Y.

### 5.3 Endpoints novos
- `GET /api/matches/reid/pending?limit=N` → lista `reid_match_attempts` com `decision='ambiguous'`, enriquecidos com snapshots de detection + candidate face_record + dados de ambos persons (X e Y). DESC por `decided_at`.
- `POST /api/matches/reid/:id/resolve` body `{ decision: "matched_to_candidate" | "rejected_new_person" }`:
  - `matched_to_candidate` → MERGE detection.person_id atual em candidate_person_id (via `mergeInto`); UPDATE reid_match_attempt(decision, decided_by='user').
  - `rejected_new_person` → mantém detection.person_id atual (anônima nova); UPDATE reid_match_attempt(decision='rejected_new_person').

Auth: `apiKeyMiddleware` herdado via `app.use("/api/matches/*", requireKey)`.

### 5.4 UI: aba "Reid borderline" no `/matches`
Componente side-by-side: snapshot da detection (esquerda) vs snapshot da candidate face_record (direita), com distance + det_scores. Dois botões: **"Mesma pessoa"** (merge) e **"Pessoas diferentes"** (reject).

Aproveita componentes existentes da aba temporal. Endpoint queries via React Query (já é o pattern pós-Onda 8).

### 5.5 Feature flag `REID_ENABLED`
Env var no edge, default `true` em prod (após validação). Quando `false`:
- `resolvePersonId` mantém stub atual (sempre `null`).
- Snapshot capture+write da Seção 2 **continua rodando** (parte é independente; resolve o problema do `/live` blank mesmo sem Failover B).
- `/embed` não é chamado; `checks.reid` no health vira `{ok: true, disabled: true}`.
- UI `/matches reid` ainda lista pendentes (residuais de operação prévia) mas pode mostrar banner "Reid desabilitado".

Permite rollback rápido se reid produzir matches ruins em produção.

---

## 6. Fluxos operacionais (cenários canônicos)

### Cenário A — Cliente novo, sem face histórica
1. Detection chega → reid query top-1: vazio → person nova (anônima X).
2. INSERT detection(person_id=X) + face_record(person_id=X, is_primary=true).
3. ~1min depois: checkin ERP chega → match temporal vê candidato → cria match_attempt(detection_id=det, candidate=Y, decision=ambiguous).
4. Humano no `/matches` confirma "X é Y" → `mergeInto(X, Y)` → face_records de X migram pra Y; X deletado.
5. Próxima visita: reid auto-match a Y como cliente identificado.

### Cenário B — Cliente recorrente já ligado
1. Detection → reid auto-match a Y (cliente conhecido) → INSERT detection(person_id=Y) + face_record(person_id=Y).
2. Checkin do Y na janela → match temporal vê Y == cliente do checkin → NO-OP.

### Cenário C — Reid errado
1. Detection → reid auto-match a person W (cliente errado, distance borderline pegou um par parecido).
2. Checkin do cliente Y na janela → match temporal divergiu (W vs Y) → ambiguous.
3. Humano corrige no `/matches` (reject ou merge na direção certa).

### Cenário D — Anônimo recorrente sem checkin
1. Detection → reid auto-match a anônimo X → INSERT detection(person_id=X) + face_record(person_id=X); FIFO eviction se >5.
2. Nenhum checkin na janela → permanece anônimo X.

---

## 7. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Threshold dual mal-calibrado em produção (taxa de falsos positivos ou falsos negativos alta) | Thresholds via ENV (sem rebuild); logs estruturados com `reid_distance` + UI mostra borderline; revisão semanal das `reid_match_attempts` resolvidas vira input pra ajuste empírico |
| Sidecar reid down em produção (process crash) | Graceful degrade + systemd `Restart=always` + `checks.reid` no health (alerta external) |
| Crop da bbox cai fora do frame (evento Dahua reporta coordenadas erradas) | Sidecar valida bbox antes do crop, retorna 400; cliente edge captura erro como falha de embed (graceful degrade); log warn pra investigação |
| Mudança futura de modelo invalida face_records existentes silenciosamente | `model_name`+`model_revision` gravados; queries de match filtram pelo current — embeddings de outro modelo são ignorados (pessoas ficam anônimas até serem re-vistas e re-embedidas naturalmente) |
| Snapshots crescendo sem limite | Cron de retention 30d + `checks.scheduler_snapshots` no health (alerta se job falhar) |
| Person Merge irreversível confunde operador | UI confirmation modal ("Esta ação não pode ser desfeita"); `person_merge_audit` permite reconstrução manual via DBA se necessário |

---

## 8. Plano operacional (deploy)

### Variáveis novas no `/etc/vipcam/edge.env`
```
REID_ENABLED=true
REID_BASE_URL=http://127.0.0.1:5005
REID_DIST_STRICT=0.35
REID_DIST_LOOSE=0.55
SNAPSHOTS_DIR=/var/lib/vipcam/snapshots   # já existe; cita pra completeness
```

### Migrations
1. `face_records`: ADD model_name, model_revision (com defaults), det_score, NOT NULL no embedding.
2. CREATE TABLE `reid_match_attempts`.
3. CREATE TABLE `person_merge_audit`.

### Steps de deploy
1. `git push origin master` (após merge da branch).
2. VPS: `git pull` + `./deploy.sh`.
3. Migrations rodam (Drizzle migrate no startup do edge).
4. `systemctl restart vipcam-reid` (carrega `/embed` novo + ExecStartPost faz warm).
5. `systemctl restart vipcam-edge`.
6. Smoke:
   - `curl /api/health` → `checks.reid.ok=true` + model_name/revision.
   - Aguardar primeira detection real → `curl /api/events/recent?limit=1` → `snapshot_path` populado.
   - Abrir `/live` no browser → cards com rostos recortados.
7. Monitorar `journalctl -u vipcam-edge -f | grep reid` por ~10min — calibração empírica dos thresholds começa aqui.

### Rollback
- `REID_ENABLED=false` no edge.env + `systemctl restart vipcam-edge` → resolvePersonId volta a retornar null; snapshots continuam gravando (parte independente).
- Hard rollback: `git revert <merge-onda-7>` + `./deploy.sh`.

---

## 9. Onda 7 fechada quando

- `/live` mostra cards com rostos recortados em produção.
- Pessoa que volta após primeira visita é re-identificada automaticamente (validável via inspeção de `detections.person_id` de visitas subsequentes).
- `reid_match_attempts` ambiguous são revisáveis e resolvíveis pela UI `/matches`.
- `checks.reid` no `/api/health` reflete estado real do sidecar.
- Retention 30d roda e aparece em `checks.scheduler_snapshots`.
- Documento `docs/superpowers/specs/2026-05-20-onda-7-failover-b-report.md` registra: thresholds finais após calibração, taxa de strict match observada, taxa de borderline review por dia.
