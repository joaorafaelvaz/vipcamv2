# Onda 9-A — Reid vs ERP Divergent Resolution — Design

**Status:** Aprovado (saiu de brainstorming, pendente plano de implementação)
**Autor(es):** Rafael Vaz + Claude
**Data:** 2026-05-26
**Predecessor:** Onda 7 spec §5.1 (deixou rows 3-5 deferidas pra esta onda); Onda 7 §12 listou esta como débito #1.

---

## 1. Objetivo

Implementar a tabela de decisão completa do conflito reid vs match temporal (§5.1 da Onda 7), cobrindo os 3 casos que ficaram em aberto: detection já identificada por reid no momento que o match temporal chega via novo checkin ERP.

Hoje em produção, se o reid auto-matched uma detection ao person W (correto ou errado) **antes** do checkin chegar, o match temporal ignora a detection silenciosamente (porque `findAnonymousInWindow` só retorna `person_id IS NULL`). Resultado: nunca surge um ambiguous pra humano verificar — erros do reid ficam silenciosos.

### Não-objetivos
- Replay retroativo (forward-only — detections antigas não-recebem nova auditoria).
- Mudar comportamento do reid em si (orchestrator continua igual; só a fase ERP que muda).
- Mexer na aba "Reid borderline" (essa fica intocada — só a aba Temporal é estendida).
- Backfill de `previous_person_id` em match_attempts antigos (campo fica NULL pra rows pre-Onda-9-A).

### Sucesso
- Quando reid e ERP convergem (mesmo cliente Y), nenhum match_attempt é criado (NO-OP).
- Quando reid e ERP divergem, surge ambiguous na aba Temporal com info clara: "esta detection já está ligada a W, ERP sugere Y; é a mesma pessoa?".
- Humano resolve "merge" → `personsRepo.mergeInto(W, Y)` (reusa helper Onda 7); "reject" → mantém W.
- Calibração: contagem de divergentes nas primeiras 2 semanas vira input pra tuning de `REID_DIST_STRICT` (se alto demais, reid está auto-matchando erradamente).

---

## 2. Tabela de decisão (de Onda 7 §5.1, agora 100% implementada)

| `detection.person_id` | Sugestão ERP | Ação | Implementação |
|---|---|---|---|
| `NULL` | 1 cliente | auto-match | ✅ Onda 2 — mantém |
| `NULL` | 2+ clientes | ambiguous (clássico) | ✅ Onda 2 — mantém |
| `= cliente do ERP` (Y) | mesmo Y | **NO-OP** | ⏳ Onda 9-A — `continue` no loop |
| `= cliente X anônimo` | cliente Y | **AMBIGUOUS divergente** | ⏳ Onda 9-A — match_attempt com `previous_person_id=X` |
| `= cliente W já-client` | cliente Y | **AMBIGUOUS divergente** | ⏳ Onda 9-A — match_attempt com `previous_person_id=W` |

---

## 3. Schema delta

Uma migration (`0008_*.sql`):

```sql
ALTER TABLE match_attempts
  ADD COLUMN previous_person_id uuid NULL
    REFERENCES persons(id) ON DELETE SET NULL,
  -- Snapshot denormalizado de W no momento do insert. Sobrevive a um
  -- mergeInto futuro de W (que apaga a row de persons e via SET NULL
  -- limparia previous_person_id, perdendo o "quem era W"). JSONB porque
  -- person tem campos heterogêneos e schema dela pode evoluir.
  ADD COLUMN previous_person_snapshot jsonb NULL;
```

**Por que `SET NULL` e não `CASCADE` no FK:** se W for deletado depois (merged em outra pessoa ou opted-out), o registro do match_attempt ainda é audit-relevante. `CASCADE` apagaria o histórico inteiro do ambiguous.

**Por que `previous_person_snapshot` em paralelo ao FK:** o FK preserva a referência live enquanto W existe (queries de UI podem buscar nome/foto atual via JOIN); o snapshot preserva o estado de W no momento da divergência mesmo se W for deletada depois. Espelha o pattern de `person_merge_audit.src_snapshot` (Onda 7 §5.2).

Drizzle schema em `packages/edge/src/persistence/schema/match-attempts.ts`:

```typescript
previous_person_id: uuid("previous_person_id")
  .references(() => persons.id, { onDelete: "set null" }),
previous_person_snapshot: jsonb("previous_person_snapshot")
  .$type<Record<string, unknown>>(),
```

`MatchAttempt` $inferSelect ganha ambos os campos nullable.

---

## 4. Backend — pipeline ERP

