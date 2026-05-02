# Onda 1 — Scaffolding + Discovery (Fases 0 + 1) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Estabelecer o monorepo executável (Fase 0) e implementar o discovery prober que mapeia empiricamente o que a câmera Dahua DH-IPC-HFW5442T-ASE entrega via API (Fase 1). O resultado é um relatório que confirma ou refuta as premissas do design e desbloqueia o resto do projeto.

**Architecture:** Monorepo Bun com 4 workspaces (`shared`, `edge`, `web`, `reid`). Backend Bun+Hono expõe endpoints de discovery; frontend Next.js mostra o relatório; sidecar Python só com hello-world por enquanto. Postgres+pgvector via docker-compose. Discovery faz probe contra a câmera real e salva tudo (raw payloads + relatório markdown).

**Tech Stack:** Bun 1.x, Hono 4, Next.js 14 (App Router), Tailwind 3, shadcn/ui, Drizzle ORM (instalado mas não usado nesta onda), PostgreSQL 16 + pgvector, Python 3.11 + FastAPI + uv, Biome (lint+format), Pino (logs), Zod (validação), Vitest+Testing Library (frontend), Bun test (backend), testcontainers + msw (integration).

**Spec referenciada:** `docs/superpowers/specs/2026-04-29-camera-monitoring-design.md` — leia antes de começar.

**Skills referenciadas durante execução:**
- @superpowers:test-driven-development (módulos de regra de negócio)
- @superpowers:verification-before-completion (antes de declarar tarefa completa)
- @superpowers:systematic-debugging (quando algo quebrar)

**Pré-requisitos no ambiente:**
- Bun ≥1.1 instalado
- Docker Desktop rodando
- Python 3.11 + `uv` instalado
- Acesso de rede à câmera DH-IPC-HFW5442T-ASE com IP, usuário e senha admin
- Git configurado

**⚠ Plataforma:** o ambiente alvo é **Windows 11 com Git Bash**. Todos os comandos shell deste plano (incluindo `bun run dev &`, `kill %1`, `chmod +x`, `cp`, `sed`) assumem **bash**. Em PowerShell esses comandos falham; rode todas as etapas via Git Bash ou WSL.

---

## Chunk 0: Fase 0 — Scaffolding

Esta seção entrega um repositório executável onde `bun dev` sobe edge, web e Postgres juntos. Nada de lógica de negócio ainda — só esqueleto e contratos.

### Task 0.1: Inicializar workspaces na raiz

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `biome.json`
- Create: `.env.example`
- Create: `bunfig.toml`

- [ ] **Step 1: Criar `package.json` raiz com workspaces**

```json
{
  "name": "vipcam",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "dev": "bash scripts/dev.sh",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "format": "biome format --write .",
    "typecheck": "bun --filter '*' typecheck"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.4",
    "typescript": "^5.5.4"
  },
  "engines": {
    "bun": ">=1.1.0"
  }
}
```

- [ ] **Step 2: Criar `tsconfig.base.json` (config compartilhada)**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": false,
    "allowJs": false,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 3: Criar `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": { "noNonNullAssertion": "warn" },
      "suspicious": { "noExplicitAny": "warn" },
      "complexity": { "noUselessTypeConstraint": "off" }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "files": {
    "ignore": ["**/node_modules/**", "**/dist/**", "**/.next/**", "packages/reid/**"]
  }
}
```

- [ ] **Step 4: Criar `.env.example`**

```bash
# Backend (edge)
EDGE_PORT=4000
LOG_LEVEL=info
API_KEY=change-me-local-only

# Database (preenchido depois nas Fases 2+)
DATABASE_URL=postgres://vipcam:vipcam@localhost:5432/vipcam

# Camera (preenchido na Fase 1 antes de rodar discovery)
CAMERA_IP=
CAMERA_USER=admin
CAMERA_PASS=

# Web
NEXT_PUBLIC_API_URL=http://localhost:4000
```

- [ ] **Step 5: Criar `bunfig.toml`**

```toml
[install]
exact = true
```

- [ ] **Step 6: Instalar deps e verificar**

Run: `bun install`
Expected: Bun cria `bun.lockb` e `node_modules` na raiz, sem erros.

Run: `bunx biome check .`
Expected: passa sem nada a checar (ainda não há código).

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.base.json biome.json .env.example bunfig.toml bun.lockb
git commit -m "chore: init monorepo workspaces with biome and base tsconfig"
```

---

### Task 0.2: Criar pacote `packages/shared`

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/types/index.ts`

- [ ] **Step 1: Criar `packages/shared/package.json`**

```json
{
  "name": "@vipcam/shared",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./types": "./src/types/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "typescript": "^5.5.4"
  }
}
```

- [ ] **Step 2: Criar `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Criar `packages/shared/src/types/index.ts` (stub mínimo)**

```typescript
// Tipos de domínio compartilhados entre edge e web.
// Esta onda só tem stubs; entidades reais (Person, Detection, Session) entram nas Fases 2+.

export type ISO8601 = string;
export type UUID = string;

// Health response usado pela Fase 0 e expandido nas Fases 2+.
export interface HealthCheck {
  ok: boolean;
  latency_ms?: number;
  error?: string;
}

export interface HealthResponse {
  status: "healthy" | "degraded" | "down";
  uptime_seconds: number;
  checks: Record<string, HealthCheck>;
}
```

- [ ] **Step 4: Criar `packages/shared/src/index.ts`**

```typescript
export * from "./types/index.js";
```

- [ ] **Step 5: Instalar dep e verificar typecheck**

Run: `bun install`
Run: `cd packages/shared && bun run typecheck`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/
git commit -m "feat(shared): scaffold @vipcam/shared package with health types"
```

---

### Task 0.3: Criar pacote `packages/edge` com Hono hello-world

**Files:**
- Create: `packages/edge/package.json`
- Create: `packages/edge/tsconfig.json`
- Create: `packages/edge/.env.example`
- Create: `packages/edge/src/main.ts`
- Create: `packages/edge/src/config/env.ts`
- Create: `packages/edge/src/api/server.ts`
- Create: `packages/edge/src/obs/logger.ts`
- Create: `packages/edge/tests/unit/config/env.test.ts`

- [ ] **Step 1: Criar `packages/edge/package.json`**

```json
{
  "name": "@vipcam/edge",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/main.ts",
    "start": "bun src/main.ts",
    "test": "bun test",
    "test:watch": "bun test --watch",
    "typecheck": "bun --bun tsc --noEmit"
  },
  "dependencies": {
    "@vipcam/shared": "workspace:*",
    "hono": "^4.6.3",
    "pino": "^9.4.0",
    "pino-pretty": "^11.2.2",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/bun": "latest"
  }
}
```

- [ ] **Step 2: Criar `packages/edge/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": ".",
    "types": ["bun"],
    "moduleResolution": "bundler",
    "noEmit": true
  },
  "include": ["src/**/*", "tests/**/*"],
  "references": [{ "path": "../shared" }]
}
```

> **Nota:** `"types": ["bun"]` casa com o pacote `@types/bun` instalado via devDependencies (que exporta o módulo `bun`, não `bun-types`).

- [ ] **Step 3: Criar `packages/edge/.env.example`**

```bash
EDGE_PORT=4000
LOG_LEVEL=info
NODE_ENV=development
API_KEY=change-me-local-only
```

- [ ] **Step 4: Criar `packages/edge/src/obs/logger.ts`**

```typescript
import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  ...(isDev && {
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss.l" },
    },
  }),
});

export type Logger = typeof logger;
```

- [ ] **Step 5: TDD — Escrever teste para validação de env**

```typescript
// packages/edge/tests/unit/config/env.test.ts
import { describe, expect, test } from "bun:test";
import { parseEnv } from "../../../src/config/env.js";

describe("parseEnv", () => {
  test("retorna config válida quando vars obrigatórias estão presentes", () => {
    const result = parseEnv({
      EDGE_PORT: "4000",
      LOG_LEVEL: "info",
      NODE_ENV: "development",
      API_KEY: "test-key",
    });
    expect(result.EDGE_PORT).toBe(4000);
    expect(result.API_KEY).toBe("test-key");
  });

  test("aplica defaults quando vars opcionais ausentes", () => {
    const result = parseEnv({ API_KEY: "test-key" });
    expect(result.EDGE_PORT).toBe(4000);
    expect(result.LOG_LEVEL).toBe("info");
    expect(result.NODE_ENV).toBe("development");
  });

  test("lança erro quando API_KEY ausente", () => {
    expect(() => parseEnv({})).toThrow(/API_KEY/);
  });

  test("lança erro quando EDGE_PORT não é numérico", () => {
    expect(() => parseEnv({ API_KEY: "k", EDGE_PORT: "abc" })).toThrow();
  });
});
```

- [ ] **Step 6: Rodar teste e confirmar que falha**

Run: `cd packages/edge && bun test tests/unit/config/env.test.ts`
Expected: FAIL com erro "Cannot find module '../../../src/config/env.js'".

- [ ] **Step 7: Implementar `packages/edge/src/config/env.ts`**

```typescript
import { z } from "zod";

const envSchema = z.object({
  EDGE_PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_KEY: z.string().min(1, "API_KEY is required"),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(raw: NodeJS.ProcessEnv | Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid environment: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return result.data;
}

// Lazy singleton: parsing só acontece quando getEnv() é chamado pela primeira vez.
// Isso evita que o load do módulo (ex: pelo test runner importando parseEnv)
// dispare validação contra `process.env` real, que pode não ter API_KEY definido.
let _env: Env | undefined;

export function getEnv(): Env {
  if (!_env) _env = parseEnv(process.env);
  return _env;
}

/**
 * Reseta o singleton — útil em testes que precisam re-validar com process.env mockado.
 * Não usar em código de produção.
 */
export function resetEnvCache(): void {
  _env = undefined;
}
```

> **Nota da Onda 1 review:** o eager `export const env = parseEnv(process.env)` foi descartado porque qualquer import do módulo (incluindo o test runner importando apenas `parseEnv`) disparava a validação contra `process.env`, fazendo `bun test` falhar quando `API_KEY` não estava setado. A versão lazy mantém validação fail-fast no startup do server (`main.ts` chama `getEnv()` imediatamente) sem prejudicar testes ou imports puros.

- [ ] **Step 8: Rodar teste e confirmar que passa**

Run: `cd packages/edge && bun test tests/unit/config/env.test.ts`
Expected: 4 tests pass.

- [ ] **Step 9: Criar `packages/edge/src/api/server.ts` (Hono app)**

```typescript
import { Hono } from "hono";
import { logger as appLogger } from "../obs/logger.js";
import type { HealthResponse } from "@vipcam/shared";

export function createServer() {
  const app = new Hono();
  const startedAt = Date.now();

  app.get("/api/health", (c) => {
    const body: HealthResponse = {
      status: "healthy",
      uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
      checks: {
        edge: { ok: true },
      },
    };
    return c.json(body);
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.onError((err, c) => {
    appLogger.error({ err }, "unhandled error");
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
```

- [ ] **Step 10: Criar `packages/edge/src/main.ts`**

```typescript
import { getEnv } from "./config/env.js";
import { logger } from "./obs/logger.js";
import { createServer } from "./api/server.js";

const env = getEnv();
const app = createServer();

const server = Bun.serve({
  port: env.EDGE_PORT,
  fetch: app.fetch,
});

logger.info(
  { port: server.port, env: env.NODE_ENV },
  `vipcam-edge listening on http://localhost:${server.port}`,
);

// Graceful shutdown
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutting down");
    server.stop();
    process.exit(0);
  });
}
```

- [ ] **Step 11: Verificar smoke test do servidor**

Run: `cd packages/edge && cp .env.example .env.local && API_KEY=local bun src/main.ts &`
Wait 1s, then: `curl -s http://localhost:4000/api/health | jq`
Expected: JSON `{ "status": "healthy", "uptime_seconds": 0, "checks": { "edge": { "ok": true } } }`.
Then: `kill %1`

