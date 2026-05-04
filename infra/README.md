# Deployment Guide — VIPCam

Sistema de monitoramento de câmera Dahua para Barbearia VIP, deployado em
VPS Linux compartilhado com outros sites/serviços.

- **Domínio:** `monitoramento.franquiabv.com.br`
- **Porta exposta:** `3035` (web Next.js, atrás de nginx + TLS)

## Arquitetura de portas

| Serviço | Porta | Bind | Exposição |
|---|---|---|---|
| Web (Next.js) | **3035** | `127.0.0.1` | nginx → 443 do domínio |
| Edge (Bun+Hono) | **4001** | `127.0.0.1` | nginx → `/api/*` do domínio |
| Reid (Python) | **5005** | `127.0.0.1` | só interna (Fase 6+) |
| Postgres + pgvector | **5432** | `127.0.0.1` | só interna (docker) |

> Todas as portas internas estão bound em `127.0.0.1`, então **não conflitam
> com outros serviços** do VPS e não estão acessíveis externamente. Apenas
> nginx tem acesso, via vhost dedicado para `monitoramento.franquiabv.com.br`.

## Estrutura de arquivos no VPS

```
/opt/vipcam/                          ← repo git (clonado pelo operador)
├── packages/edge        ← rodando como systemd unit vipcam-edge.service
├── packages/web         ← rodando como systemd unit vipcam-web.service
├── packages/reid        ← rodando como vipcam-reid.service (Fase 6+)
├── snapshots/           ← snapshots de face capturadas (writable pelo serviço)
├── discovery-output/    ← relatórios de discovery
└── docker-compose.yml   ← Postgres + pgvector

/etc/vipcam/                          ← env files (root:vipcam, 750)
├── edge.env             ← chmod 640 — contém API_KEY, DB_URL, CAMERA_PASS
└── web.env              ← chmod 644 — só NEXT_PUBLIC_*

/etc/systemd/system/                  ← units (instaladas pelo install.sh)
├── vipcam-edge.service
└── vipcam-web.service

/etc/nginx/sites-available/           ← vhost do domínio
└── monitoramento.franquiabv.com.br.conf
    └── linkado em sites-enabled/ APÓS obter cert TLS

/var/log/vipcam/                      ← logs legados (journald é o canal principal)
/var/log/nginx/vipcam.{access,error}.log
/etc/letsencrypt/live/monitoramento.franquiabv.com.br/  ← TLS (certbot)
```

## Primeira instalação (one-shot)

Execute como `root` (ou `sudo`) no VPS, partindo de uma máquina já com
nginx instalado e com outros sites funcionando:

```bash
# 1. Pré-requisitos do sistema (Bun, Docker, certbot)
curl -fsSL https://bun.sh/install | bash
mv ~/.bun /home/vipcam/.bun  # opcional: bun no home do service user
apt update && apt install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx

# 2. Clone o repo no caminho convencional
sudo mkdir -p /opt/vipcam
sudo chown $USER /opt/vipcam
git clone <URL_DO_REPO> /opt/vipcam
cd /opt/vipcam

# 3. Rode o instalador — cria user, dirs, systemd units, vhost (sem ativar)
sudo ./infra/install.sh

# 4. Os passos 1-6 do final do install.sh:
#    - cp env templates → /etc/vipcam/*.env e preencha
#    - docker compose up -d postgres
#    - certbot certonly --webroot ...
#    - ln vhost em sites-enabled + reload nginx
#    - systemctl enable --now vipcam-edge vipcam-web
#    - sudo /opt/vipcam/scripts/deploy.sh

# 5. Verificação
curl -i https://monitoramento.franquiabv.com.br/api/health
curl -I https://monitoramento.franquiabv.com.br
```

## Deploy regular (após mudança de código)

```bash
sudo /opt/vipcam/scripts/deploy.sh           # deploya master
sudo /opt/vipcam/scripts/deploy.sh main      # outro branch
BRANCH=feat/foo sudo /opt/vipcam/scripts/deploy.sh  # via env
```

O script faz, em ordem, com **rollback automático em falha**:

1. Snapshot da revisão atual (para rollback)
2. `git fetch + reset` para `origin/$BRANCH`
3. `bun install --frozen-lockfile`
4. `tsc --build` do `@vipcam/shared` (composite mode emite `.d.ts`)
5. `db:migrate` (skip se sem migrações ainda)
6. `next build`
7. `systemctl restart vipcam-edge vipcam-web`
8. Health check com retry (até 30s edge, 60s web)
9. **Se health falhar → reset + rebuild + restart na revisão anterior**

## Rollback manual

```bash
cd /opt/vipcam
sudo -u vipcam git log --oneline -10           # escolher SHA
sudo -u vipcam git reset --hard <SHA>
sudo -u vipcam bun install --frozen-lockfile
sudo -u vipcam bash -c "cd packages/web && bun run build"
sudo systemctl restart vipcam-edge vipcam-web
```

## Logs e troubleshooting

```bash
# Logs em tempo real (combina edge + web)
journalctl -u vipcam-edge -u vipcam-web -f

# Últimas 100 linhas de cada
journalctl -u vipcam-edge -n 100 --no-pager
journalctl -u vipcam-web  -n 100 --no-pager

# Logs do nginx específicos do VIPCam
tail -f /var/log/nginx/vipcam.access.log
tail -f /var/log/nginx/vipcam.error.log

# Status dos serviços
systemctl status vipcam-edge vipcam-web

# Health check manual
curl -i http://127.0.0.1:4001/api/health   # edge direto
curl -i http://127.0.0.1:3035              # web direto
curl -i https://monitoramento.franquiabv.com.br/api/health   # via nginx + TLS
```

## Renovação automática do TLS

Certbot deve ter cron/timer já ativo após `certbot --nginx`:

```bash
systemctl status certbot.timer
# Se não, criar:
echo "0 3 * * * root certbot renew --quiet --post-hook 'systemctl reload nginx'" \
  > /etc/cron.d/certbot-vipcam
```

## Coexistência com outros serviços do VPS

VIPCam **não interfere** com outros sites:

- **Portas:** todas internas (3035, 4001, 5005, 5432) bound em `127.0.0.1`
- **nginx:** vhost dedicado por `server_name monitoramento.franquiabv.com.br`
  (não pega tráfego de outros domínios)
- **systemd:** units no namespace `vipcam-*` (sem colisão)
- **filesystem:** todos os artefatos em `/opt/vipcam`, `/etc/vipcam`,
  `/var/log/vipcam` (sem espalhar)
- **usuário:** processo roda como `vipcam` (não-privilegiado)

Para remover completamente o VIPCam do VPS:

```bash
sudo systemctl disable --now vipcam-edge vipcam-web
sudo rm /etc/systemd/system/vipcam-*.service
sudo systemctl daemon-reload
sudo rm /etc/nginx/sites-enabled/monitoramento.franquiabv.com.br.conf
sudo rm /etc/nginx/sites-available/monitoramento.franquiabv.com.br.conf
sudo nginx -t && sudo systemctl reload nginx
sudo certbot delete --cert-name monitoramento.franquiabv.com.br  # opcional
docker compose -f /opt/vipcam/docker-compose.yml down -v
sudo userdel -r vipcam
sudo rm -rf /opt/vipcam /etc/vipcam /var/log/vipcam
```