### 4.1 Nova query

`packages/edge/src/persistence/repositories/detections.repo.ts` ganha:

```typescript
async findInWindow(start: Date, end: Date): Promise<Array<{
  id: string;
  detected_at: Date;
  person_id: string | null;
  snapshot_path: string | null;
}>>
```

Sem filtro de `person_id IS NULL` (contraste com `findAnonymousInWindow`). **Sem cameraId** (mantém paridade com `findAnonymousInWindow` que também não filtra). `findAnonymousInWindow` é deletado se nenhum outro caller existir após o refactor (verificar com `grep`); caso contrário, fica marcado deprecated.

### 4.2 processCheckin refactor

`packages/edge/src/match-temp/orchestrator.ts`. **Decisão importante:** preservamos o pattern existente de **1 match_attempt por checkin no caminho clássico** (Onda 2 — `decideMatch` agrega anonymous count) e adicionamos um **segundo passe** sobre os non-NULL pra o branch divergente. Isso mantém zero-regressão pro classic flow + isola a lógica nova.

Pseudo-código (verificar nome real do helper `decideMatch` em orchestrator.ts e o tipo retornado antes de implementar):

```typescript
async function processCheckin(checkin: ErpCheckin) {
  const start = subSeconds(checkin.occurred_at, MATCH_WINDOW_SECONDS);
  const end   = addSeconds(checkin.occurred_at, MATCH_WINDOW_SECONDS);

  const allInWindow = await detectionsRepo.findInWindow(start, end);
  const candidatePerson = await personsRepo.findByErpClientId(checkin.erp_client_id);
  //                                                          ^^^^^^^^^^^^^^^^^^^^
  // NOTA: campo é `erp_client_id` no schema, não `client_id` (confirmado em
  // erp-cache.ts). Variável intermediária do checkin pode chamar-se `client_id`
  // dependendo da deserialização — usar o campo do tipo ErpCheckin canônico.

  if (!candidatePerson) {
    logger.warn(
      { erp_client_id: checkin.erp_client_id, checkin_id: checkin.erp_id },
      "ERP client not in persons cache — checkin skipped; will retry on next sync",
    );
    return;
  }

  // ----- Passe 1: caminho clássico (mantém Onda 2 — 1 match_attempt agregado)
  const anonymous = allInWindow.filter((c) => c.person_id === null);
  // Reusa decideMatch existente (sem mudanças):
  // decideMatch(anonymous) → { decision: 'auto_matched'|'ambiguous'|'rejected',
  //                            chosen_detection_id?: string }
  const classic = decideMatch(anonymous);
  if (classic.decision === "auto_matched" && classic.chosen_detection_id) {
    await matchAttemptsRepo.create({
      detection_id: classic.chosen_detection_id,
      erp_checkin_id: checkin.erp_id,
      decision: "auto_matched",
    });
    await detectionsRepo.assignPerson(classic.chosen_detection_id, candidatePerson.id);
  } else if (classic.decision === "ambiguous") {
    await matchAttemptsRepo.create({
      detection_id: null,            // ambiguous clássico não fixa detection
      erp_checkin_id: checkin.erp_id,
      decision: "ambiguous",
      // previous_person_id permanece NULL — signal de "caso clássico"
    });
  }
  // rejected (0 anonymous): no-op clássico

  // ----- Passe 2: divergent detection check (Onda 9-A novo)
  const identified = allInWindow.filter((c) => c.person_id !== null);
  for (const det of identified) {
    if (det.person_id === candidatePerson.id) {
      // Row 3: NO-OP — reid e ERP concordam, nada a registrar
      continue;
    }
    // Rows 4-5: ambiguous divergente
    const prevPerson = await personsRepo.findById(det.person_id);  // pra snapshot
    await matchAttemptsRepo.create({
      detection_id: det.id,
      erp_checkin_id: checkin.erp_id,
      decision: "ambiguous",
      previous_person_id: det.person_id,
      previous_person_snapshot: prevPerson,  // jsonb com row inteira
    });
  }
}
```

**Decision enum sem alteração** — `ambiguous` cobre os dois sub-casos; o discriminador é `previous_person_id != null`.

**Verificar antes de implementar:** o atual `processCheckin` provavelmente seta `checkin.processed_at = now()` no final. Mantemos esse update mesmo no skip do `candidatePerson` ausente? Decisão: sim, sempre marcar processed — senão re-rodaria a cada poll sem nunca convergir. O warning log + return é o registro de que esse checkin foi visto.

### 4.3 resolveAmbiguous bifurcation