- [ ] **Step 12: Commit**

```bash
git add packages/edge/ bun.lockb
git commit -m "feat(edge): scaffold Bun+Hono server with /api/health and env validation"
```

---

### Task 0.4: Criar pacote `packages/web` (Next.js 14)

**Files:**
- Create: `packages/web/package.json`
- Create: `packages/web/tsconfig.json`
- Create: `packages/web/next.config.js`
- Create: `packages/web/tailwind.config.ts`
- Create: `packages/web/postcss.config.js`
- Create: `packages/web/src/app/layout.tsx`
- Create: `packages/web/src/app/page.tsx`
- Create: `packages/web/src/app/globals.css`

- [ ] **Step 1: Criar `packages/web/package.json`**

```json
{
  "name": "@vipcam/web",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "next dev -p 3000",
    "build": "next build",
    "start": "next start -p 3000",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@vipcam/shared": "workspace:*",
    "next": "14.2.15",
    "react": "18.3.1",
    "react-dom": "18.3.1"
  },
  "devDependencies": {
    "@types/node": "^22.7.4",
    "@types/react": "^18.3.11",
    "@types/react-dom": "^18.3.0",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.47",
    "tailwindcss": "^3.4.13"
  }
}
```

- [ ] **Step 2: Criar `packages/web/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] },
    "moduleResolution": "bundler",
    "noEmit": true
  },
  "include": ["next-env.d.ts", "src/**/*", ".next/types/**/*.ts"],
  "exclude": ["node_modules"],
  "references": [{ "path": "../shared" }]
}
```

- [ ] **Step 3: Criar `packages/web/next.config.js`**

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: { typedRoutes: true },
  transpilePackages: ["@vipcam/shared"],
};

export default nextConfig;
```

- [ ] **Step 4: Criar `packages/web/tailwind.config.ts`**

```typescript
import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
```

- [ ] **Step 5: Criar `packages/web/postcss.config.js`**

```javascript
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
```

- [ ] **Step 6: Criar `packages/web/src/app/globals.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

html, body { height: 100%; }
body { @apply bg-neutral-50 text-neutral-900 antialiased; }
```

- [ ] **Step 7: Criar `packages/web/src/app/layout.tsx`**

```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VIPCam",
  description: "Monitoramento Barbearia VIP",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 8: Criar `packages/web/src/app/page.tsx`**

```tsx
export default function HomePage() {
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">VIPCam</h1>
      <p className="mt-2 text-neutral-600">
        Scaffolding pronto. Páginas reais entram nas Fases 3+.
      </p>
    </main>
  );
}
```

- [ ] **Step 9: Instalar deps e gerar next-env**

Run: `bun install`
Run: `cd packages/web && bun run next telemetry disable && bun run next build`
Expected: build succeeds (pode imprimir warnings sobre App Router edge cases — ok). Cria `next-env.d.ts`.

- [ ] **Step 10: Smoke test do dev server**

Run: `cd packages/web && bun run dev &`
Wait 5s, then: `curl -s http://localhost:3000 | grep -o 'VIPCam' | head -1`
Expected: prints `VIPCam`.
Then: `kill %1`

- [ ] **Step 11: Commit**

```bash
git add packages/web/ bun.lockb
git commit -m "feat(web): scaffold Next.js 14 with Tailwind and shared types"
```

---

### Task 0.5: Criar sidecar `packages/reid` (Python stub)

Apenas hello-world por enquanto. A implementação real vem na Fase 6.

**Files:**
- Create: `packages/reid/pyproject.toml`
- Create: `packages/reid/src/main.py`
- Create: `packages/reid/.python-version`

- [ ] **Step 1: Criar `packages/reid/pyproject.toml`**

```toml
[project]
name = "vipcam-reid"
version = "0.0.0"
description = "Sidecar de re-identificação facial (InsightFace CPU). Stub na Onda 1."
requires-python = ">=3.11,<3.13"
dependencies = [
  "fastapi>=0.115.0",
  "uvicorn[standard]>=0.31.0",
  "pydantic>=2.9.0",
]

[tool.uv]
dev-dependencies = [
  "pytest>=8.3.0",
  "httpx>=0.27.0",
]
```

- [ ] **Step 2: Criar `packages/reid/.python-version`**

```
3.11
```

- [ ] **Step 3: Criar `packages/reid/src/main.py`**

```python
"""vipcam-reid sidecar — stub na Onda 1, expansão real na Fase 6."""
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="vipcam-reid", version="0.0.0")


class HealthResponse(BaseModel):
    status: str
    version: str


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="healthy", version="0.0.0")
```

- [ ] **Step 4: Setup uv venv e smoke test**

Run: `cd packages/reid && uv sync`
Expected: cria `.venv/` com FastAPI instalado.

Run: `cd packages/reid && uv run uvicorn src.main:app --port 5005 &`
Wait 2s, then: `curl -s http://localhost:5005/health`
Expected: `{"status":"healthy","version":"0.0.0"}`.
Then: `kill %1`

- [ ] **Step 5: Garantir que `.gitignore` raiz cobre artefatos Python do reid**

O `.gitignore` raiz foi criado durante o brainstorming e já cobre `node_modules/`, `.next/`, `dist/`, `.env`, `.env.local`. Estender para artefatos do sidecar Python:

Run: `cat .gitignore` para inspecionar. Adicionar (se ausentes):

```
packages/reid/.venv/
packages/reid/**/__pycache__/
*.pyc
```

Editar `.gitignore` na raiz acrescentando essas linhas. Confirmar via:

Run: `git check-ignore packages/reid/.venv && echo "ignored ok"`
Expected: imprime `packages/reid/.venv` e `ignored ok`.

- [ ] **Step 6: Commit**

```bash
git add packages/reid/ .gitignore
git commit -m "feat(reid): scaffold Python FastAPI sidecar stub (real impl in Fase 6)"
```

---

### Task 0.6: Docker compose (Postgres + pgvector)

**Files:**
- Create: `docker-compose.yml`
- Create: `infra/postgres/init.sql`

- [ ] **Step 1: Criar `infra/postgres/init.sql`**

```sql
-- Habilita pgvector já no init para que migrações da Fase 2 só precisem CREATE TABLE.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

- [ ] **Step 2: Criar `docker-compose.yml`**

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    container_name: vipcam-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: vipcam
      POSTGRES_PASSWORD: vipcam
      POSTGRES_DB: vipcam
    ports:
      - "5432:5432"
    volumes:
      - vipcam-pgdata:/var/lib/postgresql/data
      - ./infra/postgres/init.sql:/docker-entrypoint-initdb.d/00-init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U vipcam -d vipcam"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  vipcam-pgdata:
```

- [ ] **Step 3: Subir Postgres e verificar pgvector**

Run: `docker compose up -d postgres`
Wait until healthy: `docker compose ps postgres` (`STATUS = healthy`).

Run: `docker exec vipcam-postgres psql -U vipcam -d vipcam -c "SELECT extname FROM pg_extension WHERE extname IN ('vector','pgcrypto');"`
Expected: lista as duas extensões.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml infra/postgres/init.sql
git commit -m "chore: add docker-compose with pgvector-enabled postgres"
```

---

### Task 0.7: Script `scripts/dev.sh` e smoke test integrado

**Files:**
- Create: `scripts/dev.sh`

- [ ] **Step 1: Criar `scripts/dev.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

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
```

- [ ] **Step 2: Tornar executável**

Run: `chmod +x scripts/dev.sh`

- [ ] **Step 3: Smoke test full-stack**

Garantir `.env.local` em packages/edge: `cp packages/edge/.env.example packages/edge/.env.local`

Run: `bun run dev &`
Wait 8s, then em paralelo:
- `curl -s http://localhost:4000/api/health`
- `curl -s http://localhost:3000 | grep -o 'VIPCam'`

Expected: backend retorna JSON saudável; frontend retorna `VIPCam`.
Then: `kill %1`; `docker compose down`

- [ ] **Step 4: Commit**

```bash
git add scripts/dev.sh
git commit -m "chore: add dev script that boots postgres + edge + web"
```

---

### Task 0.8: Verificação final da Fase 0

Aplique @superpowers:verification-before-completion antes de declarar a Fase 0 completa.

- [ ] **Step 1: Rodar typecheck completo**

Run: `bun run typecheck`
Expected: passa sem erros.

- [ ] **Step 2: Rodar lint**

Run: `bun run lint`
Expected: zero issues (ou só avisos aceitáveis, sem errors).

- [ ] **Step 3: Rodar testes do edge**

Run: `cd packages/edge && bun test`
Expected: 4 testes do `env.test.ts` passam.

- [ ] **Step 4: Verificar build do web**

Run: `cd packages/web && bun run build`
Expected: build succeeds.

- [ ] **Step 5: Smoke test final via dev.sh**

Já validado na Task 0.7 Step 3. Confirmar uma última vez se nada quebrou desde então:

Run: `bun run dev &`
Wait 8s, then:
- `curl -fs http://localhost:4000/api/health > /dev/null && echo "edge ok"`
- `curl -fs http://localhost:3000 > /dev/null && echo "web ok"`
- `docker exec vipcam-postgres pg_isready -U vipcam && echo "postgres ok"`

Expected: três `ok`.
Then: `kill %1`

- [ ] **Step 6: Commit final da Fase 0 (se houver tweaks remanescentes)**

Se nada mudou, pular. Se algo mudou:
```bash
git add -A
git commit -m "chore: phase 0 verification tweaks"
```

**Checkpoint Fase 0 atingido:** `bun run dev` sobe Postgres + edge + web. `/api/health` responde. Próxima fase (Discovery) já tem onde plugar código.

---

## Chunk 1A: Fase 1 — HTTP client + probes + capture + report (lógica pura)

Implementa as peças de discovery testáveis em isolamento: cliente HTTP Dahua com Digest auth, orquestrador de probes, probes individuais por endpoint, captura de eventos multipart e gerador de relatório. Tudo TDD-able sem câmera real.

⚠ **As tarefas deste chunk são independentes de hardware.** Rodam contra mocks/fakes. Acesso à câmera real só na próxima parte (Chunk 1B).

### Task 1.1: Adicionar config da câmera ao env

**Files:**
- Modify: `packages/edge/src/config/env.ts`
- Modify: `packages/edge/.env.example`
- Modify: `packages/edge/tests/unit/config/env.test.ts`

- [ ] **Step 1: TDD — Estender testes de env para incluir camera config**

Adicionar ao `packages/edge/tests/unit/config/env.test.ts`:

```typescript
test("aceita config de câmera quando todas as vars presentes", () => {
  const result = parseEnv({
    API_KEY: "k",
    CAMERA_IP: "192.168.1.108",
    CAMERA_USER: "admin",
    CAMERA_PASS: "secret",
  });
  expect(result.CAMERA_IP).toBe("192.168.1.108");
  expect(result.CAMERA_USER).toBe("admin");
});

test("permite config de câmera ausente (modo discovery offline)", () => {
  const result = parseEnv({ API_KEY: "k" });
  expect(result.CAMERA_IP).toBeUndefined();
});

test("rejeita CAMERA_IP malformado", () => {
  expect(() =>
    parseEnv({ API_KEY: "k", CAMERA_IP: "not-an-ip", CAMERA_USER: "a", CAMERA_PASS: "b" }),
  ).toThrow();
});
```

- [ ] **Step 2: Rodar e confirmar falhas**

Run: `cd packages/edge && bun test tests/unit/config/env.test.ts`
Expected: 3 novos testes falham com algo como `CAMERA_IP is undefined / unknown property`.

- [ ] **Step 3: Estender `packages/edge/src/config/env.ts`**

Substituir o bloco `envSchema`:

```typescript
const envSchema = z
  .object({
    EDGE_PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    API_KEY: z.string().min(1, "API_KEY is required"),
    // Camera (opcional — quando ausente, discovery roda em modo offline para testes)
    CAMERA_IP: z
      .string()
      .regex(/^(\d{1,3}\.){3}\d{1,3}$/, "CAMERA_IP must be a valid IPv4")
      .optional(),
    CAMERA_USER: z.string().optional(),
    CAMERA_PASS: z.string().optional(),
  })
  .refine(
    (v) =>
      (v.CAMERA_IP && v.CAMERA_USER && v.CAMERA_PASS) ||
      (!v.CAMERA_IP && !v.CAMERA_USER && !v.CAMERA_PASS),
    { message: "CAMERA_IP/USER/PASS must be all set or all unset" },
  );
```

- [ ] **Step 4: Atualizar `packages/edge/.env.example`**

```bash
EDGE_PORT=4000
LOG_LEVEL=info
NODE_ENV=development
API_KEY=change-me-local-only

# Camera (preencher antes de rodar discovery)
# CAMERA_IP=192.168.1.108
# CAMERA_USER=admin
# CAMERA_PASS=
```

- [ ] **Step 5: Rodar testes e confirmar que passam**

Run: `cd packages/edge && bun test tests/unit/config/env.test.ts`
Expected: todos os testes do `env.test.ts` passam — 4 originais (validação básica) + 3 novos (camera config), totalizando **7 testes**.

- [ ] **Step 6: Commit**

```bash
git add packages/edge/
git commit -m "feat(edge): add optional camera config (IP/user/pass) to env schema"
```

---

### Task 1.2: Cliente HTTP Dahua com Digest auth

A maioria dos endpoints CGI da Dahua usa HTTP Digest. Bun `fetch` não tem Digest nativo; vamos implementar um wrapper minimalista (a especificação RFC 7616 aplicada só ao subset que a Dahua usa: MD5, qop=auth).

**Files:**
- Create: `packages/edge/src/ingest/dahua-http-client.ts`
- Create: `packages/edge/tests/unit/ingest/dahua-http-client.test.ts`

- [ ] **Step 1: TDD — Teste do parser do header `WWW-Authenticate`**

```typescript
// packages/edge/tests/unit/ingest/dahua-http-client.test.ts
import { describe, expect, test } from "bun:test";
import { parseDigestChallenge, buildDigestHeader } from "../../../src/ingest/dahua-http-client.js";

describe("parseDigestChallenge", () => {
  test("extrai realm, nonce, qop de um header Digest válido", () => {
    const header =
      'Digest realm="LoginToDevice", qop="auth", nonce="abc123", opaque="xyz", algorithm=MD5';
    const c = parseDigestChallenge(header);
    expect(c.realm).toBe("LoginToDevice");
    expect(c.nonce).toBe("abc123");
    expect(c.qop).toBe("auth");
    expect(c.opaque).toBe("xyz");
    expect(c.algorithm).toBe("MD5");
  });

  test("retorna null quando o header não é Digest", () => {
    expect(parseDigestChallenge("Basic realm=foo")).toBeNull();
    expect(parseDigestChallenge("")).toBeNull();
  });
});

describe("buildDigestHeader", () => {
  test("produz header Authorization válido a partir do challenge", () => {
    const challenge = {
      realm: "LoginToDevice",
      nonce: "abc123",
      qop: "auth",
      opaque: "xyz",
      algorithm: "MD5" as const,
    };
    const header = buildDigestHeader({
      challenge,
      method: "GET",
      uri: "/cgi-bin/magicBox.cgi?action=getSystemInfo",
      username: "admin",
      password: "pass",
      cnonce: "0a4f113b",
      nc: 1,
    });
    expect(header).toContain('username="admin"');
    expect(header).toContain('realm="LoginToDevice"');
    expect(header).toContain('nonce="abc123"');
    expect(header).toContain("nc=00000001");
    expect(header).toContain('cnonce="0a4f113b"');
    expect(header).toContain('qop=auth');
    // response é um hash MD5 deterministico
    expect(header).toMatch(/response="[a-f0-9]{32}"/);
  });

  test("calcula response com vetor conhecido (RFC 7616 §3.9.1 adaptado)", () => {
    // Vetor: HA1 = md5("Mufasa:testrealm@host.com:Circle Of Life") = "939e7578ed9e3c518a452acee763bce9"
    // HA2  = md5("GET:/dir/index.html") = "39aff3a2bab6126f332b942af96d3366"
    // response = md5(HA1 + ":" + nonce + ":" + nc + ":" + cnonce + ":" + qop + ":" + HA2)
    //         = md5("939e7578ed9e3c518a452acee763bce9:dcd98b7102dd2f0e8b11d0f600bfb0c093:00000001:0a4f113b:auth:39aff3a2bab6126f332b942af96d3366")
    //         = "6629fae49393a05397450978507c4ef1"
    const header = buildDigestHeader({
      challenge: {
        realm: "testrealm@host.com",
        nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093",
        qop: "auth",
      },
      method: "GET",
      uri: "/dir/index.html",
      username: "Mufasa",
      password: "Circle Of Life",
      cnonce: "0a4f113b",
      nc: 1,
    });
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
  });
});
```

- [ ] **Step 2: Confirmar falha**

Run: `cd packages/edge && bun test tests/unit/ingest/dahua-http-client.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar `packages/edge/src/ingest/dahua-http-client.ts`**

```typescript
import { createHash, randomBytes } from "node:crypto";
import { logger } from "../obs/logger.js";

export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  // String aberta porque servidores podem retornar MD5, MD5-sess, SHA-256 etc.
  // Implementação atual só suporta MD5 / MD5-sess (Dahua); validamos no buildDigestHeader.
  algorithm?: string;
}

export function parseDigestChallenge(headerValue: string): DigestChallenge | null {
  if (!headerValue || !headerValue.toLowerCase().startsWith("digest ")) return null;
  const params = headerValue.slice(7);
  const out: Record<string, string> = {};
  // Match "key=value" or 'key="value"'
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(params)) !== null) {
    out[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? "";
  }
  if (!out.realm || !out.nonce) return null;
  return {
    realm: out.realm,
    nonce: out.nonce,
    qop: out.qop,
    opaque: out.opaque,
    algorithm: out.algorithm ?? "MD5",
  };
}

interface BuildArgs {
  challenge: DigestChallenge;
  method: string;
  uri: string;
  username: string;
  password: string;
  cnonce: string;
  nc: number;
}

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

export function buildDigestHeader(a: BuildArgs): string {
  const ha1 = md5(`${a.username}:${a.challenge.realm}:${a.password}`);
  const ha2 = md5(`${a.method}:${a.uri}`);
  const ncHex = a.nc.toString(16).padStart(8, "0");
  const qop = a.challenge.qop?.split(",")[0]?.trim() ?? "auth";
  const response = md5(`${ha1}:${a.challenge.nonce}:${ncHex}:${a.cnonce}:${qop}:${ha2}`);

  const parts = [
    `username="${a.username}"`,
    `realm="${a.challenge.realm}"`,
    `nonce="${a.challenge.nonce}"`,
    `uri="${a.uri}"`,
    `algorithm=${a.challenge.algorithm ?? "MD5"}`,
    `response="${response}"`,
    `qop=${qop}`,
    `nc=${ncHex}`,
    `cnonce="${a.cnonce}"`,
  ];
  if (a.challenge.opaque) parts.push(`opaque="${a.challenge.opaque}"`);
  return `Digest ${parts.join(", ")}`;
}

export interface DahuaClientConfig {
  baseUrl: string; // http://192.168.x.x
  username: string;
  password: string;
  timeoutMs?: number; // timeout default para chamadas curtas
}

export interface RequestOptions {
  /** Timeout customizado (ms). Use `null` para desabilitar (long-polling). */
  timeoutMs?: number | null;
  /** AbortSignal externo (precedência sobre timeoutMs). */
  signal?: AbortSignal;
}

export class DahuaHttpClient {
  private cfg: DahuaClientConfig;
  private cachedChallenge: DigestChallenge | null = null;
  private nc = 0;

  constructor(cfg: DahuaClientConfig) {
    this.cfg = { timeoutMs: 10_000, ...cfg };
  }

  /**
   * Faz GET com Digest auth. Tenta sem auth primeiro, captura o 401, refaz com Digest.
   * Cacheia o challenge para chamadas subsequentes (Dahua aceita reuso por uns minutos).
   *
   * `opts.timeoutMs = null` desabilita o timeout (necessário para long-polling do
   * eventManager attach que dura minutos).
   */
  async get(path: string, opts: RequestOptions = {}): Promise<Response> {
    const url = `${this.cfg.baseUrl}${path}`;
    const signal = this.resolveSignal(opts);

    if (this.cachedChallenge) {
      const auth = this.makeAuthHeader("GET", path);
      const r = await fetch(url, { headers: { Authorization: auth }, signal });
      if (r.status !== 401) return r;
      // challenge expirou ou stale — refaz fluxo completo e reseta nc
      await r.body?.cancel().catch(() => {});
      this.cachedChallenge = null;
      this.nc = 0;
    }

    // 1ª tentativa: sem auth, esperando 401 com challenge
    const r1 = await fetch(url, { signal });
    if (r1.status !== 401) return r1;

    const challengeHeader = r1.headers.get("www-authenticate");
    const challenge = parseDigestChallenge(challengeHeader ?? "");
    if (!challenge) {
      logger.warn({ path, header: challengeHeader }, "no Digest challenge in 401");
      return r1;
    }
    // Drena o body do 401 antes de descartá-lo
    await r1.body?.cancel().catch(() => {});
    this.cachedChallenge = challenge;
    this.nc = 0; // novo nonce → reset do contador (RFC 7616 §3.3)

    const auth = this.makeAuthHeader("GET", path);
    return fetch(url, { headers: { Authorization: auth }, signal });
  }

  /**
   * Variante streaming para long-polling (eventManager attach). Por padrão
   * desabilita o timeout, já que essas chamadas duram minutos.
   * Caller é responsável por gerenciar deadline via AbortSignal externo.
   */
  async getStream(path: string, opts: RequestOptions = {}): Promise<Response> {
    return this.get(path, { timeoutMs: null, ...opts });
  }

  private resolveSignal(opts: RequestOptions): AbortSignal | undefined {
    if (opts.signal) return opts.signal;
    const t = opts.timeoutMs === undefined ? this.cfg.timeoutMs : opts.timeoutMs;
    if (t === null || t === undefined) return undefined;
    return AbortSignal.timeout(t);
  }

  private makeAuthHeader(method: string, uri: string): string {
    if (!this.cachedChallenge) throw new Error("no cached challenge");
    this.nc += 1;
    const cnonce = randomBytes(8).toString("hex");
    return buildDigestHeader({
      challenge: this.cachedChallenge,
      method,
      uri,
      username: this.cfg.username,
      password: this.cfg.password,
      cnonce,
      nc: this.nc,
    });
  }
}
```

- [ ] **Step 4: Rodar testes do client**

Run: `cd packages/edge && bun test tests/unit/ingest/dahua-http-client.test.ts`
Expected: 4 testes passam (2 parser + 2 builder, sendo 1 deles o vetor conhecido com response `6629fae49393a05397450978507c4ef1`).

- [ ] **Step 5: Commit**

```bash
git add packages/edge/src/ingest/dahua-http-client.ts packages/edge/tests/unit/ingest/dahua-http-client.test.ts
git commit -m "feat(ingest): add DahuaHttpClient with HTTP Digest auth"
```

---

### Task 1.3: Tipos compartilhados de discovery e probe orquestrador

**Files:**
- Create: `packages/shared/src/types/discovery.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `packages/edge/src/discovery/types.ts`
- Create: `packages/edge/src/discovery/prober.ts`
- Create: `packages/edge/tests/unit/discovery/prober.test.ts`

- [ ] **Step 1: Definir tipos compartilhados de probe result**

