# Design: Onda 4 — Débitos & Hardening

**Data:** 2026-05-15
**Status:** Aprovado (saiu de brainstorming, pendente plano de implementação)
**Autor(es):** Rafael Vaz + Claude
**Contexto:** Onda 3 (frontend de visibilidade) fechou e está em produção. Durante a execução foram conscientemente deferidos alguns débitos técnicos. Esta onda paga esses débitos. **Sem novas features.** Escopo fechado, implementável sem acesso ao servidor (validação operacional de D3 acontece quando houver acesso).

---

## 1. Objetivo

Eliminar 3 débitos técnicos da Onda 3 e registrar formalmente 2 itens diferidos (nginx SSE — operacional; Failover B — onda futura com gate). Nenhuma mudança de comportamento de produto.

---

## 2. Escopo

### D1 — N+1 em `GET /api/matches/pending`

**Arquivo:** `packages/edge/src/api/server.ts` (handler `listPending` do `createMatchRoutes`)

**Problema:** o handler busca os match_attempts ambíguos, e então itera com um `for` emitindo **uma query de detections candidatas por match**. Com backlog (ex: ERP fora do ar por horas gerando muitos ambíguos) e `refetchInterval` de 30s no frontend, isso degrada.

**Fix:** após buscar os N `matchAttempts` ambíguos + os checkins correlatos:
- computar `unionStart = min(window.start de todos)` e `unionEnd = max(window.end de todos)`
- **uma única** query: `detections WHERE person_id IS NULL AND detected_at BETWEEN unionStart AND unionEnd ORDER BY detected_at`
- atribuir candidatas a cada match em memória: para cada match, filtrar as detections cujo `detected_at` cai na janela específica daquele checkin (`computeWindow(checkin.occurred_at, MATCH_WINDOW_SECONDS)`)

Mesmo padrão de `sessionsRepo.listByPerson` (1 query + agrupamento em memória) já usado no codebase — consistência. Interface pública `MatchPendingEnriched` **inalterada**.

**Edge case:** zero matches pendentes → retorna `[]` sem nenhuma query de detections (early return preservado).

### D2 — typecheck monorepo resolvendo `@vipcam/shared` por source

**Arquivo:** `tsconfig.base.json`

**Problema:** `@vipcam/shared` é pacote TS composite; consumidores (edge/web) resolvem os tipos pelos `.d.ts` em `dist/`. Typecheckar um consumidor isolado (`bun --filter '@vipcam/edge' typecheck`) contra um `dist/` stale produz erro fantasma (observado: "Module '@vipcam/shared' has no exported member 'SessionWithDetections'"). `bun run typecheck` da raiz já acerta a ordem de dependência, mas a pegadinha existe.

**Fix:** adicionar em `tsconfig.base.json` `compilerOptions.paths`:
```jsonc
"paths": {
  "@vipcam/shared": ["packages/shared/src/index.ts"],
  "@vipcam/shared/*": ["packages/shared/src/*"]
}
```
(caminho relativo à `baseUrl` do tsconfig.base — ajustar conforme a `baseUrl` real do arquivo). Consumidores passam a typecheckar contra o **source fresco** — elimina dependência de build-ordering. Qualquer typecheck (isolado ou root) vê o source atual.

**Validação obrigatória:**
- `bun run typecheck` → 3/3 exit 0
- `bun --filter '@vipcam/edge' typecheck` isolado → passa **sem** precisar de shared dist
- `bun --filter '@vipcam/web' typecheck` isolado → passa
- `cd packages/web && next build` → OK (Next já resolve shared por source via transpile; paths só afeta typecheck)
- `bun test` edge + web → sem regressão (paths é compile-time; runtime edge usa NodeNext `.js`, runtime web usa bundler — nenhum afetado)

**Risco:** mudança de resolução de tipos. Mitigação: a bateria de validação acima cobre os 3 consumidores + build + runtime.

### D3 — home do service-user `vipcam` → `/var/lib/vipcam`

**Arquivo:** `infra/install.sh` (+ conferência em `infra/systemd/*`)

**Problema:** `install.sh` cria `vipcam` com `useradd --home /opt/vipcamv2`. Resultado: `.bun/`, `.config/`, `.cache/`, `.lesshst` etc. são criados dentro do checkout do repo (vistos no `git status` do VPS). Risco de poluição e de `git add .` acidental pegar dotfiles.

**Fix em `install.sh`:**
- novos installs: `useradd --system --home /var/lib/vipcam --shell /bin/bash vipcam`
- bloco idempotente para o user já existente no VPS:
  ```bash
  if id -u vipcam &>/dev/null; then
    cur_home="$(getent passwd vipcam | cut -d: -f6)"
    if [ "$cur_home" != "/var/lib/vipcam" ]; then
      usermod -d /var/lib/vipcam vipcam
    fi
  fi
  mkdir -p /var/lib/vipcam
  chown vipcam:vipcam /var/lib/vipcam
  chmod 750 /var/lib/vipcam
  ```