**Modificação in-place** de `packages/edge/src/match-temp/review.ts` — não cria wrapper novo, estende o `resolveAmbiguous` existente (linha 55) adicionando branch de divergência no topo.

**Signature atual mantida** (3 args, sem userId — `decided_by:'user'` continua hardcoded; adicionar userId real é Onda 9-C/NextAuth, não escopo desta):
```typescript
export async function resolveAmbiguous(
  matchAttemptId: string,
  chosenDetectionId: string,
  chosenPersonId: string,
): Promise<void>
```

**Extensão do `ResolveErrorCode` enum existente** (linha 21 do review.ts):
```typescript
export type ResolveErrorCode =
  | "not_found"
  | "already_resolved"
  | "detection_outside_window"
  | "person_client_mismatch"
  | "checkin_not_found"
  // Onda 9-A:
  | "concurrent_merge"          // → HTTP 409 (outro operador resolveu)
  | "previous_person_gone";     // → HTTP 410 (W já foi deletada antes do resolve)
```

(Note: `checkin_gone` do round anterior vira redundante — já existe `checkin_not_found`. `candidate_person_gone` vira redundante — `person_client_mismatch` cobre o caso de candidate inexistente nessa janela.)

**Pseudo-código do branch novo** (antes da lógica existente):

```typescript
export async function resolveAmbiguous(
  matchAttemptId: string,
  chosenDetectionId: string,
  chosenPersonId: string,
): Promise<void> {
  const db = getDb();
  const [attempt] = await db.select().from(matchAttempts)
    .where(eq(matchAttempts.id, matchAttemptId)).limit(1);
  if (!attempt) throw new ResolveError("not_found", `match_attempt ${matchAttemptId} not found`);
  if (attempt.decision !== "ambiguous") {
    throw new ResolveError("already_resolved", `... decision=${attempt.decision}`);
  }

  // Onda 9-A: branch divergente — previous_person_id setado pelo orchestrator
  // sinaliza que detection já tinha person_id (W) no momento do match.
  if (attempt.previous_person_id) {
    return resolveDivergent(attempt, chosenPersonId);
  }

  // Caso clássico (mantém código existente a partir daqui — checkin lookup,
  // validações detection_outside_window e person_client_mismatch, INSERT
  // detection.person_id, etc.)
  // ... resto do código atual de resolveAmbiguous ...
}

// Helper interno NOVO (mesma module review.ts):
async function resolveDivergent(
  attempt: MatchAttempt,           // garantido attempt.previous_person_id != null
  chosenPersonId: string,          // o candidate (Y) selecionado pela UI
): Promise<void> {
  // Defensive: stale state onde W já foi merged em Y por outro path.
  if (attempt.previous_person_id === chosenPersonId) {
    // No-op: o que UI pediu já está feito. Marca como resolved sem mergeInto.
    return matchAttemptsRepo.resolveAmbiguous(
      attempt.id,
      attempt.detection_id!,
      "auto-merged stale state (W already == Y)",
    );
  }

  // Verifica W ainda existe (mergeInto vai locked-lookup mas dá throw bare —
  // queremos ResolveError tipado em vez disso).
  const w = await personsRepo.findById(attempt.previous_person_id);
  if (!w) throw new ResolveError("previous_person_gone", `W (${attempt.previous_person_id}) já não existe`);

  try {
    // mergeInto faz tudo: lock LEAST/GREATEST, transfer face_records, audit,
    // delete W. userId hardcoded "system" porque review.ts atual também não
    // tem auth real (parâmetro idem ao classic flow).
    await personsRepo.mergeInto(attempt.previous_person_id, chosenPersonId, "system");
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) {
      // Race com outro mergeInto que já consumiu W ou Y
      throw new ResolveError("concurrent_merge", err.message);
    }
    throw err;
  }

  // Marca o match_attempt como resolvido. Reusa repo method existente.
  await matchAttemptsRepo.resolveAmbiguous(
    attempt.id,
    attempt.detection_id!,
    `merged ${attempt.previous_person_id} → ${chosenPersonId}`,
  );
}

// Para o caso "rejected" do divergente (humano clicou "não é Maria"):
// Reusa rejectAmbiguous existente diretamente — não precisa de wrapper. O
// detection mantém previous_person_id (W) como antes; só marca o
// match_attempt como rejected. Mesma lógica do caso clássico.
```

**HTTP status mapping** no route handler de `/api/matches/:id/resolve`:
| ResolveErrorCode | HTTP |
|---|---|
| not_found | 404 |
| already_resolved | 409 |
| detection_outside_window | 400 |
| person_client_mismatch | 400 |
| checkin_not_found | 500 |
| **concurrent_merge** | **409** (novo) |
| **previous_person_gone** | **410** (novo) |

