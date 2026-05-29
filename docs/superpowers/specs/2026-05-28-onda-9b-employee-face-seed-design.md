# Onda 9-B — Employee Face Seed (ERP → reid)

**Status:** brainstorm aprovado, pendente spec-reviewer.
**Branch:** `onda-9b-employee-face-seed`
**Stack:** Bun + Hono + Drizzle + Postgres + pgvector + reid sidecar (Onda 7).

## 1. Objetivo

Quando employee aparece na câmera, reid reconhece automaticamente e linka à `Person(person_type=employee, erp_employee_id=<id>)` em vez de criar `Person(anonymous)` duplicada.

**Sintoma resolvido:** hoje `syncEmployees()` cria `Person(employee)` mas não popula `face_records` (comentário no código: *"Reconhecimento facial automático de funcionários só vem na Onda 3 (failover B com InsightFace local + pgvector ANN match)"*). Resultado: cada employee na câmera vira nova `Person(anonymous)` + face_record órfão. Pior, polui o pipeline match-temp (Onda 2): toda checkin ERP no horário do expediente vê detections "anonymous" de employees na janela → cria `match_attempts` ambíguos sem cliente real envolvido. Aba `/matches` Temporal fica empty na produção atual provavelmente por isso (auto-match silenciosamente rejected porque "muitas anonymous na janela").

**Mecanismo:** estender `syncEmployees()` pra após criar/atualizar `Person`, baixar a foto do ERP via URL pública, mandar pro sidecar reid `/embed`, e inserir o resultado em `face_records` linkado à Person. Cache-buster do ERP (`?p8yr` no `imagem`) usado como versão — se não mudou, skip.

**Sucesso (após calibração 7d):** % de detections com `person_id != null` sobe (recognition cobre employees); `match_attempts` decision='ambiguous' rate cai; queries operacionais (§5 obs) confirmam ≥90% dos employees com foto real têm `face_records.source='erp_seed'`.

## 2. Dados-base do ERP (probe 2026-05-28)

Tabela `usuarios` (não `funcionarios`), filtrada por `status = 1` (ativos):

- **371 usuários ativos** total (todas unidades da franquia — VPS local sincroniza tudo, cross-unit recognition é feature, não bug)
- **0 com `imagem` vazia ou `padrao.png`** — schema tem `imagem varchar(100) DEFAULT 'padrao.png'`
- **MAS placeholders adicionais existem**: `padrao_masc.jpg`, `padrao_fem.jpg` (visto em `Celso Marini`). Set completo: `{"padrao.png", "padrao_masc.jpg", "padrao_fem.jpg"}` — placeholders por sexo + legado
- **Formato foto real**: `avatar_<usuario_id>.jpg?<4chars>` — query string parece ser cache-buster. **Assumption empírica** (a re-validar em calibração 7d §9): se mesma `imagem` reaparece em syncs futuros sem mudar o suffix, employees nunca são re-seedados. Se observarmos suffix mudando sem foto realmente mudar, perdemos a otimização do skip — não é blocker (re-embed é safe). Length consistente 20 chars.
- **Distribuição por grupo** (todas comem na mesma query atual, não filtra por `grupos.colaborador=1`):

| grupo_id | grupo_nome | colaborador | n |
|---|---|---|---|
| 1 | Colaborador | 1 | 180 |
| 3 | Gerente unidade | 0 | 106 |
| 2 | Colaborador caixa | 0 | 64 |
| 4 | Gerente geral | 0 | 10 |
| 8 | Líder | 1 | 6 |
| 7 | Gerente | 0 | 3 |
| 10 | Vendas realizadas | 0 | 1 |
| 11 | API Integração | 0 | 1 |

Decisão: **mantém todos** (gerente/caixa também aparecem fisicamente na barbearia). Os 2 grupos pseudo-user (Vendas realizadas, API Integração) provavelmente nunca aparecem na câmera — terão tentativa fetch, vão dar 404, skip silencioso, sem dano.

