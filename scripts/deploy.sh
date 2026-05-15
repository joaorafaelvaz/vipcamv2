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

APP_DIR="${APP_DIR:-/opt/vipcamv2}"
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

# ----- 0. Normaliza ownership (root-cause fix, 2026-05-15) -----
# As ops git abaixo rodam como $SERVICE_USER. `git reset --hard` precisa
# unlink arquivos modificados, e unlink exige WRITE no diretório PAI (não
# no arquivo). Se qualquer dir do working tree estiver root-owned — ex:
# alguém rodou `git pull` como root, ou um commit anterior introduziu um
# diretório novo via op git root — o `git reset --hard` como $SERVICE_USER
# falha com "unable to unlink ... Permission denied" e, com set -e, ABORTA
# o deploy (ou pior: silenciosamente deixa arquivo de auth stale).
# chown -R idempotente RESTAURA a invariante "working tree pertence ao
# service user" em todo deploy, independente de como o drift aconteceu.
log "normalizando ownership de $APP_DIR para $SERVICE_USER"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

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
# Note: db:migrate precisa de DATABASE_URL no env. Como systemd carrega
# /etc/vipcam/edge.env via EnvironmentFile mas `bun run` não, exportamos
# manualmente com `set -a` antes do migrate. Service user vipcam tem
# permissão de leitura no /etc/vipcam/edge.env (chmod 640 root:vipcam).
MIG_DIR="packages/edge/src/persistence/migrations"
EDGE_ENV="/etc/vipcam/edge.env"
if [[ -d "$MIG_DIR" ]] && compgen -G "$MIG_DIR/*.sql" > /dev/null; then
  # Confirma que o service user consegue ler o env file
  if ! sudo -u "$SERVICE_USER" test -r "$EDGE_ENV"; then
    fail "migrations precisam de DATABASE_URL mas $EDGE_ENV não é legível pelo user $SERVICE_USER"
  fi
  # NÃO usar `source $EDGE_ENV`: o arquivo contém ERP_QUERY_* com SQL que
  # tem `(`, `'`, `?` — bash interpreta como sintaxe e quebra
  # ("syntax error near unexpected token `('"). db:migrate só precisa de
  # DATABASE_URL; extraímos só ela e passamos via `env` (literal, sem
  # avaliação de shell — robusto a senha com caracteres especiais).
  log "rodando db:migrate (DATABASE_URL extraída de $EDGE_ENV)"
  DB_URL="$(grep -E '^DATABASE_URL=' "$EDGE_ENV" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
  if [[ -z "$DB_URL" ]]; then
    fail "DATABASE_URL não encontrada em $EDGE_ENV"
  fi
  sudo -u "$SERVICE_USER" env DATABASE_URL="$DB_URL" bash -c "cd packages/edge && bun run db:migrate"
else
  log "sem migrações para aplicar (Onda 2 ainda não landed)"
fi

# ----- 6. Build do web -----
# Next inlina NEXT_PUBLIC_* em BUILD time. Sem essas vars o frontend
# sobe com env undefined (getClientEnv() lança). Extraímos de
# /etc/vipcam/web.env (mesmo padrão do db:migrate: grep+env, NÃO source —
# robusto a chars especiais e não vaza outras vars pro processo de build).
WEB_ENV="/etc/vipcam/web.env"
if [[ -f packages/web/package.json ]]; then
  if [[ ! -f "$WEB_ENV" ]]; then
    fail "$WEB_ENV não existe — frontend precisa de NEXT_PUBLIC_API_URL/KEY. Crie a partir de infra/env-templates/web.env.example"
  fi
  WEB_API_URL="$(grep -E '^NEXT_PUBLIC_API_URL=' "$WEB_ENV" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
  WEB_API_KEY="$(grep -E '^NEXT_PUBLIC_API_KEY=' "$WEB_ENV" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
  if [[ -z "$WEB_API_URL" || -z "$WEB_API_KEY" ]]; then
    fail "NEXT_PUBLIC_API_URL ou NEXT_PUBLIC_API_KEY ausente/vazio em $WEB_ENV"
  fi
  log "next build (NEXT_PUBLIC_* de $WEB_ENV)"
  sudo -u "$SERVICE_USER" env \
    NEXT_PUBLIC_API_URL="$WEB_API_URL" \
    NEXT_PUBLIC_API_KEY="$WEB_API_KEY" \
    bash -c "cd packages/web && bun run build"
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
    # Rollback também precisa dos NEXT_PUBLIC_* (reusa as vars já extraídas
    # na seção 6; se o fail ocorreu antes delas, re-extrai defensivamente).
    sudo -u "$SERVICE_USER" env \
      NEXT_PUBLIC_API_URL="${WEB_API_URL:-$(grep -E '^NEXT_PUBLIC_API_URL=' "${WEB_ENV:-/etc/vipcam/web.env}" | head -1 | cut -d= -f2- | tr -d "\"'")}" \
      NEXT_PUBLIC_API_KEY="${WEB_API_KEY:-$(grep -E '^NEXT_PUBLIC_API_KEY=' "${WEB_ENV:-/etc/vipcam/web.env}" | head -1 | cut -d= -f2- | tr -d "\"'")}" \
      bash -c "cd packages/web && bun run build"
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