**UI behavior em 409:** toast "Outro operador já resolveu este match — atualizando lista" + `queryClient.invalidateQueries(['matches','pending'])` → re-fetch automático faz o item sumir da fila.

Endpoint `POST /api/matches/:id/resolve` permanece com mesmo schema de body (`{chosenDetectionId, chosenPersonId}`). UI não precisa diferenciar caso clássico vs divergente — o body é igual.

---

## 5. UI extension

### 5.1 Backend — query enriquecida

`MatchPendingEnriched` é tipo do `@vipcam/shared` (`packages/shared/src/types/index.ts:61`). Adicionar campo opcional `previous_person`:

```typescript
interface MatchPendingEnriched {
  match_attempt_id: string;
  detection: { ... };
  candidates: Array<{ ... }>;  // checkins existentes
  // Onda 9-A: presente apenas quando match_attempts.previous_person_id != null.
  previous_person?: {
    id: string;
    display_name: string | null;
    person_type: "client" | "employee" | "anonymous";
    thumbnail_path: string | null;
  } | null;
}
```

Backend enrichment está em `packages/edge/src/api/match-pending.ts` (NÃO em web/lib/queries — esse é só o hook React Query). A query existente já faz `leftJoin(persons, eq(persons.erp_client_id, erpCheckins.erp_client_id))` pra trazer dados do cliente do checkin → o alias default `persons` já está consumido. Pra um segundo LEFT JOIN em `match_attempts.previous_person_id` é **obrigatório usar `aliasedTable`** do Drizzle:

```typescript
import { aliasedTable } from "drizzle-orm";

const prevPersons = aliasedTable(persons, "prev_persons");

const rows = await db
  .select({
    // ... campos existentes ...
    previous_person_id: matchAttempts.previous_person_id,
    prev_display_name: prevPersons.display_name,
    prev_person_type: prevPersons.person_type,
    prev_thumbnail_path: prevPersons.thumbnail_path,
  })
  .from(matchAttempts)
  .leftJoin(persons, eq(persons.erp_client_id, erpCheckins.erp_client_id))  // existente
  .leftJoin(prevPersons, eq(prevPersons.id, matchAttempts.previous_person_id))  // novo
  // ... resto da query ...
```

Mapper monta `previous_person` no envelope **só se `previous_person_id != null`** (fallback usa `previous_person_snapshot` se a row do prev persons foi deletada — JSONB tem `display_name`/`person_type`/`thumbnail_path` preservados).

### 5.2 Web component — `match-detail.tsx`

Layout atual (clássico, verificar via leitura do arquivo antes de modificar):
```
[snapshot detection — 14:30 — câmera 1]
Candidato ERP: [Maria — checkin 14:32]
[Aceitar Maria] [Rejeitar]
```

Quando `previous_person` presente, prepend um warning block (`bg-yellow-50` + border + ícone alerta):
```
⚠ Esta detection já está ligada a:
   [thumbnail W ou avatar genérico]
   <display_name de W ou "Anônima sem nome"> (<person_type>) — auto-matched pelo reid

Candidato ERP sugerido: [Maria — checkin 14:32]

[É a Maria — merge W → Maria]   [Não é a Maria — manter W]
```

Tooltip no botão merge: "Esta ação é irreversível — face_records de W passam pra Maria, e W é deletada".

**Edge cases (importante validar nos testes):**
- W com `display_name=null` → renderiza fallback `Anônima ${id.slice(0,8)}`
- W com `thumbnail_path=null` → renderiza `<UserCircle/>` avatar genérico
- `previous_person.id === candidate_person.id` → caso defensivo (não deveria ocorrer pelo branching de §4.2, mas se ocorrer, UI mostra info-only sem botões + texto "Já é o mesmo cliente, aguardando dedup")
- HTTP 409 do resolve → toast "Outro operador já resolveu este match — atualizando lista" + `queryClient.invalidateQueries(['matches','pending'])`

Sem componente novo — só condicionais no `MatchDetail` existente.

`packages/web/src/components/match-detail.tsx`:

Layout atual (clássico):
```
[snapshot detection — 14:30 — câmera 1]
Candidato ERP: [Maria — checkin 14:32]
[Aceitar Maria] [Rejeitar]
```