**URL pública das fotos:** sugestão `https://www.franquiabv.com.br/img/usuarios/<imagem>`. Confirmar formato real no rollout — env var `ERP_PHOTO_URL_PREFIX` permite ajustar sem deploy de código.

## 3. Schema delta

### 3.1 `persons` — nova coluna

```typescript
last_embedded_image_token: text("last_embedded_image_token"),  // nullable
```

Guarda o valor literal de `usuarios.imagem` (ex: `"avatar_1966.jpg?p8yr"`) na última vez que essa Person foi seedada. No próximo sync, se `imagem` atual === `last_embedded_image_token`, skip (idempotência barata via string equality).

NULL = nunca tentou seedar (Person legada ou recém-criada).

### 3.2 `face_records.source` — coluna NOVA (não-existente hoje)

**Verificado:** `packages/edge/src/persistence/schema/face-records.ts` NÃO tem coluna `source` hoje. Tem `embedding`, `snapshot_path`, `is_primary`, `det_score`, `model_name`, `model_revision`, `created_at` — só isso (além de FKs).

```typescript
source: text("source").notNull().default("live_detection"),
```

Default `'live_detection'` backfilla automaticamente todas as ~N rows existentes (escrita 1x no `ALTER TABLE`). Mantém type-safety via union/string literal no insert site, sem precisar criar enum Postgres (simplifica migration e re-deploy).

Após Onda 9-B, callers passam `source` explicit: `'live_detection'` no `pipeline.ts` (livre detections) e `'erp_seed'` no seeder novo. Audit/observability: `SELECT source, count(*) FROM face_records GROUP BY source`.

**Re-seed operacional** (futuro): `UPDATE persons SET last_embedded_image_token = NULL WHERE id IN (...)` triggera re-fetch no próximo sync. Não-precisa deletar face_records — `insertAndEvict` faz FIFO (cap 5).

### 3.3 `snapshot_path` é NOT NULL — como o seeder satisfaz

**Verificado:** `face_records.snapshot_path: text("snapshot_path").notNull()` (linha 37). Seeder precisa fornecer um path real, não pode ser NULL.

**Solução:** o sidecar `/embed` retorna `crop_jpeg_b64` no response (linha 148 de `packages/reid/src/main.py` — o crop usado pra detecção, JPEG quality 85). Seeder decodifica esse base64 e salva como arquivo em:

```
${SNAPSHOTS_DIR}/employee_seed/${erp_employee_id}_${token}.jpg
```

Onde `token` é o cache-buster do ERP (ex: `p8yr`). Path completo persistido em `face_records.snapshot_path`. Re-seed (foto mudou) cria arquivo novo com novo token + insertAndEvict elimina o face_record antigo via FIFO (snapshot antigo fica órfão no disco, pruning em onda futura ou ignorar — disk usage é trivial pra 371 employees).

**Why not reuse ERP photo bytes diretamente:** o sidecar pode retornar crop diferente do input (se o frame_fallback escolheu sub-região); guarda o que reid efetivamente usou pra observability. Tamanho: ~30-100 KB cada.

### 3.4 Migration 0009

**Verificado:** próxima migration é `0009` (`0008_bizarre_randall.sql` é o último — Onda 9-A).

`packages/edge/src/persistence/migrations/0009_<adj>_<noun>.sql` (auto-gen via `drizzle-kit generate` — drizzle-kit anexa um sufixo aleatório do dicionário interno, tipo `0008_bizarre_randall.sql` da Onda 9-A; nome literal só é conhecido após o comando rodar):

```sql
ALTER TABLE "persons" ADD COLUMN "last_embedded_image_token" text;
ALTER TABLE "face_records" ADD COLUMN "source" text DEFAULT 'live_detection' NOT NULL;
```

(Drizzle pode gerar 2 ALTERs separados — OK; ordem não-importa.)