```typescript
// packages/shared/src/types/discovery.ts
export type ProbeStatus = "ok" | "auth_failed" | "not_found" | "timeout" | "error" | "skipped";

export interface ProbeResult {
  name: string;             // "magicBox.getSystemInfo"
  endpoint: string;         // "/cgi-bin/magicBox.cgi?action=getSystemInfo"
  status: ProbeStatus;
  http_status?: number;
  duration_ms: number;
  raw_response_excerpt?: string; // primeiros 1000 chars
  error?: string;
  parsed?: unknown;         // se conseguimos extrair algo estruturado
}

export interface DiscoveryReport {
  generated_at: string;       // ISO
  camera_ip: string;
  camera_model?: string;      // se conseguir extrair
  camera_serial?: string;
  firmware?: string;
  probes: ProbeResult[];
  events_captured: number;
  capture_duration_seconds: number;
  event_types_seen: Record<string, number>; // type -> count
  attribute_keys_seen: string[];            // chaves vistas em payloads de face
  has_emotion_attribute: boolean;
  has_age_attribute: boolean;
  has_gender_attribute: boolean;
  recommended_ingest_channel: "http_attach_sse" | "polling" | "onvif" | "unknown";
  fork_decision_required: string[];         // ex: "câmera não entrega emoção — escolher entre 10.2(a) e 10.2(b) da spec"
}
```

- [ ] **Step 2: Reexportar do barrel**

Atualizar `packages/shared/src/index.ts`:

```typescript
export * from "./types/index.js";
export * from "./types/discovery.js";
```

- [ ] **Step 3: TDD — Teste para o orquestrador `runProbes`**

```typescript
// packages/edge/tests/unit/discovery/prober.test.ts
import { describe, expect, test } from "bun:test";
import { runProbes } from "../../../src/discovery/prober.js";
import type { ProbeFn } from "../../../src/discovery/types.js";

describe("runProbes", () => {
  test("executa todas as probes e retorna lista de resultados em ordem", async () => {
    const probes: ProbeFn[] = [
      async () => ({
        name: "p1",
        endpoint: "/p1",
        status: "ok",
        duration_ms: 5,
      }),
      async () => ({
        name: "p2",
        endpoint: "/p2",
        status: "not_found",
        http_status: 404,
        duration_ms: 8,
      }),
    ];
    const results = await runProbes(probes);
    expect(results).toHaveLength(2);
    expect(results[0]?.name).toBe("p1");
    expect(results[1]?.status).toBe("not_found");
  });

  test("captura erro lançado por probe e converte em ProbeResult com status=error", async () => {
    const probes: ProbeFn[] = [
      async () => {
        throw new Error("boom");
      },
    ];
    const results = await runProbes(probes);
    expect(results[0]?.status).toBe("error");
    expect(results[0]?.error).toContain("boom");
  });
});
```

- [ ] **Step 4: Definir tipo `ProbeFn` e implementar `runProbes`**

Criar `packages/edge/src/discovery/types.ts`:

```typescript
import type { ProbeResult } from "@vipcam/shared";
import type { DahuaHttpClient } from "../ingest/dahua-http-client.js";

export type ProbeFn = (client?: DahuaHttpClient) => Promise<ProbeResult>;
```

Criar `packages/edge/src/discovery/prober.ts`:

```typescript
import type { DahuaHttpClient } from "../ingest/dahua-http-client.js";
import type { ProbeResult } from "@vipcam/shared";
import type { ProbeFn } from "./types.js";
import { logger } from "../obs/logger.js";

export async function runProbes(probes: ProbeFn[], client?: DahuaHttpClient): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const probe of probes) {
    try {
      const r = await probe(client);
      results.push(r);
      logger.debug({ probe: r.name, status: r.status }, "probe completed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        name: probe.name || "anonymous-probe",
        endpoint: "(unknown)",
        status: "error",
        duration_ms: 0,
        error: message,
      });
      logger.warn({ err }, "probe threw");
    }
  }
  return results;
}
```

- [ ] **Step 5: Confirmar testes passam**

Run: `cd packages/edge && bun test tests/unit/discovery/prober.test.ts`
Expected: 2 testes passam.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/discovery.ts packages/shared/src/index.ts packages/edge/src/discovery/ packages/edge/tests/unit/discovery/prober.test.ts
git commit -m "feat(discovery): add probe orchestrator and shared discovery types"
```

---

### Task 1.4: Probe `magicBox.cgi` (system info, capabilities)

**Files:**
- Create: `packages/edge/src/discovery/probes/magic-box.ts`
- Create: `packages/edge/tests/unit/discovery/probes/magic-box.test.ts`

- [ ] **Step 1: TDD — Teste do parser de magicBox**

```typescript
// packages/edge/tests/unit/discovery/probes/magic-box.test.ts
import { describe, expect, test } from "bun:test";
import { parseMagicBoxKeyValue } from "../../../../src/discovery/probes/magic-box.js";