Quando `previous_person` presente, prepend um warning block:
```
⚠ Esta detection já está ligada a:
   [thumbnail W ou ícone genérico] 
   Cliente W (client) — auto-matched pelo reid

Candidato ERP sugerido: [Maria — checkin 14:32]

[É a Maria — merge W → Maria]   [Não é a Maria — manter ligação a W]
```

Visual minimalist (bg-yellow-50 + border + ícone alert):
- Texto dos botões muda quando previous_person presente (deixa claro o efeito: merge vs manter).
- Tooltip explica "esta ação é irreversível" no botão merge.

Sem componente novo — só condicionais no `MatchDetail` existente.

---

## 6. Testes

### 6.1 Integration (DB-deferred)

`tests/integration/match-temp/divergent.test.ts`:

- **Row 3 NO-OP:** detection com person_id=Y já, checkin com client_id mapeando a Y → processCheckin não cria match_attempt
- **Row 4 anonymous divergent:** detection com person_id=X (anonymous), checkin sugerindo Y (client) → match_attempt criado com previous_person_id=X
- **Row 5 client divergent:** detection com person_id=W (client), checkin sugerindo Y (client diferente) → match_attempt criado com previous_person_id=W

### 6.2 Resolve bifurcation

`tests/unit/match-temp/resolve-divergent.test.ts` (mock repos):

- `resolveAmbiguous` com `previous_person_id != null` + matched_to_candidate → chama `personsRepo.mergeInto(previous, candidate, userId)` exactly once
- `resolveAmbiguous` clássico (previous null) + matched → chama `detectionsRepo.assignPerson` + `incrementVisitCount`
- rejected em ambos os casos → sem efeito em persons/detections

### 6.3 UI

`tests/unit/components/match-detail-divergent.test.tsx`:

- `previous_person=null` → renderiza layout clássico (regressão Onda 3)
- `previous_person={id, name: "W"}` → renderiza warning block + botões com textos modificados

### 6.4 Regressão Onda 2

Rodar suite existente de match-temp (orchestrator + resolve) — devem continuar verdes sem mudanças.

---

## 7. Migrações / Deploy

- 1 migration: `0008_*.sql` (ADD COLUMN nullable + FK SET NULL) — backward-compat, zero downtime.
- Sem rebuild de sidecar (reid intocado).
- `vipcam-edge` restart pega novo código + roda migrations no startup.
- Sem mudança em env vars.

### Forward-only
Detections antigas pré-deploy mantêm match_attempts existentes; novos checkins pós-deploy aplicam a nova lógica. Sem replay automático.

---

## 8. Rollback

- **Soft:** revert do orchestrator (1 commit) + restart edge. `previous_person_id` no schema fica órfão mas inerte (queries antigas ignoram). Match_attempts já criados com previous_person_id permanecem — operador pode resolver manualmente via UI antiga (vai ignorar o campo e tratar como ambiguous clássico — pode causar reid mismatch silenciosa, mas é rollback de emergência).
- **Hard:** `git revert` da migration 0008 NÃO é necessário; deixar a coluna NULLABLE intacta. Drop col é opcional manual via psql se desejado.

---

## 9. Calibração

Após deploy:

```sql
-- contagem semanal de divergentes vs total ambiguous
SELECT
  date_trunc('day', decided_at) AS dia,
  count(*) FILTER (WHERE previous_person_id IS NOT NULL) AS divergentes,
  count(*) FILTER (WHERE previous_person_id IS NULL AND decision='ambiguous') AS classicos,
  count(*) AS total
FROM match_attempts
WHERE decided_at > now() - interval '14 days'
GROUP BY 1 ORDER BY 1;
```

**Triggers de ajuste pra REID_DIST_STRICT:**
- divergentes/total > 20% em 3+ dias seguidos → reid está auto-matchando errado demais → tighten `REID_DIST_STRICT` 0.35 → 0.30
- divergentes resolvidos como "matched_to_candidate" (humano confirmou merge) > 70% → reid acerta as direções mas com confiança baixa → loosen `REID_DIST_STRICT` 0.35 → 0.40 (vira menos borderline)
- divergentes resolvidos como "rejected" > 70% → reid acerta no auto-match e operador prefere o reid → considerar adicionar threshold de confidence pra suprimir o ambiguous

---

## 10. Onda 9-A fechada quando

- Migration aplicada em prod sem erro
- processCheckin novo cobre 5 cenários (4 testes integration verde)
- UI aba Temporal mostra warning block em divergentes (1 teste web verde)
- 1+ divergente real apareceu e foi resolvido em produção (validação end-to-end)
- Após 14 dias, query de calibração logada em `2026-XX-XX-onda-9a-report.md` com decisão sobre threshold tuning
