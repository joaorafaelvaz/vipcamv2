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
  REFERENCES persons(id) ON DELETE SET NULL;
```

**Por que `SET NULL` e não `CASCADE`:** se W for deletado depois (merged em outra pessoa ou opted-out), o registro do match_attempt ainda é audit-relevante ("este ambiguous existiu, mas a person W não mais"). `CASCADE` apagaria o histórico.

Drizzle schema em `packages/edge/src/persistence/schema/match-attempts.ts`:

```typescript
previous_person_id: uuid("previous_person_id")
  .references(() => persons.id, { onDelete: "set null" }),
```

`MatchAttempt` $inferSelect ganha o campo nullable.

---

## 4. Backend — pipeline ERP

### 4.1 Nova query

`packages/edge/src/persistence/repositories/detections.repo.ts` ganha:

```typescript
async findInWindow(start: Date, end: Date, cameraId: string): Promise<Array<{
  id: string;
  detected_at: Date;
  person_id: string | null;
  snapshot_path: string | null;
}>>
```

Sem filtro de `person_id IS NULL` (contraste com `findAnonymousInWindow`). `findAnonymousInWindow` é deletado se nenhum outro caller existir após o refactor; caso contrário, fica marcado deprecated.

### 4.2 processCheckin refactor

`packages/edge/src/match-temp/orchestrator.ts`. Pseudo-código novo:

```typescript
async function processCheckin(checkin: ErpCheckin) {
  const start = subSeconds(checkin.occurred_at, MATCH_WINDOW_SECONDS);
  const end   = addSeconds(checkin.occurred_at, MATCH_WINDOW_SECONDS);
  const cameraId = await getDefaultCameraId();  // ou via lookup

  const candidates = await detectionsRepo.findInWindow(start, end, cameraId);
  const candidatePerson = await personsRepo.findByErpClientId(checkin.client_id);

  if (!candidatePerson) return;  // ERP client desconhecido — não temos pra onde merger

  const anonymous = candidates.filter(c => c.person_id === null);

  for (const det of candidates) {
    if (det.person_id === null) {
      // Caminho clássico (Onda 2)
      if (anonymous.length === 1) {
        // auto-match — UPDATE detection, INSERT match_attempt(decision='auto_matched')
        await matchAttemptsRepo.create({
          detection_id: det.id,
          erp_checkin_id: checkin.erp_id,
          decision: "auto_matched",
        });
        await detectionsRepo.assignPerson(det.id, candidatePerson.id);
      } else {
        // ambiguous clássico (2+ anonymous na janela)
        await matchAttemptsRepo.create({
          detection_id: det.id,
          erp_checkin_id: checkin.erp_id,
          decision: "ambiguous",
        });
      }
    } else if (det.person_id === candidatePerson.id) {
      // Row 3: NO-OP — reid e ERP concordam, nada a registrar
      continue;
    } else {
      // Rows 4-5: ambiguous divergente
      await matchAttemptsRepo.create({
        detection_id: det.id,
        erp_checkin_id: checkin.erp_id,
        decision: "ambiguous",
        previous_person_id: det.person_id,  // ← novo: signal pro UI
      });
    }
  }
}
```

**Decision enum sem alteração** — `ambiguous` cobre os dois sub-casos; o discriminador é `previous_person_id != null`.

### 4.3 resolveAmbiguous bifurcation

`packages/edge/src/match-temp/review.ts`:

```typescript
async function resolveAmbiguous(matchId: string, choice: ResolveChoice, userId: string) {
  const m = await matchAttemptsRepo.findById(matchId);
  if (!m) throw new ResolveError("not_found");
  if (m.decision !== "ambiguous") throw new ResolveError("already_resolved");

  if (m.previous_person_id) {
    // Caso divergente (rows 4-5)
    if (choice.kind === "matched_to_candidate") {
      const candidatePerson = await personsRepo.findByErpClientId(m.erp_checkin_id);
      // Race-safe: candidatePerson ainda existe pq mergeInto vai locked-lookup
      await personsRepo.mergeInto(m.previous_person_id, candidatePerson.id, userId);
      // mergeInto JÁ updata todas as detections.person_id, sessions, face_records
    }
    // Em "rejected" — mantém previous_person_id como dono da detection (no-op)
  } else {
    // Caso clássico (rows 1-2 — mantém comportamento atual)
    if (choice.kind === "matched_to_candidate") {
      await detectionsRepo.assignPerson(m.detection_id, choice.candidate_person_id);
      await personsRepo.incrementVisitCount(choice.candidate_person_id, detection.detected_at);
    }
    // rejected idem ao classic
  }

  await matchAttemptsRepo.markResolved(matchId, choice.kind, userId);
}
```

Endpoint `POST /api/matches/:id/resolve` permanece com mesmo schema de body. UI não precisa diferenciar.

---

## 5. UI extension

`packages/web/src/lib/queries/matches.ts` (já existente, da aba Temporal): a query enriquecida retorna `MatchPendingEnriched` — adicionar campo opcional `previous_person`:

```typescript
interface MatchPendingEnriched {
  match_attempt_id: string;
  detection: { ... };
  candidates: Array<{ ... }>;  // checkins existentes
  // Onda 9-A:
  previous_person?: {
    id: string;
    display_name: string | null;
    person_type: "client" | "employee" | "anonymous";
    thumbnail_path: string | null;
  };
}
```

Backend query enriquece via LEFT JOIN persons ON `match_attempts.previous_person_id = persons.id`.

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