Forward-only deploy:
- `persons.last_embedded_image_token` — todas existing persons ficam com NULL e seedam no próximo sync hourly
- `face_records.source` — todos existing records ganham default `'live_detection'` no ALTER (1 escrita batch durante migration; aceitável pra tabela com cap 5×N_persons)

## 4. Componentes

### 4.1 Layout

**Verificado:** o reid client real fica em `packages/edge/src/discovery/image-probe/reid-client.ts` (export `embed(reidBaseUrl, frameBytes, bbox, timeoutMs)`). Path é histórico (Onda 1 Discovery probe foi o primeiro caller). Reusamos ele direto — mover/renomear é trabalho não-relacionado.

| Arquivo | Tipo | Responsabilidade |
|---|---|---|
| `packages/edge/src/erp-sync/employees.ts` | modify | Após `personsRepo.create/update`, chama `seedEmployeeFace(person, photoUrl)`. Falhas do seeder NÃO interrompem o loop (try/catch per-employee, log + continue). |
| `packages/edge/src/erp-sync/employee-face-seeder.ts` | new | `seedEmployeeFace(person, photoUrl: string): Promise<SeedResult>` orquestra: skip-checks → fetch foto → reid `embed` com **oversize bbox** (vide §5) → decode crop → save snapshot → persist face_record + update Person.last_embedded_image_token. Deps injetadas (fetcher, reidClient, repos, fs) p/ testabilidade. Retorna union type discriminado. **Note:** parâmetro `photoUrl` recebe o valor literal de `usuarios.imagem` aliasado como `photo_url` pela query do `ERP_QUERY_EMPLOYEES` (vide `ErpEmployeeRow` em `erp-sync/queries.ts`). Não é uma URL completa — é o token (ex: `avatar_1966.jpg?p8yr`) que o seeder concatena com `ERP_PHOTO_URL_PREFIX` antes do fetch. Nome do param reflete o shape consumido (`row.photo_url`) e não o nome da coluna MySQL. |
| `packages/edge/src/erp-sync/employee-face-seeder.ts` | (mesmo file) | `isPlaceholder(photoUrl: string): boolean` predicate puro. Set `{"padrao.png", "padrao_masc.jpg", "padrao_fem.jpg"}`. |
| `packages/edge/src/discovery/image-probe/reid-client.ts` | reuse as-is | Função `embed(...)` existente serve — chamada do seeder passa bbox oversize p/ triggerar frame_fallback no sidecar (vide §5). Nenhuma mudança aqui. |
| `packages/edge/src/persistence/schema/persons.ts` | modify | + `last_embedded_image_token` (col text nullable) |
| `packages/edge/src/persistence/schema/face-records.ts` | modify | + `source` (col text NOT NULL default `'live_detection'`) |
| `packages/edge/src/persistence/repositories/face-records.repo.ts` | modify | Atualizar tipo `NewFaceRecord` (já vem inferido do schema); confirmar `insertAndEvict` propaga `source`. Adicionar `countByPerson(person_id): Promise<number>` se ainda não existir (necessário pro skip-override do §5). |
| `packages/edge/src/ingest/pipeline.ts` | modify | Passar `source: 'live_detection'` explicit no `insertAndEvict` call (Onda 7 default — antes do default no schema, agora redundante mas explícito ajuda leitor) |
| `packages/edge/src/config/env.ts` | modify | + `ERP_PHOTO_URL_PREFIX` (z.string().url(), validado boot-time). Default: `https://www.franquiabv.com.br/img/usuarios/` (override por env file) |
| `packages/edge/src/config/env.ts` | modify | `SNAPSHOTS_DIR` já existe (verificar); seeder usa `${SNAPSHOTS_DIR}/employee_seed/` sub-pasta (mkdir -p on demand) |

### 4.2 Boundaries

