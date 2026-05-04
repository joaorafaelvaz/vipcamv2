#!/usr/bin/env bash
#
# VIPCam — deploy script
# Domain: monitoramento.franquiabv.com.br
# Usage:  sudo ./scripts/deploy.sh [BRANCH]
#
# Idempotente: rodar quantas vezes quiser. Faz pull, install, build,
# migrações (se houver), restart dos systemd services, e health check.
#
# Variáveis de ambiente respeitadas (com defaults):
#   APP_DIR=/opt/vipcam
#   SERVICE_USER=vipcam
#   BRANCH=master
#   EDGE_PORT=4001 (interno, atrás do nginx)
#   WEB_PORT=3035  (exposto via nginx → monitoramento.franquiabv.com.br)
#

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/vipcam}"
SERVICE_USER="${SERVICE_USER:-vipcam}"
BRANCH="${1:-${BRANCH:-master}}"
EDGE_PORT="${EDGE_PORT:-4001}"
WEB_PORT="${WEB_PORT:-3035}"

# Cor + prefixo nos logs do script
log()  { printf "\033[1;36m[deploy]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[deploy]\033[0m %s\n" "$*" >&2; }
fail() { printf "\033[1;31m[deploy]\033[0m %s\n" "$*" >&2; exit 1; }

# Deve rodar como root para mexer em systemd; o trabalho de código
# é feito como SERVICE_USER via sudo -u
if [[ $EUID -ne 0 ]]; then
  fail "execute como root: sudo $0 [BRANCH]"
fi

if [[ ! -d "$APP_DIR/.git" ]]; then
  fail "APP_DIR=$APP_DIR não é um repositório git. Rode infra/install.sh primeiro."
fi

cd "$APP_DIR"

# ----- 1. Snapshot da revisão atual (para rollback) -----
PREV_SHA="$(git rev-parse HEAD)"
log "snapshot pré-deploy: $PREV_SHA"

# ----- 2. Pull do branch alvo -----
log "fetch + reset para origin/$BRANCH"
sudo -u "$SERVICE_USER" git fetch origin "$BRANCH"
sudo -u "$SERVICE_USER" git reset --hard "origin/$BRANCH"
NEW_SHA="$(git rev-parse HEAD)"
if [[ "$PREV_SHA" == "$NEW_SHA" ]]; then
  log "nenhuma mudança no $BRANCH — re-build forçado mesmo assim"
fi

# ----- 3. Install deps -----
log "bun install (frozen lockfile)"
sudo -u "$SERVICE_USER" bun install --frozen-lockfile

# ----- 4. Build do shared (composite TS) -----
if [[ -f packages/shared/package.json ]]; then
  log "tsc --build do @vipcam/shared (gera .d.ts para edge/web)"
  sudo -u "$SERVICE_USER" bash -c "cd packages/shared && bun run typecheck"
fi

# ----- 5. Migrações (idempotente, skip se ainda não há tabelas) -----
MIG_DIR="packages/edge/src/persistence/migrations"
if [[ -d "$MIG_DIR" ]] && compgen -G "$MIG_DIR/*.sql" > /dev/null; then
  log "rodando db:migrate"
  sudo -u "$SERVICE_USER" bash -c "cd packages/edge && bun run db:migrate"
else
  log "sem migrações para aplicar (Onda 2 ainda não landed)"
fi

# ----- 6. Build do web -----
if [[ -f packages/web/package.json ]]; then
  log "next build"
  sudo -u "$SERVICE_USER" bash -c "cd packages/web && bun run build"
fi

# ----- 7. Restart dos serviços -----
log "restart vipcam-edge"
systemctl restart vipcam-edge.service
log "restart vipcam-web"
systemctl restart vipcam-web.service

# Reid sidecar é opcional (só Fase 6+)
if systemctl list-unit-files --no-legend | grep -q '^vipcam-reid\.service'; then
  log "restart vipcam-reid"
  systemctl restart vipcam-reid.service
fi

# ----- 8. Health check com retry -----
log "aguardando edge na porta $EDGE_PORT (até 30s)"
for i in $(seq 1 30); do
  if curl -fs "http://127.0.0.1:$EDGE_PORT/api/health" > /dev/null 2>&1; then
    log "edge ok após ${i}s"
    EDGE_OK=1
    break
  fi
  sleep 1
done

log "aguardando web na porta $WEB_PORT (até 60s — Next cold start)"
for i in $(seq 1 60); do
  if curl -fs "http://127.0.0.1:$WEB_PORT" > /dev/null 2>&1; then
    log "web ok após ${i}s"
    WEB_OK=1
    break
  fi
  sleep 1
done

# ----- 9. Rollback automático em falha -----
if [[ -z "${EDGE_OK:-}" || -z "${WEB_OK:-}" ]]; then
  warn "health check falhou — fazendo rollback para $PREV_SHA"
  sudo -u "$SERVICE_USER" git reset --hard "$PREV_SHA"
  sudo -u "$SERVICE_USER" bun install --frozen-lockfile
  if [[ -f packages/web/package.json ]]; then
    sudo -u "$SERVICE_USER" bash -c "cd packages/web && bun run build"
  fi
  systemctl restart vipcam-edge.service vipcam-web.service
  fail "rollback completo. Investigue: journalctl -u vipcam-edge -u vipcam-web -n 100"
fi

# ----- 10. Sucesso -----
log "✓ deploy completo"
log "  $PREV_SHA → $NEW_SHA"
log "  https://monitoramento.franquiabv.com.br"
log ""
log "logs em tempo real:"
log "  journalctl -u vipcam-edge -u vipcam-web -f"