- **Conferir `infra/systemd/*.service`**: se algum unit depende de `WorkingDirectory=/opt/vipcamv2` está OK (é o repo, correto), mas se algum assume `$HOME=/opt/vipcamv2` implicitamente para cache do bun, adicionar `Environment=HOME=/var/lib/vipcam`. `deploy.sh` roda `bun` como vipcam → o HOME novo precisa ser writable (o `chown` acima garante).
- Documentar no comentário do install.sh que num VPS já provisionado o `usermod` move o home mas **não migra** os dotfiles antigos (ficam órfãos em /opt/vipcamv2 até serem limpos manualmente — passo operacional documentado, não destrutivo automático).

**Validação:** `bash -n infra/install.sh`. Aplicação real (rodar install.sh no VPS, conferir `getent passwd vipcam`, deploy.sh ainda funciona, dotfiles novos vão pra /var/lib/vipcam) é **operacional** — feita quando houver acesso ao servidor, documentada no plano.

---

## 3. Itens diferidos (registro formal, não-código nesta onda)

### nginx SSE — corrigido, aplicação operacional pendente

Commit `2e3b7d0` adicionou `location = /api/events/stream` com `Connection ""` + buffering/cache off + read_timeout 3600s (causa raiz: bloco `/api/` genérico forçava `Connection "upgrade"` de WebSocket, quebrando o stream SSE com 502). **Código pronto.** Falta só aplicar no VPS (não faz parte do deploy.sh — passo manual de nginx):
```bash
cd /opt/vipcamv2 && sudo -u vipcam git pull origin master
sudo cp infra/nginx/monitoramento.franquiabv.com.br.conf /etc/nginx/sites-available/monitoramento.franquiabv.com.br
sudo nginx -t && sudo systemctl reload nginx
```
Atualizar a Section 0 do spec da Onda 3 registrando este estado.

### Failover B — Onda futura com gate de Discovery de imagem

Re-id local (InsightFace + pgvector ANN) **não** entra nesta onda. Bloqueador: precisa de uma **imagem de rosto** por detecção pra gerar embedding, e a fonte é empírica/não-verificada neste hardware.

**Scaffold já pronto (Ondas 1-2):** `face_records` schema completo (`embedding vector(512)` + índice HNSW `vector_cosine_ops` m=16/ef_construction=64 na migration 0001); `packages/reid` (FastAPI stub, só `/health`).

**Falta:** captura de imagem da câmera; módulo `reid-mgr/` no edge; sidecar InsightFace real (`/embed`); wiring no pipeline + systemd unit `vipcam-reid` + modelo no VPS.

**Gate obrigatório antes de desenhar Failover B:** rodar probe na câmera DH-IPC-HFW5442T-ASE para determinar a fonte da imagem de rosto:
- (a) parte `image/jpeg` dentro do multipart do `eventManager.cgi`
- (b) snapshot CGI separado (`/cgi-bin/snapshot.cgi`) acionado por evento
- (c) frame-grab do RTSP no instante da detecção
- (d) câmera não entrega rosto utilizável → Failover B inviável neste hardware (reavaliar estratégia)

M4 (helper `snapshotUrl` assume filename flat) fica anexado a essa onda futura — só relevante quando houver captura de imagem.

---

## 4. Out of scope (YAGNI)

- Failover B em si (onda futura, gated)
- Retention job de snapshots / LGPD opt-out — era placeholder da "Onda 4" original, mas é **feature nova**, não débito da Onda 3. Adiar; vira sub-tema de spec próprio quando priorizado.
- Qualquer mudança de comportamento de produto ou de API pública.

---

## 5. Estratégia de testes

- **D1:** integration test no edge (Postgres `vipcam_test`) — criar 2+ match_attempts ambíguos com checkins de janelas temporais distintas + detections anônimas dentro/fora de cada janela; assertar que cada `MatchPendingEnriched` recebe exatamente as candidatas da sua janela. (bun:test não conta queries facilmente → validar correção + comentário documentando o invariante "1 query única".)
- **D2:** sem teste novo — validação por `bun run typecheck` 3/3 + typecheck isolado de cada consumidor + `next build` + suites edge/web sem regressão.
- **D3:** `bash -n infra/install.sh`. Validação funcional é operacional (no VPS).

---

## 6. Estimativa & execução

1 chunk único, ~6-8 tasks (TDD onde aplicável: D1 tem teste; D2/D3 são config/infra validados por comando). Pequeno. Execução direta (fixes prescritivos, mesmo padrão dos chunks 3.1-3.6) ou subagent-driven se preferir.

---

## 7. Próximos passos

1. Spec aprovado (este doc) → spec-document-reviewer valida.
2. `superpowers:writing-plans` gera plano detalhado (1 chunk).
3. Execução + verificação (typecheck/lint/tests).
4. Merge master + push. Aplicação operacional de D3/nginx no VPS quando houver acesso.