- `employees.ts` continua sendo o **orchestrator do sync** (loop ERP rows, decide create/update/skip). Sabe NADA sobre fetch HTTP ou reid — só chama `seedEmployeeFace` e cataloga o `SeedResult` retornado.
- `employee-face-seeder.ts` é uma **unidade isolada e testável**. Cada decisão é uma função/branch coberta por unit test mock-based. Não conhece o scheduler.
- `reid-client.ts` é o **único lugar** que sabe HTTP do sidecar.
- `face-records.repo.ts` é o **único lugar** que sabe persistência de embeddings (incluindo FIFO via `insertAndEvict` + nova source col).

### 4.3 `SeedResult` union type (define test matrix + log shape)

```typescript
export type SeedResult =
  | { status: "placeholder" }            // imagem em placeholder set
  | { status: "unchanged" }              // token igual + face_records.count > 0
  | { status: "embedded"; face_record_id: string }
  | { status: "fetch_failed"; reason: "http_4xx" | "http_5xx" | "timeout" | "dns" | "network"; detail?: string }
  | { status: "no_face" }                // sidecar 422
  | { status: "sidecar_error"; reason: "timeout" | "5xx" | "network"; detail?: string };
```

Vantagens: (1) test matrix explícita (6 testes 1:1 com as variantes); (2) aggregator log no `syncEmployees` é exhaustive switch sem `default`; (3) UI/observabilidade futura tem dados estruturados.

## 5. Data flow

### 5.1 Chamada `/embed` com bbox oversize (decisão de design)

O sidecar `/embed` (verificado em `packages/reid/src/main.py:113-159`) requer `multipart {file, x, y, w, h}` com `w>0, h>0`. O caminho do `frame_fallback` existe explicitamente: linha 137 — `if x + w <= fw and y + h <= fh: ... try bbox crop` — **se a bbox NÃO cabe no frame**, cai pra `_embed_pil(img)` no frame inteiro (linha 154).

**Estratégia:** seeder chama `embed(reidBaseUrl, jpegBuf, {x: 0, y: 0, w: 99999, h: 99999}, timeoutMs: 5_000)`. Guard `w>0` passa (positivo). Guard `x+w <= fw` falha (99999 sempre > qualquer fw). Falls through → `_embed_pil(img)` no frame inteiro. Response indica `source: 'frame_fallback'` (no campo do EmbedResponse, distinto do nosso `face_records.source`).

**Tradeoffs aceitos:**
- Documentar EXPLICITAMENTE no docstring do seeder (`// HACK: bbox oversize p/ triggerar frame_fallback path; sidecar v2+ pode endurecer guard → re-validar`)
- Adicionar comment no `packages/reid/src/main.py` linha 137 marcando "este path é load-bearing para employee-face-seed (Onda 9-B)"
- Se sidecar futuro adicionar guard `x+w <= fw OR raise 400`, seeder quebra silenciosamente → mitigação via integration test (vide §6) que valida o comportamento end-to-end

**Latência:** frame_fallback é ~150ms (vs ~30ms bbox path) por Onda 7 §3.5. 371 employees × 150ms ≈ 55s só de embed. Aceitável.

### 5.2 Happy path

