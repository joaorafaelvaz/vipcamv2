# Onda 9-D — Auto-resolução do /matches (consolidar + drenar)

> **Status:** design aprovado (brainstorming 2026-06-02). Próximo: writing-plans.

**Goal:** Reduzir drasticamente o retrabalho manual no /matches — colapsando a explosão
de attempts por-detecção, excluindo pessoas onipresentes (staff não-identificado) do
conjunto de candidatos, e auto-resolvendo quando sobra um único candidato específico —
sem perder matches corretos.

## 1. Contexto & evidências (produção, 2026-06-02)

Depois que a ingestão de checkins voltou (Onda 9-C), o /matches encheu: **2152 ambíguos**
(1798 divergent/Pass2 + 354 classic/Pass1). Investigação:

- **Distribuição de candidatos anônimos distintos por checkin:** só **16%** dos checkins
  têm 1 candidato; **84%** têm 2–8. Auto-resolver "candidato único" sozinho drenaria só 16%.
- **Top recorrentes:** uma pessoa anônima aparece em **37 checkins** (129 attempts) — padrão
  de **staff onipresente** (sempre presente, cai como anônimo porque o seeding 9-B está
  morto). Outras têm `total_visits=1` mas aparecem em ~23 checkins → **clientes únicos
  sobrepostos em picos** (muitos checkins agrupados em minutos).

**Duas fontes de ruído:**
1. **Onipresentes (staff/regular):** atacável — excluir do conjunto de candidatos via
   heurística de presença (sem depender da foto do ERP, que não casa — vide Onda 9-C §H-B).
2. **Sobreposição de pico:** N clientes presentes + M checkins agrupados → N×M attempts.
   **Limite fundamental** — sem rosto do cliente cadastrado, nenhuma regra automática
   sabe qual cliente é qual checkin. Só melhora ao longo do tempo conforme o sistema
   aprende rostos de clientes (checkins resolvidos → visitas futuras casam convergente).

Esta onda ataca tudo que é atacável; o pico fica como ambiguidade residual que decai
sozinha com o aprendizado de rostos (acelerado pelo Part A).

## 2. Decisões (brainstorming)

- **Part A:** `REID_DIST_STRICT` 0.35 → **0.40** (consolidar identidades no ingest).
- **Part B (orchestrator):** colapsar attempts (B1) + excluir onipresentes/staff (B2) +
  auto-resolver single candidato específico (B3).
- **Backfill:** opt-in, **dry-run primeiro** (reporta antes de aplicar). Não automático.
- **Pico:** aceito como ambiguidade residual (sem solução automática honesta).

## 3. Comportamento atual (baseline)

`processCheckin` (match-temp/orchestrator.ts), por checkin do cliente Y (candidatePerson):
- **Pass 1 (clássico):** detections com `person_id IS NULL` → `decideMatch`:
  0→rejected, 1→auto_matched, >1→ambiguous (1 attempt, sem detection/previous_person).
- **Pass 2 (divergent, 9-A):** para **cada** detection identificada (`person_id != Y`) →
  cria **1 attempt ambíguo** com `previous_person_id`, snapshot. (Row 3: `person_id == Y`
  → no-op convergente.)

A explosão vem do Pass 2 ser **por-detecção**, e de não filtrar staff/outros-clientes.

Match reid no ingest (`api/reid/match-policy.ts` + orchestrator): strict (≤0.35)→liga,
borderline (0.35–0.55)→`person_id=NULL`, new_person(>0.55)→cria anônimo.

## 4. Design

### Part A — Consolidação no ingest
`config/env.ts`: default `REID_DIST_STRICT` 0.35 → **0.40** (refine exige strict<loose=0.55 ✓).
Produção: atualizar/checar `REID_DIST_STRICT` no `/etc/vipcam/edge.env`. Move [0.35,0.40] de
borderline→strict (passa a ligar à pessoa existente). Reduz fragmentação; cresce o histórico
por pessoa → matches futuros mais prováveis (aprendizado de rosto de cliente). Reversível por env.

### Part B — Redesign da resolução temporal (`processCheckin`)

Substitui o laço Pass-2-por-detecção por uma **decisão única por checkin**, sobre o conjunto
de **candidatos distintos** na janela ±MATCH_WINDOW_SECONDS.

**Classificação dos detections na janela** (precisa de `person_type` — estender a query/JOIN):
- `person_id == Y` → **convergente** (match já existe) → marca satisfeito, sem attempt.
- `person_type == 'employee'` → **excluir** (funcionário não é quem deu checkin).
- `person_type == 'client'` e `!= Y` → **excluir** (outro cliente).
- `person_type == 'anonymous'` → **candidato** (agrupado por `person_id`).
- `person_id IS NULL` → candidato "não-ligado" (Pass 1). Mantém tratamento clássico, mas
  entra na contagem de candidatos para a decisão de auto-resolução (ver B3).

**B1 — Colapsar:** no máximo **1 attempt por (checkin, candidate person)** — não por
detecção. Agrupa detections identificadas por `person_id` antes de decidir.

**B2 — Excluir onipresentes (staff-like):** um candidato anônimo é "staff-like" se seu
padrão de presença excede thresholds configuráveis — proxy de "presente o dia todo, todo
dia" (≠ cliente que vem ~1h). Definição v1 (cheap, sem migration):

