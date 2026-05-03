#!/usr/bin/env bash
set -euo pipefail

# Bootstrap .env.local do edge se ausente (config local mínima para subir)
if [ ! -f packages/edge/.env.local ]; then
  echo "[dev] criando packages/edge/.env.local a partir do .env.example"
  cp packages/edge/.env.example packages/edge/.env.local
fi

# Sobe Postgres se não estiver up
if ! docker compose ps postgres --status running --quiet | grep -q .; then
  echo "[dev] subindo postgres..."
  docker compose up -d postgres
fi

# Aguarda Postgres healthy
echo "[dev] aguardando postgres..."
for _ in {1..30}; do
  if docker compose ps postgres --format json 2>/dev/null | grep -q '"Health":"healthy"'; then
    break
  fi
  sleep 1
done

# Sobe edge e web em paralelo, com prefixo nos logs
trap 'kill 0' EXIT INT TERM
( cd packages/edge && bun run dev 2>&1 | sed -e 's/^/[edge] /' ) &
( cd packages/web  && bun run dev 2>&1 | sed -e 's/^/[web ] /' ) &
wait