```
Hourly scheduler tick
  └─ syncEmployees()
       ├─ rows = fetchErpEmployees()
       └─ for each row (status=1):
            try {
              1. erpRepo.upsertEmployee(row)
              2. person = personsRepo.create OR update
              3. result = await seedEmployeeFace(person, row.photo_url)        [NEW]
                   ├─ if isPlaceholder(photoUrl):           return {status:"placeholder"}
                   ├─ existingCount = await faceRecordsRepo.countByPerson(person.id)
                   ├─ if person.last_embedded_image_token === photoUrl
                   │   AND existingCount > 0:             return {status:"unchanged"}
                   ├─ absoluteUrl = `${ERP_PHOTO_URL_PREFIX}${photoUrl}`
                   ├─ try {
                   │    response = await fetch(absoluteUrl, {signal: AbortSignal.timeout(10_000)})
                   │  } catch (err):
                   │    classify err → {timeout|dns|network} → log warn + return {status:"fetch_failed", reason}
                   ├─ if !response.ok:
                   │    classify status → {http_4xx|http_5xx} → log warn + return {status:"fetch_failed", reason}
                   ├─ jpegBuf = Buffer.from(await response.arrayBuffer())
                   ├─ try {
                   │    embedResult = await reidClient.embed(REID_URL, jpegBuf, {x:0,y:0,w:99999,h:99999}, 5_000)
                   │  } catch (ReidError err):
                   │    if err.status === 422:           return {status:"no_face"}
                   │    classify → {timeout|5xx|network} → log error + return {status:"sidecar_error", reason}
                   ├─ // snapshot persistence — decode crop_jpeg_b64 + save
                   │  // token = parte do photoUrl que serve de version (ex: "avatar_1966.jpg?p8yr"
                   │  // → sanitize p/ filesystem-safe: "avatar_1966.jpg_p8yr" via replace `?` → `_`)
                   │  snapshotPath = `employee_seed/${person.erp_employee_id}_${sanitizeToken(photoUrl)}.jpg`
                   │  absPath = path.join(SNAPSHOTS_DIR, snapshotPath)
                   │  await mkdir(dirname(absPath), {recursive: true})
                   │  await writeFile(absPath, Buffer.from(embedResult.crop_jpeg_b64, "base64"))
                   ├─ try {
                   │    fr = await faceRecordsRepo.insertAndEvict({
                   │      person_id: person.id,
                   │      embedding: embedResult.embedding,
                   │      det_score: embedResult.det_score,
                   │      snapshot_path: snapshotPath,       // path relativo a SNAPSHOTS_DIR
                   │      is_primary: existingCount === 0,   // primeiro embed → primary
                   │      source: "erp_seed",
                   │      model_name: embedResult.model_name,
                   │      model_revision: embedResult.model_revision,
                   │    })
                   │  } catch (PostgresFKError):              // Person sumiu entre create + insertAndEvict
                   │    log warn + return {status:"sidecar_error", reason:"network", detail:"person_fk_violation"}
                   ├─ await personsRepo.update(person.id, {
                   │    last_embedded_image_token: photoUrl,
                   │    thumbnail_path: snapshotPath,    // verificado: persons.thumbnail_path é text nullable
                   │  })
                   └─ return {status:"embedded", face_record_id: fr.id}
              4. log per-employee outcome (structured): {erp_employee_id, person_id, ...result, duration_ms}
            } catch (unexpected err) {
              log error {erp_employee_id, err}, "seedEmployeeFace unexpected error"
              // continue p/ próximo employee
            }
       └─ aggregate: log info {fetched, created, updated, embedded,
            skipped_placeholder, skipped_unchanged, fetch_failed, no_face, sidecar_error}
```

### 5.3 Edge cases (decididos)

