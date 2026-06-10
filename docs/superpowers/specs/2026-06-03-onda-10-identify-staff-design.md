# Onda 10 — Identificação manual de funcionários (curadoria anônimo → funcionário)

> **Status:** design aprovado (brainstorming 2026-06-03). Próximo: writing-plans.

**Goal:** A câmera passa a RECONHECER funcionários. Como o seeding por foto do ERP é
empiricamente morto (Onda 9-B: 148 rostos semeados, 0 matches, distâncias 0.46–0.73),
o caminho que funciona é curadoria manual: o operador olha os anônimos mais frequentes
e diz "esse é o funcionário X" → merge → os rostos da PRÓPRIA CÂMERA viram referência
→ reid casa as próximas aparições → funcionário some das janelas do /matches.

## 1. Contexto & por que agora

Diagnóstico acumulado (sessões 2026-05-31 → 06-02, produção):
- **9-B inerte:** foto frontal do ERP embeda longe demais do ângulo/luz da câmera
  (menor distância 0.461 > strict; média 0.733). Re-semear não adianta.
- **Fragmentação:** 2373 pessoas anônimas, 67% vistas 1×, média 1.8 detecções —
  o reid raramente re-identifica (strict era 0.35→0.40; agora 0.50 em observação).
- **staff_like = 0:** nenhum fragmento acumula presença suficiente pra heurística de
  onipresença (9-D B2) disparar → o atendente polui toda janela de checkin →
  **677 checkins ambíguos** que não drenam.
- A 9-D já **exclui `person_type='employee'`** dos candidatos do match-temporal —
  mas nenhuma detecção jamais casa com funcionário. Esta onda constrói a ponte.

**Efeito em cadeia esperado:** identificar um anônimo-funcionário (a) consolida a
identidade dele, (b) futuras aparições casam direto (reid strict 0.50 contra crops
da câmera), (c) ele é excluído das janelas → ambíguos colapsam pra 1 candidato →
auto-resolução da 9-D passa a disparar.

## 2. Decisões (brainstorming)

- **Objetivo:** reconhecimento (não UX cosmética). Foco só em funcionários.
- **Fluxo UI:** "os dois" — fila dedicada de curadoria + ação no perfil do anônimo.
- **Mecanismo:** merge direto via `personsRepo.mergeInto(anon → employee, "user")`
  (reuso; transfere face_records com FIFO cap 5 — crops da câmera entram, seed morto
  do ERP acaba evictado naturalmente; migra detections/sessions; audita em
  `person_merge_audit`). Alternativas rejeitadas: tag-sem-merge (não consolida
  face_records, não resolve), clustering automático (assist futuro, YAGNI).
- **Dismiss persistente** em `persons.metadata.identify_dismissed=true` (jsonb
  existente — **sem migration**).

## 3. Backend (edge)

### 3.1 `GET /api/persons/identify/queue?limit=N`
Anônimos candidatos a staff, ordenados por nº de detecções desc (mais visto = mais
provável staff), excluindo `metadata->>'identify_dismissed' = 'true'` e excluindo
quem tem 0 detecções. Item:

```ts
{ person_id, detection_count, last_seen_at, snapshots: string[] /* ≤3 paths recentes */ }
```

Implementação: `personsRepo.listIdentifyQueue(limit)` — padrão do repo (1 query
agregada + 1 query de snapshots recentes agrupada em memória, espelha Onda 4 D1).

### 3.2 `POST /api/persons/:id/identify` body `{ employee_person_id }`
Validações (espelha o rigor do resolveAmbiguous):
1. `:id` existe e `person_type === 'anonymous'` (404 / 400 `not_anonymous`);
2. `employee_person_id` existe e `person_type === 'employee'` (400 `not_employee`);
3. `mergeInto(:id → employee_person_id, "user")`; erro `/not found/` → 409
   `concurrent_merge` (race com auto-merge da 9-D ou outro operador).

Resposta: `{ ok: true }`. Auth: apiKeyMiddleware existente em `/api/persons/*`.

### 3.3 `POST /api/persons/:id/identify/dismiss`
Valida anônimo; seta `metadata.identify_dismissed = true` via `personsRepo.update`
(merge do jsonb preservando chaves existentes). Remove da fila. `{ ok: true }`.

## 4. Web

### 4.1 Página `/identify` ("Identificar")
Cards (ou rows) da fila: até 3 fotos (mesmo render de snapshot do /matches),
`detection_count`, última vez visto. Ações por item:
- **"É funcionário…"** → combobox com busca (dados de `GET /api/persons?type=employee`,
  endpoint existente) → Confirmar → `POST identify` → toast + invalidate da fila.
- **"Ignorar"** → `POST dismiss` → some da fila.

### 4.2 Ação no perfil (`/people/[id]`)
Se a pessoa é `anonymous`: botão "É funcionário…" (mesmo modal/combobox/endpoint).

### 4.3 Navegação
Item "Identificar" no nav principal.

## 5. Arquivos

| Arquivo | Mudança |
|---|---|
| `packages/edge/src/persistence/repositories/persons.repo.ts` | `+listIdentifyQueue(limit)` |
| `packages/edge/src/api/routes/persons.ts` | `+3 rotas` (queue / identify / dismiss) via deps |
| `packages/edge/src/api/server.ts` | wire das novas deps |
| `packages/shared/src/types/*` | tipos `IdentifyQueueItem` etc. |
| `packages/web/src/app/identify/page.tsx` (**novo**) | página da fila |
| `packages/web/src/components/identify-queue.tsx` (**novo**) | lista + ações |
| `packages/web/src/components/identify-employee-dialog.tsx` (**novo**) | combobox+confirm (reusado no perfil) |
| `packages/web/src/lib/queries/identify.ts` (**novo**) | hooks React Query |
| `packages/web/src/app/people/[id]/*` | botão "É funcionário…" p/ anônimos |
| nav component | item "Identificar" |

**Sem migration.**

## 6. Testes

- **Unit (edge):** validações do identify (anon→employee only; 404/400/409),
  dismiss seta metadata sem clobber de chaves existentes.
- **Integração (edge):** identify executa merge real (detections/face_records migram,
  anon some); queue ordena por detection_count e exclui dismissed/zero-detections.
- **Web (happy-dom):** fila renderiza itens + dispara mutations; dialog filtra
  funcionários; perfil de anônimo mostra o botão.

## 7. Riscos & mitigação

- **Identificação errada (humana):** auditada em `person_merge_audit` (snapshot do
  src); mesma classe de risco do resolve manual do /matches. Sem undo automático na
  v1 (registrado como limitação).
- **Fila mostra cliente frequente:** ação "Ignorar" (dismiss persistente).
- **Race com auto-merge da 9-D:** 409 `concurrent_merge`, UI refaz fetch.