describe("parseMagicBoxKeyValue", () => {
  test("extrai pares chave=valor do formato Dahua", () => {
    const body = `deviceType=IPC-HFW5442T-ASE
serialNumber=ABC123
hardwareVersion=1.00
machineName=IPC`;
    const parsed = parseMagicBoxKeyValue(body);
    expect(parsed["deviceType"]).toBe("IPC-HFW5442T-ASE");
    expect(parsed["serialNumber"]).toBe("ABC123");
  });

  test("ignora linhas vazias e malformadas", () => {
    const body = "key1=value1\n\ngarbage\nkey2=value2";
    const parsed = parseMagicBoxKeyValue(body);
    expect(parsed["key1"]).toBe("value1");
    expect(parsed["key2"]).toBe("value2");
    expect(Object.keys(parsed)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Implementar `magic-box.ts`**

```typescript
// packages/edge/src/discovery/probes/magic-box.ts
import type { ProbeFn } from "../types.js";

const ENDPOINTS = [
  { name: "magicBox.getSystemInfo", path: "/cgi-bin/magicBox.cgi?action=getSystemInfo" },
  { name: "magicBox.getDeviceType", path: "/cgi-bin/magicBox.cgi?action=getDeviceType" },
  { name: "magicBox.getSerialNo", path: "/cgi-bin/magicBox.cgi?action=getSerialNo" },
  { name: "magicBox.getSoftwareVersion", path: "/cgi-bin/magicBox.cgi?action=getSoftwareVersion" },
];

export function parseMagicBoxKeyValue(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

export function makeMagicBoxProbes(): ProbeFn[] {
  return ENDPOINTS.map(({ name, path }) => {
    const fn: ProbeFn = async (client) => {
      if (!client) {
        return { name, endpoint: path, status: "skipped", duration_ms: 0 };
      }
      const t0 = Date.now();
      try {
        const r = await client.get(path);
        const text = await r.text();
        const duration = Date.now() - t0;
        if (r.status === 401) {
          return { name, endpoint: path, status: "auth_failed", http_status: 401, duration_ms: duration };
        }
        if (r.status === 404) {
          return { name, endpoint: path, status: "not_found", http_status: 404, duration_ms: duration };
        }
        if (r.status >= 200 && r.status < 300) {
          return {
            name,
            endpoint: path,
            status: "ok",
            http_status: r.status,
            duration_ms: duration,
            raw_response_excerpt: text.slice(0, 1000),
            parsed: parseMagicBoxKeyValue(text),
          };
        }
        return {
          name,
          endpoint: path,
          status: "error",
          http_status: r.status,
          duration_ms: duration,
          raw_response_excerpt: text.slice(0, 1000),
          error: `unexpected status ${r.status}`,
        };
      } catch (err) {
        const isTimeout = err instanceof Error && err.name === "TimeoutError";
        return {
          name,
          endpoint: path,
          status: isTimeout ? "timeout" : "error",
          duration_ms: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };
    Object.defineProperty(fn, "name", { value: name });
    return fn;
  });
}
```

- [ ] **Step 3: Rodar teste e commit**

Run: `cd packages/edge && bun test tests/unit/discovery/probes/magic-box.test.ts`
Expected: 2 testes passam.

```bash
git add packages/edge/src/discovery/probes/magic-box.ts packages/edge/tests/unit/discovery/probes/magic-box.test.ts
git commit -m "feat(discovery): add magicBox.cgi probes (system info, serial, version)"
```

---

### Task 1.5: Probes `snapshot.cgi`, `faceInfoManager.cgi`, `faceRecognitionServer.cgi`

Pattern idêntico ao magic-box. Cada probe = um arquivo enxuto.

**Files:**
- Create: `packages/edge/src/discovery/probes/snapshot.ts`
- Create: `packages/edge/src/discovery/probes/face-info.ts`
- Create: `packages/edge/src/discovery/probes/face-recognition.ts`
- Create: `packages/edge/tests/unit/discovery/probes/face-info.test.ts`

- [ ] **Step 1: Implementar `snapshot.ts`**

```typescript
// packages/edge/src/discovery/probes/snapshot.ts
//
// Probe testa o endpoint /cgi-bin/snapshot.cgi (captura JPEG sob demanda).
// Esse endpoint é requisito da Fase 4 (upload de snapshot ao Face DB) e da
// captura de imagens para exibição na UI; validamos disponibilidade aqui.
import type { ProbeFn } from "../types.js";

export function makeSnapshotProbe(): ProbeFn {
  const path = "/cgi-bin/snapshot.cgi?channel=1";
  const fn: ProbeFn = async (client) => {
    if (!client) return { name: "snapshot.fetch", endpoint: path, status: "skipped", duration_ms: 0 };
    const t0 = Date.now();
    try {
      const r = await client.get(path);
      const duration = Date.now() - t0;
      const ct = r.headers.get("content-type") ?? "";
      const isImage = ct.startsWith("image/");
      // Não baixamos a imagem inteira no relatório — só confirmamos que ela vem.
      if (r.body) await r.body.cancel().catch(() => {});
      if (r.status === 200 && isImage) {
        return {
          name: "snapshot.fetch",
          endpoint: path,
          status: "ok",
          http_status: 200,
          duration_ms: duration,
          parsed: { content_type: ct },
        };
      }
      return {
        name: "snapshot.fetch",
        endpoint: path,
        status: r.status === 401 ? "auth_failed" : r.status === 404 ? "not_found" : "error",
        http_status: r.status,
        duration_ms: duration,
        error: !isImage ? `expected image, got ${ct}` : undefined,
      };
    } catch (err) {
      return {
        name: "snapshot.fetch",
        endpoint: path,
        status: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "error",
        duration_ms: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
  Object.defineProperty(fn, "name", { value: "snapshot.fetch" });
  return fn;
}
```

> **Nota:** o arquivo se chama `snapshot.ts` (não `snap-manager.ts`) e a probe tem nome `snapshot.fetch`. Ajustar imports correspondentes na Task 1.8 (`runner.ts` deve usar `import { makeSnapshotProbe } from "./probes/snapshot.js"`).

- [ ] **Step 2: Implementar `face-info.ts`**

```typescript
// packages/edge/src/discovery/probes/face-info.ts
import type { ProbeFn } from "../types.js";

const ENDPOINTS = [
  { name: "faceInfo.getCollectionList", path: "/cgi-bin/FaceInfoManager.cgi?action=getCollection" },
  { name: "faceInfo.getCount", path: "/cgi-bin/FaceInfoManager.cgi?action=getCount" },
];

export function makeFaceInfoProbes(): ProbeFn[] {
  return ENDPOINTS.map(({ name, path }) => {
    const fn: ProbeFn = async (client) => {
      if (!client) return { name, endpoint: path, status: "skipped", duration_ms: 0 };
      const t0 = Date.now();
      try {
        const r = await client.get(path);
        const text = await r.text();
        return {
          name,
          endpoint: path,
          status: r.status === 200 ? "ok" : r.status === 404 ? "not_found" : r.status === 401 ? "auth_failed" : "error",
          http_status: r.status,
          duration_ms: Date.now() - t0,
          raw_response_excerpt: text.slice(0, 1000),
        };
      } catch (err) {
        return {
          name,
          endpoint: path,
          status: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "error",
          duration_ms: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };
    Object.defineProperty(fn, "name", { value: name });
    return fn;
  });
}
```

- [ ] **Step 3: Implementar `face-recognition.ts`**

```typescript
// packages/edge/src/discovery/probes/face-recognition.ts
import type { ProbeFn } from "../types.js";

export function makeFaceRecognitionProbes(): ProbeFn[] {
  const endpoints = [
    {
      name: "faceRecognition.getCapabilities",
      path: "/cgi-bin/devVideoAnalyse.cgi?action=getCaps",
    },
    {
      name: "faceRecognition.eventList",
      path: "/cgi-bin/intervideo.cgi?action=getCaps",
    },
  ];

  return endpoints.map(({ name, path }) => {
    const fn: ProbeFn = async (client) => {
      if (!client) return { name, endpoint: path, status: "skipped", duration_ms: 0 };
      const t0 = Date.now();
      try {
        const r = await client.get(path);
        const text = await r.text();
        return {
          name,
          endpoint: path,
          status: r.status === 200 ? "ok" : r.status === 404 ? "not_found" : r.status === 401 ? "auth_failed" : "error",
          http_status: r.status,
          duration_ms: Date.now() - t0,
          raw_response_excerpt: text.slice(0, 1500),
        };
      } catch (err) {
        return {
          name,
          endpoint: path,
          status: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "error",
          duration_ms: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };
    Object.defineProperty(fn, "name", { value: name });
    return fn;
  });
}
```

- [ ] **Step 4: TDD — Smoke test que probes sem client retornam `skipped`**

```typescript
// packages/edge/tests/unit/discovery/probes/face-info.test.ts
import { describe, expect, test } from "bun:test";
import { makeFaceInfoProbes } from "../../../../src/discovery/probes/face-info.js";

describe("makeFaceInfoProbes", () => {
  test("retorna 2 probes que ficam skipped sem client", async () => {
    const probes = makeFaceInfoProbes();
    expect(probes).toHaveLength(2);
    for (const probe of probes) {
      const r = await probe(undefined);
      expect(r.status).toBe("skipped");
    }
  });
});
```

- [ ] **Step 5: Rodar testes**

Run: `cd packages/edge && bun test tests/unit/discovery/`
Expected: todos os testes de discovery passam.

- [ ] **Step 6: Commit**

```bash
git add packages/edge/src/discovery/probes/snapshot.ts packages/edge/src/discovery/probes/face-info.ts packages/edge/src/discovery/probes/face-recognition.ts packages/edge/tests/unit/discovery/probes/face-info.test.ts
git commit -m "feat(discovery): add snapshot + faceInfoManager + faceRecognition probes"
```

---

### Task 1.6: Captura de eventos via `eventManager.cgi attach` (10 min)

A câmera Dahua expõe um stream de eventos via long-polling HTTP no formato multipart. Vamos implementar um listener que escuta por N segundos, parseia cada `Content-Type: multipart/x-mixed-replace` boundary, e salva os payloads brutos.

**Files:**
- Create: `packages/edge/src/discovery/capture.ts`
- Create: `packages/edge/tests/unit/discovery/capture.test.ts`

- [ ] **Step 1: TDD — Teste do parser de boundary multipart**

```typescript
// packages/edge/tests/unit/discovery/capture.test.ts
import { describe, expect, test } from "bun:test";
import { parseMultipartChunks } from "../../../src/discovery/capture.js";

describe("parseMultipartChunks", () => {
  test("extrai eventos completos e devolve remainder vazio quando tudo terminou", () => {
    const boundary = "--myboundary";
    const buf = Buffer.from(
      [
        "--myboundary",
        "Content-Type: text/plain",
        "Content-Length: 42",
        "",
        'Code=VideoMotion;action=Start;index=0;data={"foo":"bar"}',
        "--myboundary",
        "Content-Type: text/plain",
        "Content-Length: 30",
        "",
        "Code=AlarmLocal;action=Start;index=1",
        "--myboundary--",
      ].join("\r\n"),
    );
    const { events, remainder } = parseMultipartChunks(buf, boundary);
    expect(events).toHaveLength(2);
    expect(events[0]).toContain("VideoMotion");
    expect(events[1]).toContain("AlarmLocal");
    // remainder começa no boundary final ("--myboundary--"), preservando bytes do
    // marcador de fim para que próximas chamadas concatenadas sigam consistentes.
    expect(remainder.toString("utf8")).toMatch(/^--myboundary/);
  });

  test("preserva chunk parcial quando boundary não fecha", () => {
    const boundary = "--b";
    const buf = Buffer.from(
      [
        "--b",
        "Content-Type: text/plain",
        "",
        "first event",
        "--b",
        "Content-Type: text/plain",
        "",
        "partial event without closing boundary",
      ].join("\r\n"),
    );
    const { events, remainder } = parseMultipartChunks(buf, boundary);
    expect(events).toHaveLength(1);
    expect(events[0]).toBe("first event");
    expect(remainder.toString("utf8")).toContain("partial event");
  });

  test("retorna eventos vazios e remainder original quando nenhum boundary é encontrado", () => {
    const buf = Buffer.from("garbage data without boundary");
    const { events, remainder } = parseMultipartChunks(buf, "--bound");
    expect(events).toEqual([]);
    expect(remainder.length).toBe(buf.length);
  });
});
```

- [ ] **Step 2: Implementar `capture.ts`**

```typescript
// packages/edge/src/discovery/capture.ts
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DahuaHttpClient } from "../ingest/dahua-http-client.js";
import { logger } from "../obs/logger.js";

export interface CapturedEvent {
  index: number;
  received_at: string;
  raw: string;
  parsed?: { code?: string; action?: string; data?: unknown };
}

export interface CaptureResult {
  events: CapturedEvent[];
  duration_seconds: number;
  saved_to: string;
}

/**
 * Parser de multipart/x-mixed-replace tal como a Dahua usa, preservando bytes
 * não-consumidos para que o caller possa concatenar com chunks futuros sem perder
 * eventos parciais nas bordas.
 */
export interface ParseResult {
  events: string[];
  remainder: Buffer;
}

export function parseMultipartChunks(buf: Buffer, boundary: string): ParseResult {
  const boundaryBuf = Buffer.from(boundary);
  const events: string[] = [];

  let cursor = 0;
  let lastBoundaryEnd = 0;

  while (true) {
    const idx = buf.indexOf(boundaryBuf, cursor);
    if (idx < 0) break;
    const next = buf.indexOf(boundaryBuf, idx + boundaryBuf.length);
    if (next < 0) {
      // Não temos o boundary que fecha esta parte ainda — para aqui e devolve remainder
      break;
    }
    const part = buf.slice(idx + boundaryBuf.length, next).toString("utf8");
    const sep = part.indexOf("\r\n\r\n") >= 0 ? "\r\n\r\n" : "\n\n";
    const headerEnd = part.indexOf(sep);
    if (headerEnd >= 0) {
      const body = part.slice(headerEnd + sep.length).trim();
      if (body) events.push(body);
    }
    cursor = next;
    lastBoundaryEnd = next;
  }

  // Mantém tudo a partir do último boundary completo (inclusive) como remainder,
  // para que o próximo parse encontre o boundary novamente como delimitador inicial.
  const remainder = buf.slice(lastBoundaryEnd);
  return { events, remainder };
}

function tryParseDahuaEventLine(raw: string): CapturedEvent["parsed"] {
  // Linhas Dahua: "Code=VideoMotion;action=Start;index=0;data={...}"
  const out: { code?: string; action?: string; data?: unknown } = {};
  for (const seg of raw.split(";")) {
    const eq = seg.indexOf("=");
    if (eq < 0) continue;
    const k = seg.slice(0, eq).trim().toLowerCase();
    const v = seg.slice(eq + 1).trim();
    if (k === "code") out.code = v;
    else if (k === "action") out.action = v;
    else if (k === "data") {
      try { out.data = JSON.parse(v); } catch { out.data = v; }
    }
  }
  return out;
}

export async function captureEvents(
  client: DahuaHttpClient,
  durationSeconds: number,
  outputDir: string,
): Promise<CaptureResult> {
  await mkdir(outputDir, { recursive: true });
  const path = "/cgi-bin/eventManager.cgi?action=attach&codes=[All]";
  const t0 = Date.now();
  const events: CapturedEvent[] = [];

  logger.info({ durationSeconds, path }, "starting event capture");

  // AbortController garante que reader.read() não fique pendurado depois do deadline
  // (caso a câmera não envie nenhum chunk durante o intervalo, a leitura ficaria bloqueada
  // até a conexão TCP morrer; o abort força a saída).
  const abortCtrl = new AbortController();
  const timer = setTimeout(() => abortCtrl.abort(), durationSeconds * 1000);

  const response = await client.getStream(path, { signal: abortCtrl.signal });

  if (!response.body) {
    clearTimeout(timer);
    return { events: [], duration_seconds: 0, saved_to: outputDir };
  }

  const ct = response.headers.get("content-type") ?? "";
  const boundaryMatch = ct.match(/boundary=([^;]+)/i);
  const boundary = boundaryMatch ? `--${boundaryMatch[1]}` : "--myboundary";

  const reader = response.body.getReader();
  let pending: Buffer = Buffer.alloc(0);

  try {
    while (!abortCtrl.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) pending = Buffer.concat([pending, Buffer.from(value)]);

      const { events: parsed, remainder } = parseMultipartChunks(pending, boundary);
      pending = remainder; // preserva bytes não-consumidos para próxima iteração
      for (const raw of parsed) {
        events.push({
          index: events.length,
          received_at: new Date().toISOString(),
          raw,
          parsed: tryParseDahuaEventLine(raw),
        });
      }
    }
  } catch (err) {
    // Abort esperado quando deadline acaba — não propagar como erro.
    if (!(err instanceof Error && err.name === "AbortError")) {
      throw err;
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }

  // Salva todos os eventos como NDJSON para auditoria
  const outFile = join(outputDir, `events-${Date.now()}.ndjson`);
  const ndjson = events.map((e) => JSON.stringify(e)).join("\n");
  await writeFile(outFile, ndjson, "utf8");

  const result: CaptureResult = {
    events,
    duration_seconds: Math.round((Date.now() - t0) / 1000),
    saved_to: outFile,
  };
  logger.info({ count: events.length, file: outFile }, "event capture complete");
  return result;
}
```

- [ ] **Step 3: Rodar teste do parser**

Run: `cd packages/edge && bun test tests/unit/discovery/capture.test.ts`
Expected: 2 testes passam.

- [ ] **Step 4: Commit**

```bash
git add packages/edge/src/discovery/capture.ts packages/edge/tests/unit/discovery/capture.test.ts
git commit -m "feat(discovery): add multipart event capture via eventManager.cgi attach"
```

---

### Task 1.7: Gerador de relatório (markdown + JSON)

**Files:**
- Create: `packages/edge/src/discovery/report.ts`
- Create: `packages/edge/tests/unit/discovery/report.test.ts`

- [ ] **Step 1: TDD — Teste de geração de relatório**

```typescript
// packages/edge/tests/unit/discovery/report.test.ts
import { describe, expect, test } from "bun:test";
import { buildReport, renderMarkdown } from "../../../src/discovery/report.js";
import type { ProbeResult } from "@vipcam/shared";

const probes: ProbeResult[] = [
  { name: "magicBox.getSystemInfo", endpoint: "/cgi-bin/magicBox.cgi?action=getSystemInfo", status: "ok", http_status: 200, duration_ms: 10, parsed: { deviceType: "IPC-HFW5442T-ASE", serialNumber: "X" } },
  { name: "snapshot.fetch", endpoint: "/cgi-bin/snapshot.cgi?channel=1", status: "ok", http_status: 200, duration_ms: 80 },
  { name: "faceInfo.getCount", endpoint: "/cgi-bin/FaceInfoManager.cgi?action=getCount", status: "not_found", http_status: 404, duration_ms: 12 },
];

describe("buildReport", () => {
  test("agrega probes + capture metadata num DiscoveryReport", () => {
    const report = buildReport({
      cameraIp: "192.168.1.108",
      probes,
      capturedEvents: [
        { index: 0, received_at: "2026-04-30T12:00:00Z", raw: 'Code=FaceDetection;action=Start;index=0;data={"Age":30,"Gender":"Male"}', parsed: { code: "FaceDetection", action: "Start", data: { Age: 30, Gender: "Male" } } },
      ],
      captureDurationSeconds: 120,
    });
    expect(report.camera_ip).toBe("192.168.1.108");
    expect(report.camera_model).toBe("IPC-HFW5442T-ASE");
    expect(report.events_captured).toBe(1);
    expect(report.event_types_seen["FaceDetection"]).toBe(1);
    expect(report.has_age_attribute).toBe(true);
    expect(report.has_gender_attribute).toBe(true);
    expect(report.has_emotion_attribute).toBe(false);
    expect(report.fork_decision_required.some((s) => s.includes("emoção"))).toBe(true);
  });

  test("recommended_ingest_channel = http_attach_sse quando attach probe funcionou e eventos chegaram", () => {
    const report = buildReport({
      cameraIp: "1.1.1.1",
      probes: [],
      capturedEvents: [{ index: 0, received_at: "x", raw: "x", parsed: { code: "Foo", action: "Start" } }],
      captureDurationSeconds: 10,
    });
    expect(report.recommended_ingest_channel).toBe("http_attach_sse");
  });
});

describe("renderMarkdown", () => {
  test("produz markdown com seções esperadas", () => {
    const report = buildReport({
      cameraIp: "192.168.1.108",
      probes,
      capturedEvents: [],
      captureDurationSeconds: 60,
    });
    const md = renderMarkdown(report);
    expect(md).toContain("# Discovery Report");
    expect(md).toContain("192.168.1.108");
    expect(md).toContain("## Probes");
    expect(md).toContain("magicBox.getSystemInfo");
    expect(md).toContain("✅");
    expect(md).toContain("❌");
    expect(md).toContain("## Decisões pendentes");
  });
});
```

- [ ] **Step 2: Implementar `report.ts`**

```typescript
// packages/edge/src/discovery/report.ts
import type { DiscoveryReport, ProbeResult } from "@vipcam/shared";
import type { CapturedEvent } from "./capture.js";

interface BuildArgs {
  cameraIp: string;
  probes: ProbeResult[];
  capturedEvents: CapturedEvent[];
  captureDurationSeconds: number;
}

const EMOTION_KEYS = ["Emotion", "Expression", "Mood", "FaceExpression"];
const AGE_KEYS = ["Age", "AgeRange", "AgeGroup"];
const GENDER_KEYS = ["Gender", "Sex"];

function findInData(events: CapturedEvent[], keys: string[]): string[] {
  const found = new Set<string>();
  for (const e of events) {
    const data = e.parsed?.data;
    if (data && typeof data === "object" && data !== null) {
      const keysInData = Object.keys(data as Record<string, unknown>);
      for (const k of keysInData) {
        if (keys.some((target) => k.toLowerCase() === target.toLowerCase())) found.add(k);
      }
    }
  }
  return [...found];
}

function collectAttributeKeys(events: CapturedEvent[]): string[] {
  const set = new Set<string>();
  for (const e of events) {
    const data = e.parsed?.data;
    if (data && typeof data === "object" && data !== null) {
      for (const k of Object.keys(data as Record<string, unknown>)) set.add(k);
    }
  }
  return [...set].sort();
}

export function buildReport(args: BuildArgs): DiscoveryReport {
  const eventTypes: Record<string, number> = {};
  for (const e of args.capturedEvents) {
    const code = e.parsed?.code ?? "Unknown";
    eventTypes[code] = (eventTypes[code] ?? 0) + 1;
  }

  // Agrega dados de identificação dos probes magicBox.* dedicados.
  // Cada endpoint retorna um único par chave=valor mais confiável que parsear o getSystemInfo.
  const probeParsed = (name: string): Record<string, string> | undefined =>
    args.probes.find((p) => p.name === name)?.parsed as Record<string, string> | undefined;

  const sysInfo = probeParsed("magicBox.getSystemInfo") ?? {};
  const serialInfo = probeParsed("magicBox.getSerialNo") ?? {};
  const versionInfo = probeParsed("magicBox.getSoftwareVersion") ?? {};
  const deviceTypeInfo = probeParsed("magicBox.getDeviceType") ?? {};

  const cameraModel =
    deviceTypeInfo["type"] ?? deviceTypeInfo["deviceType"] ?? sysInfo["deviceType"];
  const cameraSerial = serialInfo["sn"] ?? serialInfo["serialNumber"] ?? sysInfo["serialNumber"];
  const firmware =
    versionInfo["version"] ??
    versionInfo["softwareVersion"] ??
    sysInfo["softwareVersion"] ??
    sysInfo["hardwareVersion"];

  const ageMatches = findInData(args.capturedEvents, AGE_KEYS);
  const genderMatches = findInData(args.capturedEvents, GENDER_KEYS);
  const emotionMatches = findInData(args.capturedEvents, EMOTION_KEYS);

  const fork: string[] = [];
  if (emotionMatches.length === 0 && args.capturedEvents.length > 0) {
    fork.push(
      "Câmera não entregou atributo de emoção em payloads observados. Decidir entre 10.2(a) seguir só com idade/gênero ou 10.2(b) inferir emoção via sidecar (HSEmotion ONNX).",
    );
  }
  if (args.capturedEvents.length === 0) {
    fork.push(
      "Nenhum evento capturado durante o período. Verificar conectividade da câmera, eventos habilitados, ou aumentar duração da captura.",
    );
  }

  return {
    generated_at: new Date().toISOString(),
    camera_ip: args.cameraIp,
    camera_model: cameraModel,
    camera_serial: cameraSerial,
    firmware,
    probes: args.probes,
    events_captured: args.capturedEvents.length,
    capture_duration_seconds: args.captureDurationSeconds,
    event_types_seen: eventTypes,
    attribute_keys_seen: collectAttributeKeys(args.capturedEvents),
    has_emotion_attribute: emotionMatches.length > 0,
    has_age_attribute: ageMatches.length > 0,
    has_gender_attribute: genderMatches.length > 0,
    recommended_ingest_channel:
      args.capturedEvents.length > 0 ? "http_attach_sse" : "unknown",
    fork_decision_required: fork,
  };
}

const STATUS_ICON: Record<ProbeResult["status"], string> = {
  ok: "✅",
  not_found: "❌",
  auth_failed: "🔒",
  timeout: "⏱",
  error: "💥",
  skipped: "⏭",
};

export function renderMarkdown(r: DiscoveryReport): string {
  const lines: string[] = [];
  lines.push(`# Discovery Report — DH-IPC-HFW5442T-ASE`);
  lines.push("");
  lines.push(`**Gerado em:** ${r.generated_at}`);
  lines.push(`**Câmera IP:** ${r.camera_ip}`);
  if (r.camera_model) lines.push(`**Modelo:** ${r.camera_model}`);
  if (r.camera_serial) lines.push(`**Serial:** ${r.camera_serial}`);
  if (r.firmware) lines.push(`**Firmware:** ${r.firmware}`);
  lines.push("");

  lines.push("## Probes");
  lines.push("");
  lines.push("| Status | Probe | Endpoint | HTTP | Duração |");
  lines.push("|---|---|---|---|---|");
  for (const p of r.probes) {
    lines.push(`| ${STATUS_ICON[p.status]} ${p.status} | ${p.name} | \`${p.endpoint}\` | ${p.http_status ?? "—"} | ${p.duration_ms}ms |`);
  }
  lines.push("");

  lines.push("## Captura de eventos");
  lines.push("");
  lines.push(`- **Duração:** ${r.capture_duration_seconds}s`);
  lines.push(`- **Eventos capturados:** ${r.events_captured}`);
  lines.push(`- **Tipos de evento:**`);
  for (const [code, count] of Object.entries(r.event_types_seen)) {
    lines.push(`  - \`${code}\`: ${count}`);
  }
  lines.push("");
  lines.push(`- **Chaves de atributo vistas em payloads:**`);
  for (const k of r.attribute_keys_seen) lines.push(`  - \`${k}\``);
  lines.push("");
  lines.push(`- **Idade:** ${r.has_age_attribute ? "✅ presente" : "❌ ausente"}`);
  lines.push(`- **Gênero:** ${r.has_gender_attribute ? "✅ presente" : "❌ ausente"}`);
  lines.push(`- **Emoção:** ${r.has_emotion_attribute ? "✅ presente" : "❌ ausente"}`);
  lines.push("");

  lines.push("## Recomendação de canal de ingest");
  lines.push("");
  lines.push(`**${r.recommended_ingest_channel}**`);
  lines.push("");

  if (r.fork_decision_required.length > 0) {
    lines.push("## Decisões pendentes");
    lines.push("");
    for (const d of r.fork_decision_required) lines.push(`- ⚠ ${d}`);
    lines.push("");
  }

  return lines.join("\n");
}
```

- [ ] **Step 3: Rodar testes**

Run: `cd packages/edge && bun test tests/unit/discovery/report.test.ts`
Expected: 3 testes passam.

- [ ] **Step 4: Commit**

```bash
git add packages/edge/src/discovery/report.ts packages/edge/tests/unit/discovery/report.test.ts
git commit -m "feat(discovery): add report builder and markdown renderer"
```

---

### Task 1.7-fim: Verificação intermediária do Chunk 1A

Rodar a suíte completa do edge para confirmar que nada do Chunk 1A regrediu antes de avançar para o Chunk 1B.

- [ ] **Step 1: Rodar todos os testes do edge**

Run: `cd packages/edge && bun test`
Expected: todos os testes passam (env, dahua-http-client, prober, magic-box, face-info, capture, report). Contagem aproximada: ~22 testes.

- [ ] **Step 2: Typecheck do edge**

Run: `cd packages/edge && bun run typecheck`
Expected: zero errors.

---

## Chunk 1B: Fase 1 — API + frontend + execução real + verificação

Conecta as peças do Chunk 1A em endpoints HTTP, expõe na UI, roda contra a câmera real e fecha a Onda 1 com verificação. **Marca [CAMERA]** indica tarefas que requerem hardware; demais rodam contra fakes/mocks.

### Task 1.8: Endpoint REST `/api/discovery/probe` e persistência local do relatório

**Files:**
- Create: `packages/edge/src/api/routes/discovery.ts`
- Modify: `packages/edge/src/api/server.ts`
- Create: `packages/edge/src/discovery/runner.ts`
- Create: `packages/edge/tests/unit/api/routes/discovery.test.ts`

- [ ] **Step 1: Criar `runner.ts` que orquestra tudo**

```typescript
// packages/edge/src/discovery/runner.ts
import { writeFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DiscoveryReport } from "@vipcam/shared";
import { DahuaHttpClient } from "../ingest/dahua-http-client.js";
import { runProbes } from "./prober.js";
import { makeMagicBoxProbes } from "./probes/magic-box.js";
import { makeSnapshotProbe } from "./probes/snapshot.js";
import { makeFaceInfoProbes } from "./probes/face-info.js";
import { makeFaceRecognitionProbes } from "./probes/face-recognition.js";
import { captureEvents } from "./capture.js";
import { buildReport, renderMarkdown } from "./report.js";
import { logger } from "../obs/logger.js";

export interface RunDiscoveryArgs {
  cameraIp: string;
  cameraUser: string;
  cameraPass: string;
  captureSeconds?: number;
  outputDir?: string;
}

export interface RunDiscoveryResult {
  report: DiscoveryReport;
  jsonPath: string;
  markdownPath: string;
  capturesDir: string;
}

export async function runDiscovery(args: RunDiscoveryArgs): Promise<RunDiscoveryResult> {
  const captureSeconds = args.captureSeconds ?? 600; // 10 min default
  const outputDir = args.outputDir ?? join(process.cwd(), "discovery-output");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(outputDir, `run-${ts}`);
  await mkdir(runDir, { recursive: true });

  const client = new DahuaHttpClient({
    baseUrl: `http://${args.cameraIp}`,
    username: args.cameraUser,
    password: args.cameraPass,
  });

  const probes = [
    ...makeMagicBoxProbes(),
    makeSnapshotProbe(),
    ...makeFaceInfoProbes(),
    ...makeFaceRecognitionProbes(),
  ];

  logger.info({ count: probes.length }, "running probes");
  const probeResults = await runProbes(probes, client);

  logger.info({ captureSeconds }, "starting event capture");
  const capture = await captureEvents(client, captureSeconds, runDir);

  const report = buildReport({
    cameraIp: args.cameraIp,
    probes: probeResults,
    capturedEvents: capture.events,
    captureDurationSeconds: capture.duration_seconds,
  });

  const jsonPath = join(runDir, "report.json");
  const markdownPath = join(runDir, "report.md");
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(markdownPath, renderMarkdown(report), "utf8");

  logger.info({ jsonPath, markdownPath }, "discovery complete");
  return { report, jsonPath, markdownPath, capturesDir: runDir };
}

export async function getLatestReport(outputDir?: string): Promise<DiscoveryReport | null> {
  const dir = outputDir ?? join(process.cwd(), "discovery-output");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const runs = entries.filter((e) => e.startsWith("run-")).sort().reverse();
  if (runs.length === 0) return null;
  const reportPath = join(dir, runs[0]!, "report.json");
  try {
    const text = await readFile(reportPath, "utf8");
    return JSON.parse(text) as DiscoveryReport;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Criar route handler `routes/discovery.ts` (factory injetável para testabilidade)**

```typescript
// packages/edge/src/api/routes/discovery.ts
import { Hono } from "hono";
import { z } from "zod";
import type { DiscoveryReport } from "@vipcam/shared";
import type { Env } from "../../config/env.js";

const probeBodySchema = z.object({
  capture_seconds: z.number().int().positive().max(3600).optional(),
});

export interface DiscoveryDeps {
  env: Pick<Env, "CAMERA_IP" | "CAMERA_USER" | "CAMERA_PASS">;
  runDiscovery: (args: {
    cameraIp: string;
    cameraUser: string;
    cameraPass: string;
    captureSeconds?: number;
  }) => Promise<{
    report: DiscoveryReport;
    jsonPath: string;
    markdownPath: string;
    capturesDir: string;
  }>;
  getLatestReport: () => Promise<DiscoveryReport | null>;
}

export function createDiscoveryRoutes(deps: DiscoveryDeps): Hono {
  const r = new Hono();

  r.post("/probe", async (c) => {
    const { env } = deps;
    if (!env.CAMERA_IP || !env.CAMERA_USER || !env.CAMERA_PASS) {
      return c.json(
        { error: "camera_not_configured", hint: "set CAMERA_IP, CAMERA_USER, CAMERA_PASS in .env" },
        400,
      );
    }
    const raw = await c.req.json().catch(() => ({}));
    const parsed = probeBodySchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

    const result = await deps.runDiscovery({
      cameraIp: env.CAMERA_IP,
      cameraUser: env.CAMERA_USER,
      cameraPass: env.CAMERA_PASS,
      captureSeconds: parsed.data.capture_seconds,
    });
    return c.json({
      report: result.report,
      artifacts: {
        json: result.jsonPath,
        markdown: result.markdownPath,
        captures_dir: result.capturesDir,
      },
    });
  });

  r.get("/last-report", async (c) => {
    const report = await deps.getLatestReport();
    if (!report) return c.json({ error: "no_report_yet" }, 404);
    return c.json({ report });
  });

  return r;
}
```

- [ ] **Step 3: Plugar rotas no server (com deps reais)**

Modificar `packages/edge/src/api/server.ts`:

```typescript
// imports:
import { createDiscoveryRoutes } from "./routes/discovery.js";
import { runDiscovery, getLatestReport } from "../discovery/runner.js";
import { getEnv } from "../config/env.js";

// dentro de createServer(), após o handler de /api/health:
const env = getEnv();
app.route(
  "/api/discovery",
  createDiscoveryRoutes({
    env: { CAMERA_IP: env.CAMERA_IP, CAMERA_USER: env.CAMERA_USER, CAMERA_PASS: env.CAMERA_PASS },
    runDiscovery,
    getLatestReport,
  }),
);
```

- [ ] **Step 4: TDD — Testes determinísticos com deps mockados**

```typescript
// packages/edge/tests/unit/api/routes/discovery.test.ts
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createDiscoveryRoutes, type DiscoveryDeps } from "../../../../src/api/routes/discovery.js";
import type { DiscoveryReport } from "@vipcam/shared";

function mountWith(deps: DiscoveryDeps): Hono {
  const app = new Hono();
  app.route("/api/discovery", createDiscoveryRoutes(deps));
  return app;
}

const fakeReport: DiscoveryReport = {
  generated_at: "2026-04-30T00:00:00Z",
  camera_ip: "192.168.1.108",
  probes: [],
  events_captured: 0,
  capture_duration_seconds: 0,
  event_types_seen: {},
  attribute_keys_seen: [],
  has_emotion_attribute: false,
  has_age_attribute: false,
  has_gender_attribute: false,
  recommended_ingest_channel: "unknown",
  fork_decision_required: [],
};

describe("POST /api/discovery/probe", () => {
  test("retorna 400 com hint quando câmera não configurada", async () => {
    const app = mountWith({
      env: {},
      runDiscovery: async () => {
        throw new Error("should not be called");
      },
      getLatestReport: async () => null,
    });
    const res = await app.request("/api/discovery/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("camera_not_configured");
  });

  test("invoca runDiscovery e devolve report quando câmera configurada", async () => {
    let calledWith: unknown;
    const app = mountWith({
      env: { CAMERA_IP: "192.168.1.108", CAMERA_USER: "admin", CAMERA_PASS: "secret" },
      runDiscovery: async (args) => {
        calledWith = args;
        return {
          report: fakeReport,
          jsonPath: "/tmp/r.json",
          markdownPath: "/tmp/r.md",
          capturesDir: "/tmp",
        };
      },
      getLatestReport: async () => null,
    });
    const res = await app.request("/api/discovery/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capture_seconds: 60 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: DiscoveryReport; artifacts: unknown };
    expect(body.report.camera_ip).toBe("192.168.1.108");
    expect(calledWith).toMatchObject({ cameraIp: "192.168.1.108", captureSeconds: 60 });
  });

  test("rejeita body com capture_seconds inválido", async () => {
    const app = mountWith({
      env: { CAMERA_IP: "1.1.1.1", CAMERA_USER: "a", CAMERA_PASS: "b" },
      runDiscovery: async () => {
        throw new Error("should not be called");
      },
      getLatestReport: async () => null,
    });
    const res = await app.request("/api/discovery/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capture_seconds: -1 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/discovery/last-report", () => {
  test("retorna 404 quando getLatestReport devolve null", async () => {
    const app = mountWith({
      env: {},
      runDiscovery: async () => {
        throw new Error("ignore");
      },
      getLatestReport: async () => null,
    });
    const res = await app.request("/api/discovery/last-report");
    expect(res.status).toBe(404);
  });

  test("retorna 200 com report quando há relatório anterior", async () => {
    const app = mountWith({
      env: {},
      runDiscovery: async () => {
        throw new Error("ignore");
      },
      getLatestReport: async () => fakeReport,
    });
    const res = await app.request("/api/discovery/last-report");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: DiscoveryReport };
    expect(body.report.camera_ip).toBe("192.168.1.108");
  });
});
```

- [ ] **Step 5: Adicionar `discovery-output/` ao `.gitignore`**

Editar `.gitignore` raiz, adicionar:

```
discovery-output/
```

- [ ] **Step 6: Rodar testes e verificar typecheck**

Run: `cd packages/edge && bun test tests/unit/api/`
Expected: testes passam (ou pelo menos não crasham).

Run: `bun run typecheck`
Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add packages/edge/src/discovery/runner.ts packages/edge/src/api/routes/discovery.ts packages/edge/src/api/server.ts packages/edge/tests/unit/api/ .gitignore
git commit -m "feat(api): expose POST /api/discovery/probe and GET /api/discovery/last-report"
```

---

### Task 1.9: Página `/discovery` no frontend

UI mínima: botão "Rodar Discovery", spinner enquanto roda, exibe markdown + tabela de probes quando terminar.

**Files:**
- Create: `packages/web/src/lib/api-client.ts`
- Create: `packages/web/src/app/discovery/page.tsx`
- Create: `packages/web/src/app/discovery/components/ProbeTable.tsx`

- [ ] **Step 1: Criar API client mínimo**

```typescript
// packages/web/src/lib/api-client.ts
import type { DiscoveryReport } from "@vipcam/shared";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export async function getLastDiscoveryReport(): Promise<DiscoveryReport | null> {
  const r = await fetch(`${API_URL}/api/discovery/last-report`, { cache: "no-store" });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`failed ${r.status}`);
  const body = (await r.json()) as { report: DiscoveryReport };
  return body.report;
}

export async function runDiscovery(captureSeconds?: number): Promise<DiscoveryReport> {
  const r = await fetch(`${API_URL}/api/discovery/probe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capture_seconds: captureSeconds }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: "unknown" }));
    throw new Error((err as { error: string }).error ?? "failed");
  }
  const body = (await r.json()) as { report: DiscoveryReport };
  return body.report;
}
```

- [ ] **Step 2: Criar componente `ProbeTable.tsx`**

```tsx
// packages/web/src/app/discovery/components/ProbeTable.tsx
import type { ProbeResult } from "@vipcam/shared";

const STATUS_COLOR: Record<ProbeResult["status"], string> = {
  ok: "text-green-700 bg-green-50",
  not_found: "text-red-700 bg-red-50",
  auth_failed: "text-yellow-800 bg-yellow-50",
  timeout: "text-orange-700 bg-orange-50",
  error: "text-red-800 bg-red-100",
  skipped: "text-neutral-500 bg-neutral-100",
};

export function ProbeTable({ probes }: { probes: ProbeResult[] }) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-neutral-100">
        <tr>
          <th className="p-2 text-left">Status</th>
          <th className="p-2 text-left">Probe</th>
          <th className="p-2 text-left">Endpoint</th>
          <th className="p-2 text-right">HTTP</th>
          <th className="p-2 text-right">ms</th>
        </tr>
      </thead>
      <tbody>
        {probes.map((p, i) => (
          <tr key={i} className="border-b border-neutral-200">
            <td className={`p-2 font-mono ${STATUS_COLOR[p.status]}`}>{p.status}</td>
            <td className="p-2 font-mono">{p.name}</td>
            <td className="p-2 font-mono text-xs text-neutral-600">{p.endpoint}</td>
            <td className="p-2 text-right font-mono">{p.http_status ?? "—"}</td>
            <td className="p-2 text-right font-mono">{p.duration_ms}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 3: Criar página `/discovery`**

```tsx
// packages/web/src/app/discovery/page.tsx
"use client";

import { useEffect, useState } from "react";
import type { DiscoveryReport } from "@vipcam/shared";
import { getLastDiscoveryReport, runDiscovery } from "@/lib/api-client";
import { ProbeTable } from "./components/ProbeTable";

export default function DiscoveryPage() {
  const [report, setReport] = useState<DiscoveryReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captureSeconds, setCaptureSeconds] = useState(600);

  useEffect(() => {
    getLastDiscoveryReport().then(setReport).catch(() => setReport(null));
  }, []);

  async function handleRun() {
    setLoading(true);
    setError(null);
    try {
      const r = await runDiscovery(captureSeconds);
      setReport(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-semibold">Discovery — DH-IPC-HFW5442T-ASE</h1>
      <p className="mt-2 text-neutral-600">
        Roda probes contra a câmera e captura eventos por N segundos. Resultado fica salvo em{" "}
        <code>discovery-output/</code>.
      </p>

      <div className="mt-6 flex items-center gap-3">
        <label className="text-sm">
          Captura (segundos):{" "}
          <input
            type="number"
            value={captureSeconds}
            onChange={(e) => setCaptureSeconds(Number(e.target.value))}
            min={10}
            max={3600}
            className="w-24 rounded border border-neutral-300 p-1"
          />
        </label>
        <button
          onClick={handleRun}
          disabled={loading}
          className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading ? "Rodando..." : "Rodar Discovery"}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          ❌ {error}
        </div>
      )}

      {report && (
        <section className="mt-8 space-y-6">
          <div className="rounded border border-neutral-200 bg-white p-4">
            <h2 className="text-lg font-semibold">Resumo</h2>
            <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
              <dt className="text-neutral-600">IP:</dt><dd>{report.camera_ip}</dd>
              <dt className="text-neutral-600">Modelo:</dt><dd>{report.camera_model ?? "—"}</dd>
              <dt className="text-neutral-600">Serial:</dt><dd>{report.camera_serial ?? "—"}</dd>
              <dt className="text-neutral-600">Firmware:</dt><dd>{report.firmware ?? "—"}</dd>
              <dt className="text-neutral-600">Eventos capturados:</dt>
              <dd>
                {report.events_captured} (em {report.capture_duration_seconds}s)
              </dd>
              <dt className="text-neutral-600">Idade?</dt><dd>{report.has_age_attribute ? "✅" : "❌"}</dd>
              <dt className="text-neutral-600">Gênero?</dt><dd>{report.has_gender_attribute ? "✅" : "❌"}</dd>
              <dt className="text-neutral-600">Emoção?</dt><dd>{report.has_emotion_attribute ? "✅" : "❌"}</dd>
              <dt className="text-neutral-600">Canal recomendado:</dt>
              <dd className="font-mono">{report.recommended_ingest_channel}</dd>
            </dl>
          </div>

          <div className="rounded border border-neutral-200 bg-white p-4">
            <h2 className="text-lg font-semibold">Probes</h2>
            <div className="mt-2">
              <ProbeTable probes={report.probes} />
            </div>
          </div>

          {report.fork_decision_required.length > 0 && (
            <div className="rounded border border-yellow-300 bg-yellow-50 p-4">
              <h2 className="text-lg font-semibold">⚠ Decisões pendentes</h2>
              <ul className="mt-2 list-disc pl-6 text-sm">
                {report.fork_decision_required.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
```

- [ ] **Step 4: Configurar `.env.local` do web e seu template**

`.env.local` está no `.gitignore` raiz (não commita). Criar dois arquivos:

**`packages/web/.env.example`** (commitado, template):

```bash
NEXT_PUBLIC_API_URL=http://localhost:4000
```

**`packages/web/.env.local`** (local, ignorado pelo git):

```bash
NEXT_PUBLIC_API_URL=http://localhost:4000
```

Confirmar que `.env.local` não vai ser staged:

Run: `git check-ignore packages/web/.env.local && echo "ignored ok"`
Expected: `packages/web/.env.local\nignored ok`.

- [ ] **Step 5: Smoke test do build**

Run: `cd packages/web && bun run build`
Expected: build succeeds. Página `/discovery` aparece no log de rotas.

- [ ] **Step 6: Commit (sem `.env.local`)**

```bash
git add packages/web/src/lib/ packages/web/src/app/discovery/ packages/web/.env.example
git commit -m "feat(web): add /discovery page with probe table and run button"
```

`.env.local` permanece untracked (gitignored) — correto para arquivos com config local.

---

### Task 1.10 [CAMERA]: Rodar discovery contra a câmera real

⚠ **Requer câmera fisicamente acessível na rede e pelo menos uma pessoa passando em frente durante a captura.** Se ainda não há acesso, pular para Task 1.11 (verificação) e voltar a esta depois — mas a Onda 1 só está completa quando 1.10 também tiver rodado.

- [ ] **Step 1: Configurar credenciais (cuidado com vazamento)**

Editar `packages/edge/.env.local`:

```bash
CAMERA_IP=<IP da câmera>
CAMERA_USER=admin
CAMERA_PASS=<senha admin>
```

**Confirmar antes** que `.env.local` está no `.gitignore` (deve estar — verificado no Chunk 0):

Run: `git check-ignore packages/edge/.env.local && echo "ignored ok"`
Expected: `packages/edge/.env.local\nignored ok`. Se não imprimir nada, **abortar** e adicionar ao `.gitignore`.

- [ ] **Step 2: Subir stack e rodar discovery via UI**

Run (em bash — Git Bash no Windows): `bun run dev`

Em outro terminal: abrir `http://localhost:3000/discovery`. Configurar captura para 600s (10 min). Clicar "Rodar Discovery".

**Garantir tráfego durante a janela:** alguém deve passar em frente à câmera várias vezes durante os 10 minutos. Sem rostos detectados, o relatório não consegue distinguir "câmera não emite atributo de emoção" de "nenhuma face apareceu" — o que torna a decisão de fork ambígua. Se ninguém passou, repetir a captura.

- [ ] **Step 3: Aguardar conclusão e inspecionar relatório**

Após ~10 minutos, a página exibe o relatório. Verificar:
- Probes que retornaram `ok` vs `not_found`/`auth_failed`/`error`
- Quantos eventos foram capturados (`events_captured > 0` é pré-requisito para qualquer conclusão sobre atributos)
- Se idade/gênero/emoção foram detectados
- Decisões pendentes listadas em `fork_decision_required`

- [ ] **Step 4: Inspecionar artefatos persistidos (Git Bash)**

```bash
ls discovery-output/run-*/
sed -n '1,80p' discovery-output/run-*/report.md
head -n 3 discovery-output/run-*/events-*.ndjson
```

- [ ] **Step 5: Validar contrato do fork de design (cross-ref com Chunk 1A)**

Antes de "decidir o fork", confirmar que o `report.fork_decision_required` foi corretamente populado:
- Se `report.events_captured == 0` → o array deve conter "Nenhum evento capturado..." (definido em `buildReport` na Task 1.7).
- Se `report.events_captured > 0` e `has_emotion_attribute == false` → o array deve conter "Câmera não entregou atributo de emoção..." (gatilho do fork 10.2 da spec).

Se nenhum desses textos aparecer quando esperado, há bug em `buildReport` — voltar e corrigir antes de prosseguir.

- [ ] **Step 6: Decisão de fork (se aplicável)**

Se o relatório listar o fork de design 10.2 (emoção ausente):
- Discutir com o usuário/owner: opção (a) seguir só com idade/gênero, ou (b) adicionar HSEmotion ONNX no sidecar reid (~1 semana adicional).
- Documentar a decisão criando seção `## Decisão tomada em <data>` no final do `report.md` gerado.
- Atualizar a spec `docs/superpowers/specs/2026-04-29-camera-monitoring-design.md` (Seção 11 — Riscos, linha de R1) com o resultado e a justificativa.

- [ ] **Step 7: Commit do relatório (opcional, se quiser histórico em git)**

Atenção: se o relatório contém serial/IP da câmera ou outros dados sensíveis, **não commitar bruto**. Por padrão, `discovery-output/` está no `.gitignore`.

Se quiser preservar o relatório no git para referência futura, primeiro **redatar** dados sensíveis (substituir IP por `xxx.xxx.xxx.xxx`, serial por `REDACTED`) e depois copiar o markdown:

```bash
mkdir -p docs/superpowers/specs/discovery
cp discovery-output/run-*/report.md docs/superpowers/specs/discovery/report-$(date +%Y-%m-%d).md
# Editar manualmente para redatar IP/serial antes de commitar:
${EDITOR:-code} docs/superpowers/specs/discovery/report-*.md
git add docs/superpowers/specs/discovery/report-*.md
git commit -m "docs: snapshot of camera discovery report (REDACTED, $(date +%Y-%m-%d))"
```

---

### Task 1.11: Verificação final da Onda 1

Aplique @superpowers:verification-before-completion antes de declarar a Onda 1 completa.

- [ ] **Step 1: Suíte de testes completa**

Run: `cd packages/edge && bun test`
Expected: todos os testes (env, dahua-http-client, prober, probes, capture, report, api/discovery) passam.

- [ ] **Step 2: Typecheck completo**

Run: `bun run typecheck`
Expected: zero errors.

- [ ] **Step 3: Lint completo**

Run: `bun run lint`
Expected: zero errors.

- [ ] **Step 4: Build do frontend**

Run: `cd packages/web && bun run build`
Expected: build succeeds, rota `/discovery` listada.

- [ ] **Step 5: Smoke test final (Git Bash recomendado)**

⚠ Usar **Git Bash** no Windows (não PowerShell) — `kill %1` e `&` são sintaxe bash. Em PowerShell, usar `Start-Process` e `Stop-Process`.

Run: `bun run dev &`

Em vez de `sleep 8`, fazer **polling até backend responder** (evita flakes em cold start lento):

```bash
for i in $(seq 1 30); do
  if curl -fs http://localhost:4000/api/health > /dev/null 2>&1; then break; fi
  sleep 1
done
```

Então validar cada serviço — não basta que o HTTP responda, queremos validar conteúdo:
- `curl -fs http://localhost:4000/api/health | grep -q '"status":"healthy"' && echo "edge ok"`
- `curl -fs http://localhost:3000/discovery | grep -q 'Discovery' && echo "discovery page rendered ok"` (verifica que a SSR/CSR renderizou o título, não só que o shell HTML chegou)
- `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/api/discovery/last-report` deve imprimir `404` (sem relatório ainda) ou `200` (se Task 1.10 rodou).

Then: `kill %1`

- [ ] **Step 6: Documentar próximos passos no spec**

Após Task 1.10 ter sido executada e o relatório validado, adicionar uma nota no início da spec `docs/superpowers/specs/2026-04-29-camera-monitoring-design.md` registrando:

```markdown
## 0. Discovery validado em [data]

- Modelo confirmado: [valor do report]
- Canal de ingest escolhido: [http_attach_sse | polling | onvif]
- Atributos confirmados: idade=[sim/não], gênero=[sim/não], emoção=[sim/não]
- Fork 10.2 resolvido como: [a / b / não aplicável]
- Próxima onda de planejamento: Fase 2 (modelo + ingest)
```

Commit:

```bash
git add docs/superpowers/specs/2026-04-29-camera-monitoring-design.md
git commit -m "docs: register discovery findings (Onda 1 closure)"
```

**Checkpoint Onda 1 atingido (requer Task 1.10 ter sido executada contra câmera real):** scaffolding pronto + discovery executado + relatório com decisões documentadas + fork 10.2 resolvido (se aplicável). Se Task 1.10 ainda não foi executada por falta de acesso à câmera, a Onda 1 está **parcialmente concluída** — toda a Onda 2 fica bloqueada até 1.10 acontecer e o resultado ser registrado na spec.

---

## Próximas ondas (placeholder, não planejar agora)

- **Onda 2:** Fases 2 + 3 + 4 — modelo de dados, ingest real, re-id estratégia A, ERP + match temporal + sync funcionários. Planejada após esta onda completar.
- **Onda 3:** Fases 5 + 6 — frontend completo, failover B (re-id local).
- **Onda 4:** Fase 7 — hardening + deploy on-premise.

A escolha de planejar em ondas é deliberada: o discovery (Task 1.10) pode mudar premissas significativas do design, e plano não-executado é trabalho desperdiçado.