| Caso | Comportamento | Justificativa |
|---|---|---|
| `imagem` em placeholder set | Skip silencioso (não conta como erro) | Não há foto real ainda; volta no próximo sync |
| `imagem` mudou (token diff) | Re-embed: insert novo face_record. `insertAndEvict` mantém FIFO cap 5 (Onda 7) | Funcionário trocou foto no ERP → reid atualiza |
| Photo fetch 404 / timeout / DNS | Log warn + skip, NÃO interrompe sync. Reason classificado no log | Foto pode estar temporariamente fora; tenta de novo em 1h |
| Sidecar `/embed` 422 (no face) | Log warn + skip; NÃO marca Person como permanently-failed | Foto pode ser ruim ou cropping problemático — re-tenta sempre. Trade-off: gasta CPU sidecar repetindo. Se ficar caro (>5% taxa), adicionar `Person.face_seed_failed_at` numa onda futura |
| Sidecar 5xx / timeout / network | Log error + skip esse employee, continua próximo | Sidecar pode estar degradado — sync agendado em 1h |
| Sidecar down totalmente | Sync continua, NENHUM employee fica c/ face_record | Próximo sync recupera quando sidecar voltar |
| Person sumiu entre steps 2 e 3 (race c/ `mergeInto`) | `faceRecordsRepo.insertAndEvict` falha com FK violation; seeder catch + retorna `sidecar_error` | Race extremamente raro (`mergeInto` é manual-triggered da UI). Não vale defensive `Person.exists()` round-trip pra todo employee |
| `last_embedded_image_token === imagem` MAS face_records vazio (alguém deletou records manualmente) | Re-embed (countByPerson check override) | Permite re-seed massivo via `DELETE FROM face_records WHERE source='erp_seed' AND person_id IN (...)` |
| `crop_jpeg_b64` ausente no response (sidecar v0 sem o campo) | Falha defensiva — assert presença antes do writeFile, return `sidecar_error` | EmbedResponse atual (Onda 7) sempre inclui crop_jpeg_b64; defensive p/ futuro |

### 5.4 Concorrência

Scheduler único (ver `packages/edge/src/erp-sync/scheduler.ts` da Onda 2), sem 2 syncs simultâneos. `insertAndEvict` é atômica (Drizzle transaction). Nada novo de lock necessário.

**Sync overrun:** scheduler atual roda employees + clients + checkins sequencialmente no mesmo loop hourly. 6-12 min do seeder na primeira rodada NÃO interfere com clientes (15 min cadence) nem checkins (30s — esses são separate cron jobs já). Verificar no plan se há lock compartilhado que segura outros syncs (não-esperado, mas vale 1 leitura do scheduler.ts).

### 5.5 Throughput

371 employees × ~250ms (fetch ~80ms + frame_fallback embed ~150ms + persist ~20ms) ≈ 1.5 min na primeira rodada (otimista). Pior caso (sidecar cold, fetch lento): ~10 min. Após estabilizar, só os que mudaram desde o último sync (esperado: 0-3 por hora). Otimização futura: paralelizar via `Promise.allSettled` em chunks de 5 — fácil de adicionar depois se ficar gargalo.

## 6. Testing

### 6.1 Unit (offline, mock-based)

**`employee-face-seeder.test.ts`** — 6 cenários:
1. `isPlaceholder("padrao.png" | "padrao_masc.jpg" | "padrao_fem.jpg")` → true; `avatar_1966.jpg?p8yr` → false
2. `seedEmployeeFace` com placeholder → `{status: "placeholder"}`, ZERO chamadas a fetch/reid/repos
3. `seedEmployeeFace` com token unchanged + faceRecords.count > 0 → `{status: "unchanged"}`, ZERO chamadas
4. Happy path → fetch + embed + insertAndEvict + update Person.last_embedded_image_token called once each
5. Fetch retorna 404 → `{status: "fetch_failed"}`, ZERO embed/persist calls, log warn
6. Reid retorna 422 → `{status: "no_face"}`, ZERO persist calls, log warn

**`employee-face-seeder.test.ts`** — regression:
7. token unchanged MAS face_records.count = 0 → re-embed acontece (override do skip)

**`employees.test.ts`** (extension): confirma que `syncEmployees` ainda faz upsertEmployee + personsRepo.create igual antes, agora + 1 chamada ao seeder por row, e que falhas do seeder NÃO interrompem o loop pros próximos employees.

### 6.2 Schema unit (offline)

**`schema-persons-last-embedded.test.ts`** — 2 testes: coluna `last_embedded_image_token` definida + nullable (TS introspection do Drizzle, igual Onda 9-A Task 1).

### 6.3 Integration (DB-deferred — VPS post-deploy)

**`employee-face-seeder-integration.test.ts`** — 2 cenários end-to-end:

1. **Happy path com fixture local:**
   - Setup: pasta `packages/edge/tests/fixtures/employee-photos/` com 1 JPEG real de face (foto stock CC0 ou geração via InsightFace test images)
   - Bun servidor HTTP local em random port servindo o fixture (em vez de httpbin.org — evita dep da internet em CI)
   - Override `ERP_PHOTO_URL_PREFIX` no test setup pra apontar pro local server
   - Insert Person(employee) sem face_records
   - Call `seedEmployeeFace(person, "test_face.jpg")`
   - Assert: face_records cresceu por 1, source='erp_seed', snapshot_path existe no disco, Person.last_embedded_image_token === "test_face.jpg"
   - Cleanup: remove snapshot file + face_record + person

2. **Frame_fallback dependency contract validation:**
   - **Crítico** — garante que sidecar continua aceitando bbox oversize e cai no fallback
   - Mesma estrutura do teste 1, mas asserta também `embedResult.source === 'frame_fallback'` quando o campo está presente (`EmbedResult.source` é opcional em `packages/shared/src/types/reid.ts`; defensive check: `if (embedResult.source !== undefined) expect(embedResult.source).toBe('frame_fallback')`). Mesmo sem o campo, sucesso do embed com bbox `(0,0,99999,99999)` já é evidência forte
   - Se este teste falhar, é signal explícito de que o sidecar v2+ endureceu o guard — flag pra reabrir Onda 9-B com option B (`/embed_image`, vide §10 item #9)

(Requer vipcam_test DB do chip da Onda 9-A débito — se ainda não provisionado, fica marcado DB-deferred até lá.)

### 6.4 Manual smoke (pós-deploy)

```sql
-- 1h após restart, esperar growth:
SELECT COUNT(*) FROM face_records WHERE source = 'erp_seed';
-- esperado: 180-300 (proporção de imagens reais vs placeholders dos 371)

-- Coverage por employee:
SELECT
  COUNT(*) AS employees_total,
  COUNT(p.id) FILTER (WHERE fr.id IS NOT NULL) AS with_face,
  COUNT(*) FILTER (WHERE p.last_embedded_image_token IS NULL) AS never_attempted
FROM persons p
LEFT JOIN face_records fr ON fr.person_id = p.id AND fr.source = 'erp_seed'
WHERE p.person_type = 'employee';

-- Spot-check: 1 employee conhecido na câmera deve gerar detection com person_id setado
SELECT d.id, d.person_id, p.display_name, d.detected_at
FROM detections d JOIN persons p ON p.id = d.person_id
WHERE p.person_type = 'employee'
ORDER BY d.detected_at DESC LIMIT 5;
```

## 7. Observability

1. **Logger estruturado per-employee** (level=info p/ embed/skip, level=warn p/ fetch_failed/no_face, level=error p/ sidecar_error): `{erp_employee_id, person_id, outcome, [reason], duration_ms}`. Filtrar `journalctl -u vipcam-edge | jq 'select(.outcome != null)'`.

2. **Sync result agregado**: log final do sync ganha campos novos: `{fetched, created, updated, embedded, skipped_placeholder, skipped_unchanged, fetch_failed, no_face, sidecar_error}`. Substitui o log atual de `employees.ts`.

3. **Operational queries** (§6.4 acima) — operador roda manualmente quando quiser visibilidade.

4. **Nada de Prometheus/Grafana** nesta onda — VPS não tem stack de métricas formal. Adicionar Prom é sub-projeto separado.

## 8. Rollout

1. **PR + merge to master + push origin** (mesmo fluxo Onda 9-A — finishing-a-development-branch skill)
2. **Deploy VPS**: `git pull && ./deploy.sh && sudo systemctl restart vipcam-edge`
3. **Migration 0009** aplica via `ExecStartPost` do unit (mesmo pattern Onda 9-A)
4. **Smoke health endpoint** (4 checks verdes igual hoje) + spot-check `\d persons` na coluna nova
5. **Aguardar 1h** para o primeiro sync hourly rodar
6. **Verify queries §6.4** — esperado ~180-300 face_records `source='erp_seed'`
7. **Verify smoke real**: 1 employee de presença frequente aparecer na câmera → detection com `person_id = <employee_id>`

### Rollback

- Revert + restart edge.
- Coluna `last_embedded_image_token` fica órfã (sem uso) mas não quebra nada — pode ser dropada numa migration manual depois se for problema cosmético.
- `face_records` `source='erp_seed'` ficam — quando reid os usar, recognition continua funcionando. **Isso é desejável**: rollback do código não desperdiça o trabalho de embedding já feito. Reid continua reconhecendo employees mesmo com código rollback'd (pgvector ANN funciona via embedding, não importa o source).

### Risco

- **Baixo.** Toda lógica nova é additive. Se seeder falhar 100% (fetch sempre 404, sidecar sempre 5xx, etc), sistema funciona idêntico ao hoje — employees seguem virando anonymous Person. Pior caso = "Onda 9-B não fez efeito"; nunca "Onda 9-B quebrou produção".

## 9. Calibração pós-deploy (7 dias)

Monitorar semanalmente:
- `face_records WHERE source='erp_seed'` growth (esperado estabilizar ~200-300; novos embeddings apenas quando ERP photo muda)
- `match_attempts` decision='ambiguous' rate (esperado cair vs baseline — employees deixam de poluir janelas)
- `% detections com person_id != null` (esperado subir — recognition cobre employees)
- Taxa de `no_face` do `/embed` (se > 5%, foto qualidade ruim no ERP — investigar)

Onda 9-B fechada após 7 dias estáveis + reporte em `2026-XX-XX-onda-9b-report.md`.

## 10. Out-of-scope (=> ondas futuras)

| # | Item | Comentário |
|---|---|---|
| 1 | **Dedup**: Persons anonymous que JÁ existem e na real são employees | Onda 9-C: workflow no `/people` pra operador escolher "mesclar essa anonymous em <employee_X>" via `personsRepo.mergeInto`. Reusa toda infra Onda 7. |
| 2 | **Manual upload UI** pra employees sem foto ERP | Hoje 0 employees nesse estado (371/371 com `imagem` setado), mas pode aparecer com novos cadastros. Fallback futuro. |
| 3 | **Filtro por unidade** no `ERP_QUERY_EMPLOYEES` | Mantém cross-unit recognition (feature da rede de barbearias) |
| 4 | **Paralelismo no sync** (`Promise.allSettled` chunks de 5) | Não-necessário até comprovar gargalo (serial é ~12min na pior carga; só na primeira rodada) |
| 5 | **Métricas Prometheus** | Stack de métricas não existe — sub-projeto separado |
| 6 | **`Person.face_seed_failed_at` flag** para no-face permanente | YAGNI. Adicionar só se taxa no_face > 5% e re-fetch ficar caro |
| 7 | **`grupos.colaborador=1` filter** no sync | Não-necessário; gerentes/caixas também aparecem fisicamente |
| 8 | **Pruning de snapshots órfãos em `employee_seed/`** | Quando foto muda, snapshot antigo fica no disco (face_record evicted via FIFO mas arquivo permanece). 371 employees × 5 cap × ~50KB = ~90 MB worst-case. Aceitável; pruning numa onda futura junto com pruneOlderThan per-entry try/catch (Onda 7 §12 #4) |
| 9 | **Switch pra `/embed_image` no sidecar (opção B do brainstorm)** | Se o frame_fallback hack quebrar em sidecar v2+, fechado em onda separada (~20 linhas Python + 1 método novo no reid-client). Test do §6.3 cenário 2 sinaliza o gatilho |

---

**Approvers:** awaiting spec-document-reviewer.