> `staff-like` = nº de **slots de hora distintos** com detecção nos últimos
> `STAFF_LOOKBACK_DAYS` dias ≥ `STAFF_MIN_ACTIVE_HOURS`.

Defaults a **validar empiricamente** na implementação (medir quantos candidatos são
excluídos e se "parecem staff" antes de fixar). Ex. inicial: `STAFF_LOOKBACK_DAYS=7`,
`STAFF_MIN_ACTIVE_HOURS=20`. Query por candidato (indexada em person_id+detected_at);
cache dentro do ciclo de poll para não repetir. Candidatos staff-like são **excluídos do
conjunto de candidatos** (não viram attempt, não auto-resolvem).

**B3 — Auto-resolver single específico:** após B2, seja `C` = candidatos restantes
(anônimos não-staff) + detections NULL na janela:
- `|C| == 0` → **rejected** (ninguém plausível).
- **exatamente 1 candidato anônimo** e 0 NULL → **auto-resolver**:
  `personsRepo.mergeInto(anon → Y, 'system')` + `match_attempt(decision='auto_matched',
  decided_by='system', previous_person_id=anon)`. (Reusa o caminho do `resolveDivergent`.)
- **exatamente 1 detection NULL** e 0 anônimos → link clássico (Pass 1 auto_matched atual).
- **≥2 candidatos** → **1 attempt ambíguo por candidato distinto** (colapsado por B1),
  para revisão manual. (Pico cai aqui — esperado.)

> Conservador de propósito: auto-merge só com **exatamente 1** candidato específico. "Dominante"
> (vários candidatos, um claramente mais provável) fica como extensão futura, depois de medir
> a acurácia do single em produção.

### Backfill (opt-in, dry-run-first)
Script dedicado (`scripts/` ou comando bun) que re-avalia os **checkins com attempts
ambíguos pendentes** aplicando a lógica B1+B2+B3:
- **`--dry-run` (default):** reporta, por checkin, o que faria (auto-resolver X→Y / colapsar
  N→1 / manter ambíguo) e totais agregados. **Não escreve.**
- **`--apply`:** executa (merges + colapso) dentro de transações, idempotente.
Roda deliberadamente pelo operador, que revisa o dry-run antes. Drena os 2152 existentes.

## 5. Arquivos

| Arquivo | Mudança |
|---|---|
| `packages/edge/src/config/env.ts` | default `REID_DIST_STRICT` 0.40; `+STAFF_LOOKBACK_DAYS`, `+STAFF_MIN_ACTIVE_HOURS` |
| `packages/edge/src/match-temp/orchestrator.ts` | redesign Pass 2 → decisão única (B1+B2+B3) |
| `packages/edge/src/match-temp/candidates.ts` (**novo**) | puras: classificar/agrupar candidatos, regra de decisão (testável sem DB) |
| `packages/edge/src/persistence/repositories/detections.repo.ts` | `findInWindow` retorna `person_type` (JOIN persons) |
| `packages/edge/src/persistence/repositories/persons.repo.ts` | `+isStaffLike(personId, lookbackDays, minHours)` ou `presenceActiveHours(...)` |
| `packages/edge/scripts/backfill-rematch.ts` (**novo**) | backfill dry-run/apply |
| Testes | unit das puras (classificação/decisão B1/B3); integração (auto-merge single, ≥2 colapsado, exclui staff/employee/other-client, convergente no-op); staff-like query |

**Sem migration** (heurística staff é derivada de detections; thresholds via env).

## 6. Testes (cenários-chave)
- 1 candidato anônimo → auto_matched + mergeInto chamado.
- 2+ candidatos anônimos → N attempts colapsados (1 por pessoa, não por detecção).
- candidato employee/other-client → excluído (não vira attempt).
- candidato staff-like (presença alta) → excluído; se era o único → rejected.
- convergente (`person_id==Y`) → no-op.
- backfill dry-run não escreve; apply é idempotente.

## 7. Deploy & verificação
1. Deploy do código (branch → origin → `deploy.sh`).
2. `edge.env`: confirmar/ajustar `REID_DIST_STRICT=0.40` (+ thresholds staff se override).
3. Observar logs do `processCheckin` (nova decisão), e a taxa de novos ambíguos/dia cair.
4. Rodar `backfill-rematch --dry-run`, revisar o relatório, então `--apply` para drenar os 2152.
5. Conferir `match_attempts` por decisão (auto_matched sobe, ambiguous despenca).

## 8. Riscos & premissas
- **(a) Auto-merge errado:** só com exatamente 1 candidato específico; janela ±5min; reversível
  por revisão. Aceito ("tem sido bastante correto").
- **(b) Falso-positivo de staff:** thresholds conservadores + validação empírica antes de fixar;
  excluir cliente real raro é possível → começar alto e medir. Reversível por env.
- **(c) Pico residual:** ambiguidade real não resolvida automaticamente; decai com aprendizado
  de rosto (Part A acelera). Documentado, não é defeito.
- **(d) Custo runtime do staff-check:** query por candidato; mitigado por índice + cache no ciclo.
- **(e) Relaxar reid p/ 0.4:** risco de unir pessoas parecidas; tunável por env; monitorar.
