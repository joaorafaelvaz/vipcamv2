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
- **Formato foto real**: `avatar_<usuario_id>.jpg?<4chars>` — query string é cache-buster que muda quando foto é atualizada. Length consistente 20 chars
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

### 3.2 `face_records.source` — novo enum value

Atual (Onda 7): `enum face_source { "live_detection", "manual_upload" }` ou similar (verificar no código real).

Adicionar: `"erp_seed"` — identifica records criados via foto do ERP. Permite observabilidade (`COUNT(*) WHERE source='erp_seed'`) e operações operacionais (re-seed massivo: `DELETE WHERE source='erp_seed'` + invalidar `last_embedded_image_token` triggera re-fetch no próximo sync).

### 3.3 Migration

`packages/edge/src/persistence/migrations/0009_*.sql` (auto-gen via `drizzle-kit generate`):

```sql
ALTER TABLE "persons" ADD COLUMN "last_embedded_image_token" text;
ALTER TYPE "face_source" ADD VALUE 'erp_seed';
```

(Confirm o enum: pode ser que face_source seja text livre — nesse caso só código muda, sem migration p/ enum.)

Forward-only deploy (sem replay retroativo da coluna — todas existing persons ficam com `NULL` e seedam no próximo sync hourly).

## 4. Componentes

### 4.1 Layout

| Arquivo | Tipo | Responsabilidade |
|---|---|---|
| `packages/edge/src/erp-sync/employees.ts` | modify | Após `personsRepo.create/update`, chama `seedEmployeeFace(person, imagem)`. Idempotente. |
| `packages/edge/src/erp-sync/employee-face-seeder.ts` | new | `seedEmployeeFace(person, imagem)` orquestra: skip-checks → fetch foto → reid `/embed` → persist face_record + token. Deps injetadas (fetcher, reid client, repos) p/ testabilidade. |
| `packages/edge/src/erp-sync/employee-face-seeder.ts` | new (mesmo file) | `isPlaceholder(imagem: string): boolean` predicate puro. Set `{"padrao.png", "padrao_masc.jpg", "padrao_fem.jpg"}`. |
| `packages/edge/src/api/reid/client.ts` | verify/extend | Onda 7 já tem cliente HTTP do sidecar; confirmar se há método `embed(jpegBuffer)` standalone (não-vinculado a detection) ou se precisa criar. |
| `packages/edge/src/persistence/schema/persons.ts` | modify | + `last_embedded_image_token` |
| `packages/edge/src/persistence/repositories/face-records.repo.ts` | verify | Confirmar `insertAndEvict` aceita `source` field; se não, adicionar |
| `packages/edge/src/config/env.ts` | modify | + `ERP_PHOTO_URL_PREFIX` (z.string().url(), validado boot-time) |

### 4.2 Boundaries

- `employees.ts` continua sendo o **orchestrator do sync** (loop ERP rows, decide create/update/skip). Sabe NADA sobre fetch HTTP ou reid — só chama `seedEmployeeFace`.
- `employee-face-seeder.ts` é uma **unidade isolada e pura-ish**. Cada decisão é uma função/branch testável. Não conhece o scheduler.
- `reid/client.ts` é o **único lugar** que sabe HTTP do sidecar. Se a API do sidecar mudar, só esse arquivo muda.

## 5. Data flow

### 5.1 Happy path

```
Hourly scheduler tick
  └─ syncEmployees()
       ├─ rows = fetchErpEmployees()
       └─ for each row (status=1):
            1. erpRepo.upsertEmployee(row)
            2. personsRepo.create OR update
            3. seedEmployeeFace(person, row.photo_url)        [NEW]
                 ├─ if isPlaceholder(imagem):           return {status:"placeholder"}
                 ├─ if person.last_embedded_image_token === imagem
                 │   AND faceRecordsRepo.countByPerson(person.id) > 0:
                 │                                       return {status:"unchanged"}
                 ├─ photoUrl = `${ERP_PHOTO_URL_PREFIX}${imagem}`
                 ├─ jpegBuf = await fetch(photoUrl, {timeout: 10s})
                 │    └─ on !ok / timeout:              log warn + return {status:"fetch_failed"}
                 ├─ embedResult = await reidClient.embed(jpegBuf)
                 │    └─ on 422 (no face):              log warn + return {status:"no_face"}
                 │    └─ on 5xx/timeout:                log error + return {status:"sidecar_error"}
                 ├─ faceRecordsRepo.insertAndEvict({
                 │    person_id, embedding: embedResult.embedding,
                 │    det_score: embedResult.det_score,
                 │    face_attrs: embedResult.face_attrs,
                 │    source: "erp_seed", is_primary: true,
                 │  })
                 ├─ personsRepo.update(person.id, {
                 │    last_embedded_image_token: imagem,
                 │    thumbnail_path: imagem,   // se ainda não setado
                 │  })
                 └─ return {status:"embedded"}
            4. log per-employee outcome (structured)
       └─ aggregate: log info {fetched, created, updated,
            embedded, skipped_placeholder, skipped_unchanged,
            fetch_failed, no_face, sidecar_error}
```

### 5.2 Edge cases (decididos)

| Caso | Comportamento | Justificativa |
|---|---|---|
| `imagem` em placeholder set | Skip silencioso (não conta como erro) | Não há foto real ainda; volta no próximo sync |
| `imagem` mudou (token diff) | Re-embed: insert novo face_record. `insertAndEvict` mantém FIFO cap de 5 (Onda 7) | Funcionário trocou foto no ERP → reid atualiza |
| Photo fetch 404 / timeout | Log warn + skip, NÃO interrompe sync | Foto pode estar temporariamente fora; tenta de novo em 1h |
| Sidecar `/embed` 422 (no face) | Log warn + skip; NÃO marca Person | Foto pode ser ruim ou cropping problemático — re-tenta sempre. Trade-off: gasta CPU sidecar repetindo. Se ficar caro, adicionar `Person.face_seed_failed_at` numa onda futura |
| Sidecar 5xx / timeout | Log error + skip esse employee, continua próximo | Sidecar pode estar degradado — sync agendado novamente em 1h |
| Sidecar down totalmente | Sync continua, NENHUM employee fica c/ face_record | Próximo sync recupera quando sidecar voltar |
| Person sumiu entre steps 2 e 3 (race c/ mergeInto) | `personsRepo.update` no-op (WHERE id matches); `insertAndEvict` defensivo verifica Person.exists() antes | Race extremamente raro mas defensável |
| `last_embedded_image_token === imagem` MAS face_records vazio | Re-embed (countByPerson > 0 check no skip) | Permite re-seed massivo via DELETE face_records |

### 5.3 Concorrência

Scheduler único (ver `packages/edge/src/erp-sync/scheduler.ts` da Onda 2), sem 2 syncs simultâneos. `insertAndEvict` é atômica (Drizzle transaction). Nada novo de lock necessário.

### 5.4 Throughput

371 employees × ~1-2s cada (fetch + embed serial) ≈ 6-12 min total na primeira rodada. Após estabilizar, só os que mudaram desde o último sync (esperado: 0-3 por hora). Otimização futura: paralelizar via `Promise.allSettled` em chunks de 5 — fácil de adicionar depois se ficar gargalo.

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

**`employee-face-seeder-integration.test.ts`** — 1 cenário end-to-end:
- Insert Person(employee) sem face_records
- Call seedEmployeeFace com URL de teste (httpbin.org/image/jpeg como JPEG fixture? OU mock server local?)
- Assert face_records cresceu por 1, source='erp_seed', Person.last_embedded_image_token setado

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

---

**Approvers:** awaiting spec-document-reviewer.
