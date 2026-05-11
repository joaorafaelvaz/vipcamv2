#!/usr/bin/env bash
#
# VIPCam — first-time install no VPS Linux (Ubuntu/Debian).
# Idempotente — pode rodar quantas vezes quiser.
#
# Uso (como root):
#   sudo ./infra/install.sh
#
# O que faz:
#   1. Cria usuário de sistema 'vipcam'
#   2. Prepara /etc/vipcam (envs) e /var/log/vipcam (logs legados)
#   3. Cria /opt/vipcamv2/snapshots e /opt/vipcamv2/discovery-output (writable pelo service)
#   4. Instala systemd units (edge + web) e recarrega systemd
#   5. Instala vhost nginx (sem ativar TLS — certbot é etapa manual)
#   6. Lista próximos passos
#
# NÃO inicia os serviços nem mexe em nginx ativo. A primeira ativação
# é manual (ver README.md) para evitar derrubar outros sites do VPS.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/vipcamv2}"
SERVICE_USER="${SERVICE_USER:-vipcam}"
DOMAIN="monitoramento.franquiabv.com.br"

log()  { printf "\033[1;36m[install]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[install]\033[0m %s\n" "$*" >&2; }
fail() { printf "\033[1;31m[install]\033[0m %s\n" "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "execute como root: sudo $0"
[[ -d "$APP_DIR" ]] || fail "APP_DIR=$APP_DIR não existe. Clone o repo lá primeiro."
[[ -d "$APP_DIR/infra/systemd" ]] || fail "infra/systemd/ não encontrado em $APP_DIR — repo incompleto?"

# ----- 1. Usuário de sistema -----
if id -u "$SERVICE_USER" &>/dev/null; then
  log "usuário $SERVICE_USER já existe"
else
  log "criando usuário $SERVICE_USER"
  useradd --system --home "$APP_DIR" --shell /bin/bash "$SERVICE_USER"
fi

# Dono dos arquivos do repo
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

# ----- 1.5. Symlink global do bun -----
# Bun é instalado por usuário (default ~/.bun/bin/bun). Pro systemd unit
# achar via /usr/local/bin/bun (PATH padrão), criamos symlink. Idempotente.
if [[ ! -e /usr/local/bin/bun ]]; then
  BUN_PATH=""
  for candidate in /root/.bun/bin/bun /home/*/.bun/bin/bun; do
    if [[ -x "$candidate" ]]; then
      BUN_PATH="$candidate"
      break
    fi
  done
  if [[ -n "$BUN_PATH" ]]; then
    log "symlink: /usr/local/bin/bun -> $BUN_PATH"
    ln -sf "$BUN_PATH" /usr/local/bin/bun
  else
    warn "bun não encontrado em /root/.bun/bin nem /home/*/.bun/bin"
    warn "  instale: curl -fsSL https://bun.sh/install | bash"
    warn "  ou crie o symlink manualmente: ln -sf <PATH_DO_BUN> /usr/local/bin/bun"
  fi
else
  log "/usr/local/bin/bun já existe"
fi

# ----- 2. /etc/vipcam (envs) -----
log "preparando /etc/vipcam"
mkdir -p /etc/vipcam
chown "root:$SERVICE_USER" /etc/vipcam
chmod 750 /etc/vipcam

# ----- 3. /var/log/vipcam (legacy — journald é o canal principal) -----
log "preparando /var/log/vipcam"
mkdir -p /var/log/vipcam
chown "$SERVICE_USER:$SERVICE_USER" /var/log/vipcam

# ----- 4. Diretórios de runtime gravados pelo serviço -----
log "preparando /opt/vipcamv2/{snapshots,discovery-output}"
mkdir -p "$APP_DIR/snapshots" "$APP_DIR/discovery-output"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/snapshots" "$APP_DIR/discovery-output"

# ----- 5. systemd units -----
log "instalando systemd units"
install -m 644 "$APP_DIR/infra/systemd/vipcam-edge.service" /etc/systemd/system/
install -m 644 "$APP_DIR/infra/systemd/vipcam-web.service"  /etc/systemd/system/
# vipcam-reid.service.example NÃO é instalado por padrão — Fase 6+
systemctl daemon-reload
log "  systemctl daemon-reload feito"

# ----- 6. nginx vhost (instala mas não ativa TLS — certbot é manual) -----
NGINX_AVAIL="/etc/nginx/sites-available/${DOMAIN}.conf"
NGINX_ENAB="/etc/nginx/sites-enabled/${DOMAIN}.conf"

if [[ ! -d /etc/nginx/sites-available ]]; then
  warn "/etc/nginx/sites-available/ não existe — nginx não instalado ou com layout não-Debian"
  warn "  pulando instalação do vhost; ajuste manualmente"
else
  log "instalando vhost em $NGINX_AVAIL"
  install -m 644 "$APP_DIR/infra/nginx/${DOMAIN}.conf" "$NGINX_AVAIL"

  if [[ -L "$NGINX_ENAB" ]]; then
    log "vhost já habilitado em sites-enabled"
  else
    warn "vhost NÃO ativado automaticamente — referencia certs que ainda não existem"
    warn "  Ative só APÓS gerar certs (passo 4 abaixo):"
    warn "  ln -sf $NGINX_AVAIL $NGINX_ENAB && nginx -t && systemctl reload nginx"
  fi
fi

# ----- 7. Verificação final + próximos passos -----
echo ""
log "═══════════════════════════════════════════════════════════════════"
log "✓ install completo. Próximos passos manuais:"
log "═══════════════════════════════════════════════════════════════════"
log ""
log "1. Crie os env files (NÃO faça commit):"
log "   sudo cp $APP_DIR/infra/env-templates/edge.env.example /etc/vipcam/edge.env"
log "   sudo cp $APP_DIR/infra/env-templates/web.env.example  /etc/vipcam/web.env"
log "   sudo chmod 640 /etc/vipcam/edge.env"
log "   sudo nano /etc/vipcam/edge.env   # preencher API_KEY, DATABASE_URL, etc"
log ""
log "2. Suba o Postgres (na própria máquina, via docker-compose):"
log "   cd $APP_DIR && docker compose up -d postgres"
log ""
log "3. Obtenha cert TLS (Let's Encrypt):"
log "   sudo certbot certonly --webroot -w /var/www/letsencrypt -d $DOMAIN"
log "   (ou: sudo certbot --nginx -d $DOMAIN  — se preferir auto-config)"
log ""
log "4. Ative o vhost no nginx:"
log "   sudo ln -sf $NGINX_AVAIL $NGINX_ENAB"
log "   sudo nginx -t && sudo systemctl reload nginx"
log ""
log "5. Habilite e suba os serviços:"
log "   sudo systemctl enable --now vipcam-edge vipcam-web"
log ""
log "6. Faça o primeiro deploy + health check:"
log "   sudo $APP_DIR/scripts/deploy.sh"
log ""
log "Verificação:"
log "   curl -i https://$DOMAIN/api/health"
log "   curl -i https://$DOMAIN"
log ""
log "Logs em tempo real:"
log "   journalctl -u vipcam-edge -u vipcam-web -f"
