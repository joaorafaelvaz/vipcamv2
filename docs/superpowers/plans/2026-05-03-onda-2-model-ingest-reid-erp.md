# Onda 2 — Modelo + Ingest + Re-id A + ERP (Fases 2+3+4) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar pipeline de ingestão completa do MVP — eventos da câmera Dahua persistem em DB normalizado (detections + sessions), pessoas são identificadas via Face DB embarcado da câmera (estratégia A), funcionários são auto-cadastrados a partir do ERP, e clientes são vinculados aos seus check-ins via match temporal.

**Architecture:** Drizzle ORM + PostgreSQL (pgvector) para persistência. `ingest/listener.ts` mantém long-poll persistente contra `eventManager.cgi attach`, normaliza eventos Dahua em `CanonicalEvent`, e despacha para o `pipeline` que faz re-id (lookup no `face_records`) + persistência (`detections` + `sessions` upsert por gap). `erp-sync/` lê MySQL local do ERP via `mysql2`, sincroniza funcionários (incluindo upload de fotos pro Face DB câmera) e clientes/check-ins. `match-temp/` observa novos check-ins do ERP e tenta vincular a faces anônimas dentro de janela ±5min.

**Tech Stack:** Drizzle ORM 0.36+, postgres 3.4+ (driver), `drizzle-kit` 0.27+ (migrations), `mysql2` 3.11+ (ERP), `node-cron` 3.0+ (scheduler), pgvector via `pgvector/pgvector:pg16` (já provisionado em Onda 1).

**Spec referenciada:** `docs/superpowers/specs/2026-04-29-camera-monitoring-design.md` — Seções 4 (modelo), 5 (fluxos), 6 (API), 10 Fases 2/3/4.

**Skills durante execução:**
- @superpowers:test-driven-development (módulos de regra: normalizer, session-tracker, matcher)
- @superpowers:verification-before-completion (antes de declarar tarefa completa)
- @superpowers:systematic-debugging (quando algo quebrar)

**Pré-requisitos no ambiente:**
- Onda 1 mergeada em master (commit `2b4e1c1` ou descendente)
- Docker Desktop rodando (Postgres + pgvector via `docker compose up -d postgres`)
- MySQL do ERP local já em execução (porta default 3306; adapte env)
- Bun ≥1.3, Node ≥20 não necessário
- (Recomendado mas não bloqueante) Discovery report de Task 1.10 com `recommended_ingest_channel = http_attach_sse` e atributos confirmados

---

## ⚠ Premissas dependentes do Discovery (Task 1.10)

Esta onda foi planejada antes da Task 1.10 ser executada contra a câmera real. Os pontos abaixo precisam ser validados pelo relatório de discovery:

| # | Premissa | Tasks afetadas se refutada |
|---|---|---|
| P1 | Câmera entrega eventos via `eventManager.cgi attach` (multipart/x-mixed-replace). Já validado pelo parser do Chunk 1A. | 2.10 (ingest listener) |
| P2 | Eventos `Code=FaceDetection` ou `Code=FaceRecognition` carregam `data.Age`, `data.Gender`, `data.Expression` (ou `Emotion`/`Mood`), e algum identificador de tracking estável (`ObjectID`/`TrackID`). | 2.8 (canonical event), 2.9 (normalizer) |
| P3 | Face DB embarcado expõe CRUD via CGI. Endpoints prováveis: `FaceInfoManager.cgi action=add/getCollection/delete` ou `FaceDB.cgi`. | 3.1 (face DB client), 3.2 (admin endpoints) |
| P4 | Eventos com pessoa cadastrada no Face DB carregam um `FaceID`/`PersonID` (ou similar) que mapeia 1:1 ao registro do Face DB. | 3.3 (reid lookup) |
| P5 | Snapshot por demanda funciona em `/cgi-bin/snapshot.cgi?channel=1`. Já validado por probe em Chunk 1A. | 4.4 (upload de funcionário), 4.10 (upload-back) |

**Política:** se uma premissa for refutada, **pause a task afetada e revise o plano** (ou abra Onda 2.5 de adaptação). Não tente "improvisar" — a câmera Dahua tem variações por firmware/modelo que tornam adivinhação custosa.

---

## Chunk 2: Fase 2 — Modelo de dados + ingest básico

Esta fase entrega: Postgres com schema completo, repositories tipados, normalizador de eventos Dahua, e ingest listener persistente que grava `detections` + `sessions` em tempo real.

### Task 2.1: Setup do driver Postgres + Drizzle config

**Files:**
- Modify: `packages/edge/package.json` (deps: drizzle-orm, postgres, drizzle-kit)
- Create: `packages/edge/drizzle.config.ts`
- Create: `packages/edge/src/persistence/db.ts`
- Modify: `packages/edge/src/config/env.ts` (adicionar DATABASE_URL)
- Modify: `packages/edge/.env.example`
- Modify: `packages/edge/tests/unit/config/env.test.ts`

- [ ] **Step 1: Adicionar DATABASE_URL ao env schema (TDD RED)**

Adicionar ao `tests/unit/config/env.test.ts`:

```typescript
test("aceita DATABASE_URL válido (postgres://)", () => {
  const result = parseEnv({
    API_KEY: "k",
    DATABASE_URL: "postgres://vipcam:vipcam@localhost:5432/vipcam",
  });
  expect(result.DATABASE_URL).toBe("postgres://vipcam:vipcam@localhost:5432/vipcam");
});

test("permite DATABASE_URL ausente (modo sem DB)", () => {
  const result = parseEnv({ API_KEY: "k" });
  expect(result.DATABASE_URL).toBeUndefined();
});

test("rejeita DATABASE_URL com schema inválido", () => {
  expect(() =>
    parseEnv({ API_KEY: "k", DATABASE_URL: "sqlite:///vipcam.db" }),
  ).toThrow();
});
```

Run: `cd packages/edge && bun test tests/unit/config/env.test.ts`
Expected: 3 novos testes falham.

- [ ] **Step 2: Implementar (GREEN)**

Adicionar ao `envSchema` em `src/config/env.ts`:

```typescript
DATABASE_URL: z
  .string()
  .regex(/^postgres(ql)?:\/\//, "DATABASE_URL must start with postgres:// or postgresql://")
  .optional(),
```

Run: `bun test tests/unit/config/env.test.ts` → 10 tests pass.

- [ ] **Step 3: Atualizar `.env.example`**

```bash
# Database (Postgres + pgvector via docker-compose)
DATABASE_URL=postgres://vipcam:vipcam@localhost:5432/vipcam
```

- [ ] **Step 4: Instalar deps**

```bash
cd packages/edge && bun add drizzle-orm postgres && bun add -d drizzle-kit
```

- [ ] **Step 5: Criar `packages/edge/drizzle.config.ts`**

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/persistence/schema/index.ts",
  out: "./src/persistence/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://vipcam:vipcam@localhost:5432/vipcam",
  },
  // Verbose nos comandos para debugging
  verbose: true,
  strict: true,
});
```

- [ ] **Step 6: Criar `packages/edge/src/persistence/db.ts`**

```typescript
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getEnv } from "../config/env.js";
import { logger } from "../obs/logger.js";

let _db: PostgresJsDatabase | undefined;
let _client: ReturnType<typeof postgres> | undefined;

export function getDb(): PostgresJsDatabase {
  if (_db) return _db;
  const env = getEnv();
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to use the database");
  }
  _client = postgres(env.DATABASE_URL, {
    max: 10,
    idle_timeout: 30,
    onnotice: (n) => logger.debug({ notice: n }, "pg notice"),
  });
  _db = drizzle(_client);
  logger.info("postgres connection initialized");
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.end({ timeout: 5 });
    _client = undefined;
    _db = undefined;
  }
}
```

- [ ] **Step 7: Smoke test conexão**

```bash
docker compose up -d postgres
cd packages/edge && API_KEY=k DATABASE_URL=postgres://vipcam:vipcam@localhost:5432/vipcam \
  bun -e "import('./src/persistence/db.ts').then(async m => { const db = m.getDb(); const r = await db.execute('SELECT 1 as ok'); console.log(r); await m.closeDb(); })"
```
Expected: Imprime `[{ ok: 1 }]`.

- [ ] **Step 8: Commit**

```bash
git add packages/edge/package.json packages/edge/bun.lock packages/edge/drizzle.config.ts \
  packages/edge/src/persistence/db.ts packages/edge/src/config/env.ts \
  packages/edge/.env.example packages/edge/tests/unit/config/env.test.ts
git commit -m "feat(persistence): add Drizzle + postgres-js with lazy connection pool"
```

---

### Task 2.2: Schema de `cameras` + migration infra

**Files:**
- Create: `packages/edge/src/persistence/schema/cameras.ts`
- Create: `packages/edge/src/persistence/schema/index.ts`
- Create: `packages/edge/src/persistence/migrations/.gitkeep`
- Modify: `packages/edge/package.json` (scripts db:generate / db:migrate)

- [ ] **Step 1: Criar `schema/cameras.ts`**

```typescript
import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const cameras = pgTable("cameras", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  ip_address: text("ip_address").notNull(),
  // env var name que guarda usuário/senha (ex: "CAMERA_USER" / "CAMERA_PASS").
  // Não armazenamos credentials em DB.
  credentials_ref: text("credentials_ref").notNull().default("CAMERA"),
  face_db_capacity: integer("face_db_capacity").notNull().default(10000),
  face_db_used: integer("face_db_used").notNull().default(0),
  is_active: boolean("is_active").notNull().default(true),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Camera = typeof cameras.$inferSelect;
export type NewCamera = typeof cameras.$inferInsert;
```

- [ ] **Step 2: Criar `schema/index.ts` (barrel)**

```typescript
export * from "./cameras.js";
```

- [ ] **Step 3: Adicionar scripts em `packages/edge/package.json`**

```json
"db:generate": "drizzle-kit generate",
"db:migrate": "bun -e 'import(\"./src/persistence/migrate.ts\")'",
"db:studio": "drizzle-kit studio"
```

- [ ] **Step 4: Criar `src/persistence/migrate.ts`**

```typescript
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { join } from "node:path";
import { closeDb, getDb } from "./db.js";
import { logger } from "../obs/logger.js";

async function run() {
  const db = getDb();
  const folder = join(import.meta.dir, "migrations");
  logger.info({ folder }, "running migrations");
  await migrate(db, { migrationsFolder: folder });
  logger.info("migrations complete");
  await closeDb();
}

run().catch((err) => {
  logger.error({ err }, "migrations failed");
  process.exit(1);
});
```

- [ ] **Step 5: Gerar primeira migration + aplicar**

```bash
cd packages/edge
DATABASE_URL=postgres://vipcam:vipcam@localhost:5432/vipcam bun run db:generate
# ⇒ cria packages/edge/src/persistence/migrations/0000_xxxx.sql

API_KEY=k DATABASE_URL=postgres://vipcam:vipcam@localhost:5432/vipcam bun run db:migrate
# ⇒ aplica em postgres
```

Verificar: `docker exec vipcam-postgres psql -U vipcam -d vipcam -c "\dt"` → tabela `cameras` existe.

- [ ] **Step 6: Commit**

```bash
git add packages/edge/src/persistence/schema/ packages/edge/src/persistence/migrate.ts \
  packages/edge/src/persistence/migrations/ packages/edge/package.json
git commit -m "feat(persistence): add cameras schema + drizzle migration infra"
```

---

### Task 2.3: Schemas `persons` + `face_records` (com pgvector)

**Files:**
- Create: `packages/edge/src/persistence/schema/persons.ts`
- Create: `packages/edge/src/persistence/schema/face-records.ts`
- Modify: `packages/edge/src/persistence/schema/index.ts`

- [ ] **Step 1: `persons.ts`**

```typescript
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const personType = pgEnum("person_type", ["client", "employee", "anonymous"]);

export const persons = pgTable(
  "persons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    display_name: text("display_name"),
    person_type: personType("person_type").notNull().default("anonymous"),
    erp_client_id: text("erp_client_id"),
    erp_employee_id: text("erp_employee_id"),
    first_seen_at: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    last_seen_at: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    total_visits: integer("total_visits").notNull().default(1),
    avg_satisfaction: real("avg_satisfaction"),
    estimated_age: integer("estimated_age"),
    estimated_gender: text("estimated_gender"),
    thumbnail_path: text("thumbnail_path"),
    notes: text("notes"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    erp_client_idx: index("persons_erp_client_idx").on(t.erp_client_id),
    erp_employee_idx: index("persons_erp_employee_idx").on(t.erp_employee_id),
    last_seen_idx: index("persons_last_seen_idx").on(t.last_seen_at),
  }),
);

export type Person = typeof persons.$inferSelect;
export type NewPerson = typeof persons.$inferInsert;
```

- [ ] **Step 2: `face-records.ts` (com pgvector)**

```typescript
import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { persons } from "./persons.js";

// pgvector custom type — vetor de 512 dimensões usado pelo failover B (InsightFace buffalo_s).
// Inicializado vazio na Onda 2; populado quando reid-mgr cair em B (Onda 3 ou Fase 6 conforme plano).
const vector512 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(512)";
  },
  toDriver(value: number[]) {
    return `[${value.join(",")}]`;
  },
});

export const faceRecords = pgTable(
  "face_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    person_id: uuid("person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    // ID retornado pelo Face DB embarcado da câmera (estratégia A)
    camera_face_id: text("camera_face_id"),
    embedding: vector512("embedding"),
    snapshot_path: text("snapshot_path").notNull(),
    is_primary: boolean("is_primary").notNull().default(false),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    person_idx: index("face_records_person_idx").on(t.person_id),
    camera_face_idx: index("face_records_camera_face_idx").on(t.camera_face_id),
    // HNSW index para failover B — m=16, ef_construction=64 são defaults sãos.
    // Índice criado mesmo com tabela vazia, evita migration mid-project (advisory da spec §4.1).
    embedding_hnsw_idx: index("face_records_embedding_hnsw_idx")
      .using("hnsw", sql`embedding vector_cosine_ops`)
      .with({ m: 16, ef_construction: 64 }),
  }),
);

export type FaceRecord = typeof faceRecords.$inferSelect;
export type NewFaceRecord = typeof faceRecords.$inferInsert;
```

- [ ] **Step 3: Atualizar barrel + gerar migration**

`schema/index.ts`:
```typescript
export * from "./cameras.js";
export * from "./persons.js";
export * from "./face-records.js";
```

```bash
cd packages/edge
DATABASE_URL=postgres://vipcam:vipcam@localhost:5432/vipcam bun run db:generate
API_KEY=k DATABASE_URL=postgres://vipcam:vipcam@localhost:5432/vipcam bun run db:migrate
```

Verificar índice HNSW criado:
```bash
docker exec vipcam-postgres psql -U vipcam -d vipcam -c \
  "SELECT indexname FROM pg_indexes WHERE tablename = 'face_records';"
```
Expected: lista incluindo `face_records_embedding_hnsw_idx`.

- [ ] **Step 4: Commit**

```bash
git add packages/edge/src/persistence/schema/ packages/edge/src/persistence/migrations/
git commit -m "feat(persistence): add persons + face_records schemas with pgvector HNSW index"
```

---

### Task 2.4: Schemas `detections` + `sessions` + `sentiment_records`

**Files:**
- Create: `packages/edge/src/persistence/schema/sessions.ts`
- Create: `packages/edge/src/persistence/schema/detections.ts`
- Create: `packages/edge/src/persistence/schema/sentiment-records.ts`

- [ ] **Step 1: `sessions.ts`**

```typescript
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { cameras } from "./cameras.js";
import { persons } from "./persons.js";

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    person_id: uuid("person_id").references(() => persons.id, { onDelete: "set null" }),
    camera_id: uuid("camera_id")
      .notNull()
      .references(() => cameras.id, { onDelete: "cascade" }),
    // Track ID atual da câmera (estável durante a sessão, descartado quando fecha).
    // Permite findOpenForTrack reusar sessão sem JOIN em detections.
    current_track_id: text("current_track_id"),
    started_at: timestamp("started_at", { withTimezone: true }).notNull(),
    // Atualizado a cada nova detection — usado pelo gap-based session tracker.
    last_seen_at: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    ended_at: timestamp("ended_at", { withTimezone: true }),
    detection_count: integer("detection_count").notNull().default(0),
    dominant_emotion: text("dominant_emotion"),
    avg_emotion_scores: jsonb("avg_emotion_scores")
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'`),
    linked_erp_checkin_id: text("linked_erp_checkin_id"),
  },
  (t) => ({
    person_idx: index("sessions_person_idx").on(t.person_id),
    camera_idx: index("sessions_camera_idx").on(t.camera_id),
    started_idx: index("sessions_started_idx").on(t.started_at),
    // sessões "abertas" (ended_at IS NULL) são consultadas com frequência
    open_idx: index("sessions_open_idx").on(t.camera_id, t.started_at),
    // Lookup crítico do session-tracker: sessão aberta para (camera, track)
    open_track_idx: index("sessions_open_track_idx")
      .on(t.camera_id, t.current_track_id)
      .where(sql`${t.ended_at} IS NULL`),
  }),
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
```

- [ ] **Step 2: `detections.ts`**

```typescript
import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { cameras } from "./cameras.js";
import { persons } from "./persons.js";
import { sessions } from "./sessions.js";

export const detections = pgTable(
  "detections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    camera_id: uuid("camera_id")
      .notNull()
      .references(() => cameras.id, { onDelete: "cascade" }),
    person_id: uuid("person_id").references(() => persons.id, { onDelete: "set null" }),
    session_id: uuid("session_id").references(() => sessions.id, { onDelete: "cascade" }),
    // ID de tracking dentro da sessão da câmera (não estável entre sessões)
    track_id: text("track_id"),
    bbox: jsonb("bbox").$type<{ x: number; y: number; w: number; h: number }>(),
    face_attrs: jsonb("face_attrs")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    dominant_emotion: text("dominant_emotion"),
    emotion_confidence: real("emotion_confidence"),
    snapshot_path: text("snapshot_path"),
    detected_at: timestamp("detected_at", { withTimezone: true }).notNull(),
    // Payload original Dahua para auditoria; truncado pelo retention job após 30d
    raw_event: jsonb("raw_event").notNull(),
  },
  (t) => ({
    camera_idx: index("detections_camera_idx").on(t.camera_id),
    person_idx: index("detections_person_idx").on(t.person_id),
    session_idx: index("detections_session_idx").on(t.session_id),
    detected_idx: index("detections_detected_idx").on(t.detected_at),
    // Query crítica do match temporal: anônimas em janela de tempo
    anonymous_window_idx: index("detections_anonymous_window_idx")
      .on(t.detected_at)
      .where(sql`${t.person_id} IS NULL`),
  }),
);

export type Detection = typeof detections.$inferSelect;
export type NewDetection = typeof detections.$inferInsert;
```

- [ ] **Step 3: `sentiment-records.ts`**

```typescript
import { index, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { detections } from "./detections.js";
import { persons } from "./persons.js";
import { sessions } from "./sessions.js";

export const sentimentRecords = pgTable(
  "sentiment_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Granular: 1 por detection durante 30 dias; agregado depois (consolidado em sessions.avg_emotion_scores)
    detection_id: uuid("detection_id").references(() => detections.id, { onDelete: "cascade" }),
    session_id: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    person_id: uuid("person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    emotion: text("emotion").notNull(),
    confidence: real("confidence").notNull(),
    recorded_at: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    person_recorded_idx: index("sentiment_person_recorded_idx").on(t.person_id, t.recorded_at),
    session_idx: index("sentiment_session_idx").on(t.session_id),
  }),
);

export type SentimentRecord = typeof sentimentRecords.$inferSelect;
export type NewSentimentRecord = typeof sentimentRecords.$inferInsert;
```

- [ ] **Step 4: Atualizar barrel + migrate**

`schema/index.ts` adiciona os 3.

```bash
bun run db:generate
API_KEY=k DATABASE_URL=postgres://vipcam:vipcam@localhost:5432/vipcam bun run db:migrate
```

- [ ] **Step 5: Commit**

```bash
git add packages/edge/src/persistence/schema/ packages/edge/src/persistence/migrations/
git commit -m "feat(persistence): add detections + sessions + sentiment_records schemas"
```

---

### Task 2.5: Schemas `erp_*` + `match_attempts`

**Files:**
- Create: `packages/edge/src/persistence/schema/erp-cache.ts`
- Create: `packages/edge/src/persistence/schema/match-attempts.ts`

- [ ] **Step 1: `erp-cache.ts` (3 tabelas em 1 arquivo, todas espelham ERP)**

```typescript
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const erpClients = pgTable(
  "erp_clients",
  {
    erp_id: text("erp_id").primaryKey(), // string porque ERP pode usar formatos variados
    name: text("name").notNull(),
    phone: text("phone"),
    photo_path: text("photo_path"),
    is_active: boolean("is_active").notNull().default(true),
    erp_updated_at: timestamp("erp_updated_at", { withTimezone: true }),
    synced_at: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    name_idx: index("erp_clients_name_idx").on(t.name),
  }),
);

export const erpEmployees = pgTable(
  "erp_employees",
  {
    erp_id: text("erp_id").primaryKey(),
    name: text("name").notNull(),
    role: text("role"),
    photo_path: text("photo_path"),
    photo_hash: text("photo_hash"), // SHA-256 da foto, usado pra detectar mudanças
    is_active: boolean("is_active").notNull().default(true),
    erp_updated_at: timestamp("erp_updated_at", { withTimezone: true }),
    synced_at: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    name_idx: index("erp_employees_name_idx").on(t.name),
  }),
);

export const erpCheckins = pgTable(
  "erp_checkins",
  {
    erp_id: text("erp_id").primaryKey(), // ID do checkin no ERP
    erp_client_id: text("erp_client_id").notNull(),
    event_type: text("event_type").notNull(), // "appointment_confirmed" | "service_started" | etc.
    occurred_at: timestamp("occurred_at", { withTimezone: true }).notNull(),
    processed_at: timestamp("processed_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
  },
  (t) => ({
    client_idx: index("erp_checkins_client_idx").on(t.erp_client_id),
    occurred_idx: index("erp_checkins_occurred_idx").on(t.occurred_at),
    // Query crítica: checkins não-processados ordenados por tempo
    unprocessed_idx: index("erp_checkins_unprocessed_idx")
      .on(t.occurred_at)
      .where(sql`${t.processed_at} IS NULL`),
  }),
);

// Type exports
export type ErpClient = typeof erpClients.$inferSelect;
export type NewErpClient = typeof erpClients.$inferInsert;
export type ErpEmployee = typeof erpEmployees.$inferSelect;
export type NewErpEmployee = typeof erpEmployees.$inferInsert;
export type ErpCheckin = typeof erpCheckins.$inferSelect;
export type NewErpCheckin = typeof erpCheckins.$inferInsert;
```

- [ ] **Step 2: `match-attempts.ts`**

```typescript
import { sql } from "drizzle-orm";
import { index, pgEnum, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { detections } from "./detections.js";
import { erpCheckins } from "./erp-cache.js";

export const matchDecision = pgEnum("match_decision", ["auto_matched", "ambiguous", "rejected"]);
export const matchDecidedBy = pgEnum("match_decided_by", ["system", "user"]);

export const matchAttempts = pgTable(
  "match_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    detection_id: uuid("detection_id").references(() => detections.id, {
      onDelete: "cascade",
    }),
    erp_checkin_id: text("erp_checkin_id").references(() => erpCheckins.erp_id, {
      onDelete: "cascade",
    }),
    confidence_score: real("confidence_score"),
    decision: matchDecision("decision").notNull(),
    decided_at: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    decided_by: matchDecidedBy("decided_by").notNull().default("system"),
    notes: text("notes"),
  },
  (t) => ({
    decision_idx: index("match_attempts_decision_idx").on(t.decision),
    detection_idx: index("match_attempts_detection_idx").on(t.detection_id),
    checkin_idx: index("match_attempts_checkin_idx").on(t.erp_checkin_id),
    // Query crítica da UI: ambíguos pendentes de revisão
    pending_idx: index("match_attempts_pending_idx")
      .on(t.decided_at)
      .where(sql`${t.decision} = 'ambiguous'`),
  }),
);

export type MatchAttempt = typeof matchAttempts.$inferSelect;
export type NewMatchAttempt = typeof matchAttempts.$inferInsert;
```

- [ ] **Step 3: Atualizar barrel + migrate + commit**

```bash
bun run db:generate
API_KEY=k DATABASE_URL=postgres://vipcam:vipcam@localhost:5432/vipcam bun run db:migrate

git add packages/edge/src/persistence/schema/ packages/edge/src/persistence/migrations/
git commit -m "feat(persistence): add erp_cache + match_attempts schemas"
```

Verificar tudo via `\dt`:
```bash
docker exec vipcam-postgres psql -U vipcam -d vipcam -c "\dt"
# 10 tabelas esperadas: cameras, persons, face_records, sessions, detections,
#                        sentiment_records, erp_clients, erp_employees, erp_checkins, match_attempts
```

---

### Task 2.6: Repositories layer

Padrão: cada repo expõe métodos CRUD + queries específicas. Usa `getDb()` lazy.

**Files:**
- Create: `packages/edge/src/persistence/repositories/persons.repo.ts`
- Create: `packages/edge/src/persistence/repositories/face-records.repo.ts`
- Create: `packages/edge/src/persistence/repositories/detections.repo.ts`
- Create: `packages/edge/src/persistence/repositories/sessions.repo.ts`
- Create: `packages/edge/src/persistence/repositories/erp.repo.ts`
- Create: `packages/edge/src/persistence/repositories/match-attempts.repo.ts`
- Create: `packages/edge/src/persistence/repositories/cameras.repo.ts`
- Create: `packages/edge/src/persistence/repositories/index.ts`
- Create: `packages/edge/tests/integration/persistence/persons.repo.test.ts`
- Create: `packages/edge/tests/integration/persistence/_helpers.ts`

- [ ] **Step 1: Helper de testes integration (testcontainers Postgres)**

`tests/integration/persistence/_helpers.ts`:

```typescript
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getDb } from "../../../src/persistence/db.js";

/**
 * Trunca todas as tabelas para isolamento de teste. Mais rápido que dropar/recriar.
 * Pré-requisito: schema já aplicado via `bun run db:migrate`.
 */
export async function truncateAll(db: PostgresJsDatabase = getDb()): Promise<void> {
  await db.execute(sql`
    TRUNCATE TABLE
      match_attempts,
      sentiment_records,
      detections,
      sessions,
      face_records,
      persons,
      cameras,
      erp_checkins,
      erp_employees,
      erp_clients
    RESTART IDENTITY CASCADE
  `);
}
```

- [ ] **Step 2: TDD — Teste do PersonRepo**

`tests/integration/persistence/persons.repo.test.ts`:

```typescript
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, getDb } from "../../../src/persistence/db.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";
import { truncateAll } from "./_helpers.js";

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
});

describe("personsRepo", () => {
  test("create + findById round-trip", async () => {
    const created = await personsRepo.create({ display_name: "Test" });
    expect(created.id).toBeDefined();
    expect(created.person_type).toBe("anonymous");

    const found = await personsRepo.findById(created.id);
    expect(found?.display_name).toBe("Test");
  });

  test("findByErpEmployeeId retorna funcionário cadastrado", async () => {
    await personsRepo.create({
      display_name: "Funcionário X",
      person_type: "employee",
      erp_employee_id: "emp-123",
    });
    const found = await personsRepo.findByErpEmployeeId("emp-123");
    expect(found?.display_name).toBe("Funcionário X");
  });

  test("update incrementa updated_at e total_visits", async () => {
    const p = await personsRepo.create({ display_name: "Cliente" });
    await new Promise((r) => setTimeout(r, 10));
    const updated = await personsRepo.update(p.id, {
      total_visits: 5,
      last_seen_at: new Date(),
    });
    expect(updated?.total_visits).toBe(5);
    expect(updated?.updated_at.getTime()).toBeGreaterThan(p.updated_at.getTime());
  });
});
```

Run (expects FAIL, repo não existe):
```bash
cd packages/edge && API_KEY=k DATABASE_URL=postgres://vipcam:vipcam@localhost:5432/vipcam \
  bun test tests/integration/persistence/persons.repo.test.ts
```

- [ ] **Step 3: Implementar `persons.repo.ts` (GREEN)**

```typescript
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import { type NewPerson, type Person, persons } from "../schema/persons.js";

export const personsRepo = {
  async create(data: Omit<NewPerson, "id">): Promise<Person> {
    const [p] = await getDb().insert(persons).values(data).returning();
    if (!p) throw new Error("insert returned no row");
    return p;
  },

  async findById(id: string): Promise<Person | null> {
    const rows = await getDb().select().from(persons).where(eq(persons.id, id)).limit(1);
    return rows[0] ?? null;
  },

  async findByErpClientId(erpId: string): Promise<Person | null> {
    const rows = await getDb()
      .select()
      .from(persons)
      .where(eq(persons.erp_client_id, erpId))
      .limit(1);
    return rows[0] ?? null;
  },

  async findByErpEmployeeId(erpId: string): Promise<Person | null> {
    const rows = await getDb()
      .select()
      .from(persons)
      .where(eq(persons.erp_employee_id, erpId))
      .limit(1);
    return rows[0] ?? null;
  },

  async update(id: string, patch: Partial<NewPerson>): Promise<Person | null> {
    const [p] = await getDb()
      .update(persons)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(persons.id, id))
      .returning();
    return p ?? null;
  },

  async incrementVisitCount(id: string, lastSeenAt: Date): Promise<void> {
    await getDb()
      .update(persons)
      .set({
        last_seen_at: lastSeenAt,
        total_visits: sql`${persons.total_visits} + 1`,
        updated_at: sql`now()`,
      })
      .where(eq(persons.id, id));
  },
};
```

Run testes → 3 pass.

- [ ] **Step 4: Implementar repos restantes em batch (mesmo padrão, smoke test mínimo)**

Implementar `cameras.repo.ts`, `face-records.repo.ts`, `detections.repo.ts`, `sessions.repo.ts`, `erp.repo.ts`, `match-attempts.repo.ts` seguindo o padrão do PersonRepo. Cada um com métodos suficientes para o pipeline de ingest e match (não over-engineer).

Métodos críticos por repo:
- `cameras.repo.ts`: `findByName`, `getDefault` (retorna primeira ativa para MVP single-camera), `listActive()`, `findById(id)`
- `face-records.repo.ts`: `findByCameraFaceId(cameraFaceId)`, `create({person_id, camera_face_id, snapshot_path, is_primary})`, `findPrimaryByPersonId(personId)`, `delete(id)`
- `detections.repo.ts`: `create(NewDetection)`, `findById(id)`, `findAnonymousInWindow(start, end)`, `linkToPerson(detectionId, personId)`, `recent(limit)` (ORDER BY detected_at DESC)
- `sessions.repo.ts`: `findOpenForTrack(cameraId, trackId, gapMs)` (retorna sessão `ended_at IS NULL` AND `current_track_id = trackId` AND `last_seen_at >= now - gapMs`), `create(NewSession)` (inicializa `last_seen_at = started_at`, seta `current_track_id`), `appendDetection(sessionId, detectedAt)` (incrementa count + atualiza `last_seen_at`), `close(sessionId, endedAt)`, `linkToPerson(sessionId, personId, erpCheckinId)`
- `erp.repo.ts`: `upsertClient`, `upsertEmployee`, `upsertCheckin`, `findClientByErpId(id)`, `findEmployeeByErpId(id)`, `findCheckinByErpId(id)`, `findUnprocessedCheckinsBefore(before: Date, limit: number)`, `markCheckinProcessed(erpCheckinId)`
- `match-attempts.repo.ts`: `create(NewMatchAttempt)`, `findPending(limit)`, `findByCheckin(erpCheckinId)`

Para cada repo, criar 1 teste smoke (`X.repo.test.ts`) que cobre 1 caminho feliz (ex: create + findById). Para `face-records.repo.ts`, **incluir teste explícito de `findByCameraFaceId`** — é a query crítica do reid-mgr lookup. Total ~7 testes integration novos.

- [ ] **Step 5: Criar `repositories/index.ts` (barrel)**

```typescript
export { camerasRepo } from "./cameras.repo.js";
export { detectionsRepo } from "./detections.repo.js";
export { erpRepo } from "./erp.repo.js";
export { faceRecordsRepo } from "./face-records.repo.js";
export { matchAttemptsRepo } from "./match-attempts.repo.js";
export { personsRepo } from "./persons.repo.js";
export { sessionsRepo } from "./sessions.repo.js";
```

- [ ] **Step 6: Commit por repo**

Commit incremental: 7 commits, um por repo (`feat(persistence): add <name> repository`). Mantém histórico revisável.

---

### Task 2.7: Tipo `CanonicalEvent` compartilhado

**Files:**
- Create: `packages/shared/src/types/ingest-events.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: `ingest-events.ts`**

```typescript
import type { ISO8601 } from "./index.js";

/**
 * Evento canônico do domínio, agnóstico do fabricante da câmera.
 * Normalizers (Dahua hoje, possivelmente Hikvision/Axis no futuro) produzem isso.
 */
export type CanonicalEventType =
  | "person.detected" // Apenas detecção de pessoa (sem face)
  | "face.detected" // Face detectada (com ou sem atributos)
  | "face.recognized"; // Face reconhecida pelo Face DB embarcado

export interface FaceAttributes {
  age?: number;
  age_range?: string;
  gender?: "male" | "female" | "unknown";
  emotion?: string;
  emotion_confidence?: number;
  glasses?: boolean;
  mask?: boolean;
  beard?: boolean;
  // Permite ingest preservar atributos não-mapeados
  raw?: Record<string, unknown>;
}

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CanonicalEvent {
  type: CanonicalEventType;
  camera_id: string; // UUID interno (não o ID da câmera no manufacturer)
  detected_at: ISO8601;
  // Track ID dentro da sessão (estável enquanto pessoa visível)
  track_id?: string;
  // ID no Face DB embarcado da câmera (presente apenas em face.recognized)
  camera_face_id?: string;
  bbox?: BBox;
  face_attrs?: FaceAttributes;
  snapshot_path?: string; // path local ou URL da snapshot, se disponível
  raw_event: Record<string, unknown>; // payload original (Dahua key=value parsed)
}
```

- [ ] **Step 2: Adicionar ao barrel + commit**

```typescript
// packages/shared/src/index.ts (acrescentar)
export * from "./types/ingest-events.js";
```

```bash
git add packages/shared/src/types/ingest-events.ts packages/shared/src/index.ts
git commit -m "feat(shared): add CanonicalEvent + FaceAttributes domain types"
```

---

### Task 2.8: Normalizer Dahua → CanonicalEvent (TDD)

**Files:**
- Create: `packages/edge/src/ingest/normalizer.ts`
- Create: `packages/edge/tests/unit/ingest/normalizer.test.ts`

⚠ **Premissa P2** (atributos no payload Dahua) é load-bearing aqui. Os fixtures deste teste assumem o formato `Code=FaceDetection;action=Start;index=0;data={...}`. Se Discovery Task 1.10 mostrar formato diferente, **revisar os fixtures e o normalizer antes de prosseguir.**

- [ ] **Step 1: TDD RED — testes do normalizer**

```typescript
// packages/edge/tests/unit/ingest/normalizer.test.ts
import { describe, expect, test } from "bun:test";
import type { CapturedEvent } from "../../../src/discovery/capture.js";
import { normalize } from "../../../src/ingest/normalizer.js";

const cameraId = "cam-uuid-xxx";

function makeRaw(code: string, data: Record<string, unknown>): CapturedEvent {
  return {
    index: 0,
    received_at: "2026-05-01T12:00:00Z",
    raw: `Code=${code};action=Start;index=0;data=${JSON.stringify(data)}`,
    parsed: { code, action: "Start", data },
  };
}

describe("normalize", () => {
  test("face.detected com atributos completos", () => {
    const raw = makeRaw("FaceDetection", {
      ObjectID: 123,
      Boundingbox: [100, 200, 300, 400],
      Age: 32,
      Gender: "Male",
      Expression: "Happy",
      ExpressionScore: 0.87,
      Glasses: false,
      Mask: false,
    });
    const ev = normalize(raw, cameraId);
    expect(ev?.type).toBe("face.detected");
    expect(ev?.camera_id).toBe(cameraId);
    expect(ev?.track_id).toBe("123");
    expect(ev?.bbox).toEqual({ x: 100, y: 200, w: 200, h: 200 });
    expect(ev?.face_attrs?.age).toBe(32);
    expect(ev?.face_attrs?.gender).toBe("male");
    expect(ev?.face_attrs?.emotion).toBe("Happy");
    expect(ev?.face_attrs?.emotion_confidence).toBeCloseTo(0.87);
    expect(ev?.face_attrs?.glasses).toBe(false);
  });

  test("face.recognized inclui camera_face_id", () => {
    const raw = makeRaw("FaceRecognition", {
      ObjectID: 456,
      FaceID: "fdb-789",
      Similarity: 92,
      Age: 28,
      Gender: "Female",
    });
    const ev = normalize(raw, cameraId);
    expect(ev?.type).toBe("face.recognized");
    expect(ev?.camera_face_id).toBe("fdb-789");
    expect(ev?.face_attrs?.gender).toBe("female");
  });

  test("retorna null para Code irrelevante (ex: VideoMotion)", () => {
    const raw = makeRaw("VideoMotion", {});
    expect(normalize(raw, cameraId)).toBeNull();
  });

  test("retorna null se action != Start (Stop/Update fora de escopo)", () => {
    const raw: CapturedEvent = {
      index: 0,
      received_at: "x",
      raw: "Code=FaceDetection;action=Stop;index=0",
      parsed: { code: "FaceDetection", action: "Stop", data: {} },
    };
    expect(normalize(raw, cameraId)).toBeNull();
  });

  test("preserva raw_event mesmo com atributos parciais", () => {
    const raw = makeRaw("FaceDetection", { ObjectID: 1 });
    const ev = normalize(raw, cameraId);
    expect(ev?.raw_event).toMatchObject({ ObjectID: 1 });
    expect(ev?.face_attrs?.age).toBeUndefined();
  });
});
```

Run → FAIL (módulo não existe).

- [ ] **Step 2: Implementar `normalizer.ts` (GREEN)**

```typescript
import type { CanonicalEvent, FaceAttributes } from "@vipcam/shared";
import type { CapturedEvent } from "../discovery/capture.js";

const FACE_DETECTION_CODES = new Set(["FaceDetection"]);
const FACE_RECOGNITION_CODES = new Set(["FaceRecognition", "FaceComparison"]);

function parseGender(raw: unknown): FaceAttributes["gender"] {
  if (typeof raw !== "string") return undefined;
  const v = raw.toLowerCase();
  if (v === "male" || v === "m") return "male";
  if (v === "female" || v === "f") return "female";
  if (v === "unknown") return "unknown";
  return undefined;
}

function parseBbox(raw: unknown): CanonicalEvent["bbox"] {
  // Dahua usa [x1, y1, x2, y2]
  if (!Array.isArray(raw) || raw.length !== 4) return undefined;
  const [x1, y1, x2, y2] = raw.map(Number);
  if ([x1, y1, x2, y2].some((n) => !Number.isFinite(n))) return undefined;
  return { x: x1!, y: y1!, w: x2! - x1!, h: y2! - y1! };
}

function parseEmotionConfidence(raw: unknown): number | undefined {
  if (typeof raw !== "number") return undefined;
  // Dahua retorna 0-100 ou 0-1 dependendo de firmware; normaliza pra 0-1
  return raw > 1 ? raw / 100 : raw;
}

function extractAttrs(data: Record<string, unknown>): FaceAttributes {
  const attrs: FaceAttributes = { raw: data };
  const age = Number(data["Age"]);
  if (Number.isFinite(age)) attrs.age = age;
  const ageRange = data["AgeRange"] ?? data["AgeGroup"];
  if (typeof ageRange === "string") attrs.age_range = ageRange;
  const gender = parseGender(data["Gender"] ?? data["Sex"]);
  if (gender) attrs.gender = gender;
  const emotion = data["Expression"] ?? data["Emotion"] ?? data["Mood"];
  if (typeof emotion === "string") attrs.emotion = emotion;
  const conf = parseEmotionConfidence(data["ExpressionScore"] ?? data["EmotionScore"]);
  if (conf !== undefined) attrs.emotion_confidence = conf;
  if (typeof data["Glasses"] === "boolean") attrs.glasses = data["Glasses"];
  if (typeof data["Mask"] === "boolean") attrs.mask = data["Mask"];
  if (typeof data["Beard"] === "boolean") attrs.beard = data["Beard"];
  return attrs;
}

export function normalize(raw: CapturedEvent, cameraId: string): CanonicalEvent | null {
  const code = raw.parsed?.code;
  const action = raw.parsed?.action;
  const data = raw.parsed?.data;
  if (!code || action !== "Start") return null;
  if (!data || typeof data !== "object") return null;
  const dataObj = data as Record<string, unknown>;

  const isRecognition = FACE_RECOGNITION_CODES.has(code);
  const isDetection = FACE_DETECTION_CODES.has(code);
  if (!isRecognition && !isDetection) return null;

  const trackId =
    dataObj["ObjectID"] !== undefined ? String(dataObj["ObjectID"]) : undefined;
  const cameraFaceId =
    dataObj["FaceID"] !== undefined ? String(dataObj["FaceID"]) : undefined;
  const bbox = parseBbox(dataObj["Boundingbox"]);
  const attrs = extractAttrs(dataObj);

  const event: CanonicalEvent = {
    type: isRecognition ? "face.recognized" : "face.detected",
    camera_id: cameraId,
    detected_at: raw.received_at,
    raw_event: dataObj,
  };
  if (trackId !== undefined) event.track_id = trackId;
  if (cameraFaceId !== undefined) event.camera_face_id = cameraFaceId;
  if (bbox !== undefined) event.bbox = bbox;
  if (attrs.age !== undefined || attrs.gender !== undefined || attrs.emotion !== undefined) {
    event.face_attrs = attrs;
  }
  return event;
}
```

Run → 5 pass.

- [ ] **Step 3: Commit**

```bash
git add packages/edge/src/ingest/normalizer.ts packages/edge/tests/unit/ingest/normalizer.test.ts
git commit -m "feat(ingest): add Dahua event normalizer with face attribute extraction"
```

---

### Task 2.9: Session tracker (gap-based session grouping, TDD)

**Files:**
- Create: `packages/edge/src/ingest/session-tracker.ts`
- Create: `packages/edge/tests/unit/ingest/session-tracker.test.ts`

- [ ] **Step 1: TDD RED**

```typescript
// packages/edge/tests/unit/ingest/session-tracker.test.ts
import { describe, expect, test } from "bun:test";
import { shouldStartNewSession } from "../../../src/ingest/session-tracker.js";

const T0 = new Date("2026-05-01T12:00:00Z");
const after = (ms: number) => new Date(T0.getTime() + ms);

describe("shouldStartNewSession", () => {
  test("retorna true se não há sessão aberta", () => {
    expect(shouldStartNewSession(null, T0, 30_000)).toBe(true);
  });

  test("retorna false se gap < gapSeconds", () => {
    const lastSeen = after(0);
    expect(shouldStartNewSession(lastSeen, after(20_000), 30_000)).toBe(false);
  });

  test("retorna true se gap >= gapSeconds", () => {
    const lastSeen = after(0);
    expect(shouldStartNewSession(lastSeen, after(31_000), 30_000)).toBe(true);
  });

  test("retorna true se sessão fechou no passado (lastSeen > now é impossível)", () => {
    expect(shouldStartNewSession(after(60_000), T0, 30_000)).toBe(true);
  });
});
```

Run → FAIL.

- [ ] **Step 2: Implementar (GREEN)**

```typescript
// packages/edge/src/ingest/session-tracker.ts

/**
 * Decide se um novo evento deve iniciar uma nova sessão ou continuar a atual.
 * Lógica: nova sessão se não há aberta OU se gap entre `lastSeenAt` da última
 * detecção e `eventAt` é >= `gapSeconds`.
 *
 * Esta função é puramente determinística — caller (pipeline) é responsável por
 * buscar `lastSeenAt` da sessão aberta para o (camera_id, track_id) específico.
 */
export function shouldStartNewSession(
  lastSeenAt: Date | null,
  eventAt: Date,
  gapMs: number,
): boolean {
  if (!lastSeenAt) return true;
  const diff = eventAt.getTime() - lastSeenAt.getTime();
  return diff < 0 || diff >= gapMs;
}
```

Run → 4 pass.

- [ ] **Step 3: Commit**

```bash
git add packages/edge/src/ingest/session-tracker.ts \
  packages/edge/tests/unit/ingest/session-tracker.test.ts
git commit -m "feat(ingest): add gap-based session tracker"
```

---

### Task 2.10: Ingest pipeline — assembly

**Files:**
- Create: `packages/edge/src/ingest/pipeline.ts`
- Create: `packages/edge/tests/integration/ingest/pipeline.test.ts`

Pipeline integra: normalizer → reid lookup (placeholder estratégia A) → persistence (detection + session upsert).

- [ ] **Step 1: TDD RED — Integration test**

```typescript
// packages/edge/tests/integration/ingest/pipeline.test.ts
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { CapturedEvent } from "../../../src/discovery/capture.js";
import { processEvent } from "../../../src/ingest/pipeline.js";
import { closeDb, getDb } from "../../../src/persistence/db.js";
import { camerasRepo, detectionsRepo, sessionsRepo } from "../../../src/persistence/repositories/index.js";
import { truncateAll } from "../persistence/_helpers.js";

let cameraId: string;

beforeEach(async () => {
  await truncateAll();
  const cam = await camerasRepo.create({ name: "test-cam", ip_address: "1.2.3.4" });
  cameraId = cam.id;
});

afterAll(async () => {
  await closeDb();
});

function rawFaceDetection(trackId: string, atSec: number): CapturedEvent {
  const data = { ObjectID: Number(trackId), Age: 30, Gender: "Male", Expression: "Happy" };
  return {
    index: 0,
    received_at: new Date(2026, 4, 1, 12, 0, atSec).toISOString(),
    raw: `Code=FaceDetection;action=Start;index=0;data=${JSON.stringify(data)}`,
    parsed: { code: "FaceDetection", action: "Start", data },
  };
}

describe("processEvent (pipeline)", () => {
  test("evento face.detected cria detection + session anônima", async () => {
    await processEvent(rawFaceDetection("100", 0), cameraId);
    const dets = await detectionsRepo.recent(10);
    expect(dets).toHaveLength(1);
    expect(dets[0]?.session_id).toBeDefined();
    expect(dets[0]?.person_id).toBeNull(); // anônima sem reid
  });

  test("dois eventos do mesmo track dentro do gap reusam a mesma sessão", async () => {
    await processEvent(rawFaceDetection("100", 0), cameraId);
    await processEvent(rawFaceDetection("100", 10), cameraId); // 10s depois
    const dets = await detectionsRepo.recent(10);
    expect(dets).toHaveLength(2);
    expect(dets[0]?.session_id).toBe(dets[1]?.session_id);
  });

  test("eventos com gap > 30s criam sessões separadas", async () => {
    await processEvent(rawFaceDetection("100", 0), cameraId);
    await processEvent(rawFaceDetection("100", 60), cameraId); // 60s depois
    const dets = await detectionsRepo.recent(10);
    expect(dets[0]?.session_id).not.toBe(dets[1]?.session_id);
  });

  test("ignora eventos não-relevantes (VideoMotion) sem inserir nada", async () => {
    const raw: CapturedEvent = {
      index: 0,
      received_at: new Date().toISOString(),
      raw: "Code=VideoMotion;action=Start;index=0",
      parsed: { code: "VideoMotion", action: "Start", data: {} },
    };
    await processEvent(raw, cameraId);
    const dets = await detectionsRepo.recent(10);
    expect(dets).toHaveLength(0);
  });
});
```

Run → FAIL.

- [ ] **Step 2: Implementar `pipeline.ts` (GREEN)**

```typescript
import type { CanonicalEvent } from "@vipcam/shared";
import type { CapturedEvent } from "../discovery/capture.js";
import { logger } from "../obs/logger.js";
import {
  detectionsRepo,
  faceRecordsRepo,
  sessionsRepo,
} from "../persistence/repositories/index.js";
import { normalize } from "./normalizer.js";
import { shouldStartNewSession } from "./session-tracker.js";

const SESSION_GAP_MS = 30_000;

/**
 * Resolve person_id via Face DB hit (estratégia A).
 * Retorna null se evento não tem camera_face_id ou não há match.
 * (Failover B virá em Onda 3.)
 */
async function resolvePersonId(event: CanonicalEvent): Promise<string | null> {
  if (!event.camera_face_id) return null;
  const fr = await faceRecordsRepo.findByCameraFaceId(event.camera_face_id);
  return fr?.person_id ?? null;
}

/**
 * Resolve session_id: reusa sessão aberta se gap < 30s para o mesmo (camera, track),
 * senão abre nova.
 */
async function resolveSessionId(
  event: CanonicalEvent,
  personId: string | null,
  detectedAt: Date,
): Promise<string> {
  const existing = event.track_id
    ? await sessionsRepo.findOpenForTrack(event.camera_id, event.track_id, SESSION_GAP_MS)
    : null;

  if (existing && !shouldStartNewSession(existing.last_seen_at, detectedAt, SESSION_GAP_MS)) {
    await sessionsRepo.appendDetection(existing.id, detectedAt);
    return existing.id;
  }

  const newSession: Parameters<typeof sessionsRepo.create>[0] = {
    camera_id: event.camera_id,
    person_id: personId,
    started_at: detectedAt,
    last_seen_at: detectedAt,
    detection_count: 1,
  };
  if (event.track_id !== undefined) newSession.current_track_id = event.track_id;
  const created = await sessionsRepo.create(newSession);
  return created.id;
}

/**
 * Processa um evento bruto da câmera: normaliza, resolve identidade, persiste.
 * Falhas em uma etapa NÃO derrubam o pipeline (try/catch granular).
 */
export async function processEvent(
  raw: CapturedEvent,
  cameraId: string,
): Promise<void> {
  const event = normalize(raw, cameraId);
  if (!event) return;

  try {
    const detectedAt = new Date(event.detected_at);
    const personId = await resolvePersonId(event);
    const sessionId = await resolveSessionId(event, personId, detectedAt);

    // face_attrs guarda atributos PARSED (age, gender, emotion, etc.)
    // raw_event guarda payload bruto Dahua para auditoria.
    // NÃO duplicar os dois — face_attrs.raw é descartado aqui.
    const parsedAttrs: Record<string, unknown> = {};
    if (event.face_attrs) {
      const { raw: _raw, ...rest } = event.face_attrs;
      Object.assign(parsedAttrs, rest);
    }

    const detection: Parameters<typeof detectionsRepo.create>[0] = {
      camera_id: event.camera_id,
      person_id: personId,
      session_id: sessionId,
      face_attrs: parsedAttrs,
      detected_at: detectedAt,
      raw_event: event.raw_event,
    };
    if (event.track_id !== undefined) detection.track_id = event.track_id;
    if (event.bbox !== undefined) detection.bbox = event.bbox;
    if (event.face_attrs?.emotion !== undefined) {
      detection.dominant_emotion = event.face_attrs.emotion;
    }
    if (event.face_attrs?.emotion_confidence !== undefined) {
      detection.emotion_confidence = event.face_attrs.emotion_confidence;
    }
    if (event.snapshot_path !== undefined) detection.snapshot_path = event.snapshot_path;

    await detectionsRepo.create(detection);
    logger.debug({ event: event.type, personId, sessionId }, "ingest persisted");
  } catch (err) {
    logger.error({ err, raw }, "ingest pipeline failed for event");
    // Não relançar: pipeline continua para próximos eventos
  }
}
```

Run → 4 pass.

⚠ Note: `sessionsRepo.findOpenForTrack(cameraId, trackId, gapMs)` precisa querar:
```sql
SELECT * FROM sessions
WHERE camera_id = $1
  AND current_track_id = $2
  AND ended_at IS NULL
  AND last_seen_at >= now() - ($3 || ' milliseconds')::interval
ORDER BY started_at DESC LIMIT 1
```
Use o índice parcial `sessions_open_track_idx` definido em Task 2.4.

- [ ] **Step 3: Commit**

```bash
git add packages/edge/src/ingest/pipeline.ts packages/edge/tests/integration/ingest/pipeline.test.ts
git commit -m "feat(ingest): add pipeline assembling normalize -> reid -> persistence"
```

---

### Task 2.11: Listener — long-poll persistente da câmera

**Files:**
- Create: `packages/edge/src/ingest/listener.ts`
- Create: `packages/edge/src/ingest/dahua-event-parse.ts` (extração)
- Modify: `packages/edge/src/discovery/capture.ts` (re-import do parser extraído)
- Modify: `packages/edge/src/main.ts` (start listener no boot)
- Verify: `packages/edge/src/ingest/dahua-http-client.ts` já tem `getStream(path, opts)` (adicionado na Onda 1, Task 1.2). Sem mudança aqui.

⚠ Diferente do `discovery/capture.ts` (single-shot capture com deadline), o listener é **persistente**: roda enquanto o processo viver, reconecta em erro com backoff.

- [ ] **Step 1: Implementar `listener.ts`**

```typescript
import { DahuaHttpClient } from "./dahua-http-client.js";
import { parseMultipartChunks } from "../discovery/capture.js";
import type { Camera } from "../persistence/schema/cameras.js";
import { logger } from "../obs/logger.js";
import { processEvent } from "./pipeline.js";

const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export interface ListenerHandle {
  stop: () => Promise<void>;
}

/**
 * Mantém um long-poll persistente contra eventManager.cgi attach.
 * Reconecta automaticamente em erro com backoff exponencial.
 * Cada chunk multipart vira um CapturedEvent que vai pra processEvent().
 */
export function startListener(
  camera: Camera,
  client: DahuaHttpClient,
): ListenerHandle {
  let stopped = false;
  let abortCtrl: AbortController | null = null;

  async function loop() {
    let backoffIdx = 0;
    while (!stopped) {
      abortCtrl = new AbortController();
      try {
        await runOnce(camera, client, abortCtrl);
        // Conexão fechou normalmente — backoff curto antes de reconectar
        backoffIdx = 0;
        await sleep(1_000);
      } catch (err) {
        if (stopped) break;
        const wait =
          RECONNECT_BACKOFF_MS[Math.min(backoffIdx, RECONNECT_BACKOFF_MS.length - 1)] ?? 30_000;
        logger.warn({ err, wait, cameraId: camera.id }, "listener error, will reconnect");
        await sleep(wait);
        backoffIdx += 1;
      }
    }
    logger.info({ cameraId: camera.id }, "listener stopped");
  }

  loop();

  return {
    async stop() {
      stopped = true;
      abortCtrl?.abort();
    },
  };
}

async function runOnce(
  camera: Camera,
  client: DahuaHttpClient,
  abortCtrl: AbortController,
): Promise<void> {
  const path = "/cgi-bin/eventManager.cgi?action=attach&codes=[All]";
  logger.info({ cameraId: camera.id, path }, "listener connecting");

  const response = await client.getStream(path, { signal: abortCtrl.signal });
  if (!response.body) throw new Error("no body in stream response");

  const ct = response.headers.get("content-type") ?? "";
  const boundaryMatch = ct.match(/boundary=([^;]+)/i);
  const boundary = boundaryMatch?.[1] ? `--${boundaryMatch[1]}` : "--myboundary";

  const reader = response.body.getReader();
  let pending: Buffer = Buffer.alloc(0);
  let eventIdx = 0;

  try {
    while (!abortCtrl.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) pending = Buffer.concat([pending, Buffer.from(value)]);

      const { events, remainder } = parseMultipartChunks(pending, boundary);
      pending = remainder;

      for (const raw of events) {
        const captured = {
          index: eventIdx++,
          received_at: new Date().toISOString(),
          raw,
          // tryParseDahuaEventLine inline aqui, ou import. Para evitar duplicação:
          parsed: parseDahuaEventLine(raw),
        };
        // Fire-and-forget — pipeline não pode bloquear leitura do socket
        void processEvent(captured, camera.id);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// Reutilizar `tryParseDahuaEventLine` de capture.ts: extraído para um util compartilhado.
// Para essa task, mover a função para `packages/edge/src/ingest/dahua-event-parse.ts`
// e importar tanto em capture.ts quanto em listener.ts. Commit separado.
import { parseDahuaEventLine } from "./dahua-event-parse.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

⚠ **Refactor inevitável:** extrair `tryParseDahuaEventLine` do `capture.ts` para `ingest/dahua-event-parse.ts` (export `parseDahuaEventLine`) e re-import nos dois lugares. Mantém DRY.

⚠ **Após o refactor**, executar `bun test tests/unit/discovery/capture.test.ts` e confirmar que os 3 testes existentes (de Onda 1) ainda passam — eles testam `parseMultipartChunks` e indiretamente exercem `tryParseDahuaEventLine`.

- [ ] **Step 2: Refactor — extrair parser para `dahua-event-parse.ts` + 1 unit test**

Criar `packages/edge/src/ingest/dahua-event-parse.ts`:

```typescript
export interface ParsedDahuaEvent {
  code?: string;
  action?: string;
  data?: unknown;
}

export function parseDahuaEventLine(raw: string): ParsedDahuaEvent | undefined {
  const out: ParsedDahuaEvent = {};
  for (const seg of raw.split(";")) {
    const eq = seg.indexOf("=");
    if (eq < 0) continue;
    const k = seg.slice(0, eq).trim().toLowerCase();
    const v = seg.slice(eq + 1).trim();
    if (k === "code") out.code = v;
    else if (k === "action") out.action = v;
    else if (k === "data") {
      try {
        out.data = JSON.parse(v);
      } catch {
        out.data = v;
      }
    }
  }
  if (out.code === undefined && out.action === undefined && out.data === undefined) {
    return undefined;
  }
  return out;
}
```

Modificar `capture.ts` para importar de `dahua-event-parse.ts` em vez de função local. Adicionar `tests/unit/ingest/dahua-event-parse.test.ts` com 2 cenários:
1. Parser extrai `code/action/data` corretamente
2. Retorna `undefined` quando linha não tem `=`

Run `cd packages/edge && bun test` — todos os testes (Onda 1 + estes novos) continuam passando.

- [ ] **Step 3: Wire-up no `main.ts`**

Adicionar antes do `Bun.serve()`:

```typescript
// ... imports existentes
import { camerasRepo } from "./persistence/repositories/index.js";
import { DahuaHttpClient } from "./ingest/dahua-http-client.js";
import { startListener } from "./ingest/listener.js";

// ... dentro do main, antes de Bun.serve():
const listenerHandles: { stop: () => Promise<void> }[] = [];

// CAMERA_IP/USER/PASS já adicionados ao envSchema na Onda 1 Task 1.1 (config opcional all-or-none).
if (env.DATABASE_URL && env.CAMERA_IP && env.CAMERA_USER && env.CAMERA_PASS) {
  const cameras = await camerasRepo.listActive();
  for (const camera of cameras) {
    const client = new DahuaHttpClient({
      baseUrl: `http://${camera.ip_address}`,
      username: env.CAMERA_USER,
      password: env.CAMERA_PASS,
    });
    listenerHandles.push(startListener(camera, client));
    logger.info({ cameraId: camera.id, ip: camera.ip_address }, "listener started");
  }
} else {
  logger.warn("listeners NOT started — DATABASE_URL or CAMERA_* missing");
}

// Modificar graceful shutdown:
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, "shutting down");
    await Promise.all(listenerHandles.map((h) => h.stop()));
    server.stop();
    process.exit(0);
  });
}
```

Adicionar `camerasRepo.listActive()` ao repo se não existir.

- [ ] **Step 4: Commit**

```bash
git add packages/edge/src/ingest/listener.ts packages/edge/src/ingest/dahua-event-parse.ts \
  packages/edge/src/discovery/capture.ts packages/edge/src/main.ts \
  packages/edge/src/persistence/repositories/cameras.repo.ts
git commit -m "feat(ingest): persistent listener with reconnect backoff + main.ts wire-up"
```

---

### Task 2.12: Health check com DB ping

**Files:**
- Modify: `packages/edge/src/api/server.ts`

- [ ] **Step 1: Adicionar check de DB ao `/api/health`**

```typescript
import { sql } from "drizzle-orm";
import { getDb } from "../persistence/db.js";

// Substituir handler de /api/health:
app.get("/api/health", async (c) => {
  const startedAtSec = Math.floor((Date.now() - startedAt) / 1000);
  const checks: HealthResponse["checks"] = { edge: { ok: true } };

  if (env.DATABASE_URL) {
    const t0 = Date.now();
    try {
      await getDb().execute(sql`SELECT 1`);
      checks.db = { ok: true, latency_ms: Date.now() - t0 };
    } catch (err) {
      checks.db = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  const status: HealthResponse["status"] = allOk ? "healthy" : "degraded";
  return c.json({ status, uptime_seconds: startedAtSec, checks }, allOk ? 200 : 503);
});
```

- [ ] **Step 2: Smoke test**

```bash
bun run dev &
sleep 5
curl -s http://localhost:4000/api/health | jq
# Expected: { "status": "healthy", "checks": { "edge": {...}, "db": { "ok": true, "latency_ms": <small> } } }
kill %1
```

- [ ] **Step 3: Commit**

```bash
git add packages/edge/src/api/server.ts
git commit -m "feat(api): /api/health pings DB and returns 503 when degraded"
```

---

### Task 2.13: Verificação intermediária do Chunk 2

- [ ] **Step 1: Suite completa**

```bash
cd packages/edge && API_KEY=k DATABASE_URL=postgres://vipcam:vipcam@localhost:5432/vipcam bun test
# Expected: ~50 tests pass (27 da Onda 1 + ~23 novos)
```

- [ ] **Step 2: Typecheck + lint**

```bash
cd /d/Dev/Barbearia\ VIP/DH-IPC-HFW5442T-ASE && bun run typecheck && bun run lint
```

- [ ] **Step 3: Smoke test ingest end-to-end com fake stream (sem câmera real)**

Criar script `packages/edge/scripts/smoke-fake-stream.ts` (apenas para verificação manual; não commitar como teste):

```typescript
// Manda 3 eventos pelo pipeline simulando captura, verifica DB
import { camerasRepo } from "../src/persistence/repositories/index.js";
import { processEvent } from "../src/ingest/pipeline.js";

const cam = await camerasRepo.create({ name: "smoke-cam", ip_address: "127.0.0.1" });
for (let i = 0; i < 3; i++) {
  await processEvent({
    index: i,
    received_at: new Date().toISOString(),
    raw: `Code=FaceDetection;action=Start;index=${i};data=${JSON.stringify({ ObjectID: 99, Age: 30, Gender: "Male", Expression: "Happy" })}`,
    parsed: {
      code: "FaceDetection",
      action: "Start",
      data: { ObjectID: 99, Age: 30, Gender: "Male", Expression: "Happy" },
    },
  }, cam.id);
}

console.log("inserted 3 events");
```

```bash
API_KEY=k DATABASE_URL=postgres://vipcam:vipcam@localhost:5432/vipcam \
  bun run packages/edge/scripts/smoke-fake-stream.ts

docker exec vipcam-postgres psql -U vipcam -d vipcam \
  -c "SELECT COUNT(*) FROM detections; SELECT COUNT(*) FROM sessions;"
# Expected: 3 detections, 1 session (mesmo track, gap pequeno)
```

- [ ] **Step 4: Commit final do Chunk 2 (se houver tweaks)**

**Checkpoint Chunk 2 atingido:** schema completo, repositories testados, ingest pipeline grava `detections`+`sessions` corretamente. Próxima fase (re-id A) tem onde plugar lookups.

---

## Chunk 3: Fase 3 — Re-id estratégia A (Face DB câmera) + admin

Esta fase implementa: cliente do Face DB embarcado da câmera (CRUD), endpoints REST de admin (`/api/cameras/:id/face-db`), e wire-up do `reid-mgr/lookup` no pipeline. Quando uma face cadastrada na câmera é reconhecida, o evento já chega com `camera_face_id` e o pipeline cria/identifica a Person automaticamente.

### Task 3.1: Cliente Face DB (CRUD via CGI)

⚠ **Premissa P3** (Face DB CGI) é load-bearing. Os endpoints abaixo são os mais comumente expostos em câmeras Dahua WizMind 4MP+. **Discovery Task 1.10 deve confirmar quais existem em DH-IPC-HFW5442T-ASE.** Ajustar paths se necessário.

**Files:**
- Create: `packages/edge/src/ingest/dahua-face-db-client.ts`
- Create: `packages/edge/tests/unit/ingest/dahua-face-db-client.test.ts`

- [ ] **Step 1: Definir interface + tipos**

```typescript
// packages/edge/src/ingest/dahua-face-db-client.ts
import type { DahuaHttpClient } from "./dahua-http-client.js";
import { logger } from "../obs/logger.js";

export interface FaceDbEntry {
  face_id: string; // ID retornado pela câmera ao adicionar
  name?: string;
  group_id?: string;
}

export interface AddFaceArgs {
  name: string;
  group_id?: string;
  /** JPEG bytes da face. Tamanho recomendado: 200-500 KB. */
  image: Buffer;
}

export class DahuaFaceDbClient {
  constructor(private http: DahuaHttpClient) {}

  /**
   * Adiciona uma face ao DB embarcado. Retorna o face_id atribuído pela câmera.
   * Path canônico (Dahua WizMind 2.x firmware): POST /cgi-bin/FaceInfoManager.cgi?action=add
   * Body: multipart/form-data com campos `Name`, `GroupID`, `FaceImage` (binário).
   */
  async add(args: AddFaceArgs): Promise<string> {
    // Implementação aproximada — adapte body/encoding ao que Discovery confirmar.
    const path = `/cgi-bin/FaceInfoManager.cgi?action=add&Name=${encodeURIComponent(args.name)}`;
    const response = await this.http.postBinary(path, args.image, "image/jpeg");
    if (!response.ok) {
      throw new Error(`Face DB add failed: HTTP ${response.status}`);
    }
    const body = await response.text();
    // Resposta Dahua típica: "Result=ABC123" ou JSON {"id":"ABC123"}
    const match = body.match(/(?:Result|id|FaceID)\s*[=:]\s*"?([a-zA-Z0-9_-]+)"?/);
    if (!match?.[1]) {
      throw new Error(`Face DB add: cannot parse face_id from response: ${body.slice(0, 200)}`);
    }
    logger.info({ name: args.name, face_id: match[1] }, "face added to camera DB");
    return match[1];
  }

  async delete(faceId: string): Promise<void> {
    const path = `/cgi-bin/FaceInfoManager.cgi?action=delete&FaceID=${encodeURIComponent(faceId)}`;
    const response = await this.http.get(path);
    if (!response.ok) throw new Error(`Face DB delete failed: HTTP ${response.status}`);
  }

  async count(): Promise<number> {
    const path = "/cgi-bin/FaceInfoManager.cgi?action=getCount";
    const response = await this.http.get(path);
    const text = await response.text();
    const m = text.match(/Count\s*=\s*(\d+)/i);
    return m?.[1] ? Number.parseInt(m[1], 10) : 0;
  }

  async list(offset = 0, limit = 100): Promise<FaceDbEntry[]> {
    const path = `/cgi-bin/FaceInfoManager.cgi?action=getCollection&offset=${offset}&limit=${limit}`;
    const response = await this.http.get(path);
    const text = await response.text();
    // Resposta Dahua é multi-linha key=value indexado: face[0].FaceID=X, face[0].Name=Y, ...
    return parseFaceList(text);
  }
}

export function parseFaceList(text: string): FaceDbEntry[] {
  const out = new Map<number, Partial<FaceDbEntry>>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^face\[(\d+)\]\.(\w+)=(.+)$/);
    if (!m) continue;
    const idx = Number(m[1]);
    const key = m[2]?.toLowerCase();
    const val = m[3]?.trim();
    if (!key || !val) continue;
    const entry = out.get(idx) ?? {};
    if (key === "faceid") entry.face_id = val;
    else if (key === "name") entry.name = val;
    else if (key === "groupid") entry.group_id = val;
    out.set(idx, entry);
  }
  return [...out.values()].filter((e): e is FaceDbEntry => !!e.face_id);
}
```

⚠ **Pendente:** `DahuaHttpClient` precisa ganhar método `postBinary(path, body, contentType)`. Implementação completa (espelha lógica de `get()` mas com body bufferado para reuso na retry pós-401):

```typescript
// Em dahua-http-client.ts, adicionar método (no método POST o body PRECISA ser
// bufferado pra ser re-enviado na chamada autenticada após o desafio Digest).
async postBinary(
  path: string,
  body: Buffer,
  contentType: string,
  opts: RequestOptions = {},
): Promise<Response> {
  const url = `${this.cfg.baseUrl}${path}`;
  const signal = this.resolveSignal(opts);

  const baseInit = (auth?: string): RequestInit => {
    const init: RequestInit = {
      method: "POST",
      body: new Uint8Array(body), // Buffer → Uint8Array, fetch aceita
      headers: {
        "content-type": contentType,
        "content-length": String(body.length),
        ...(auth ? { Authorization: auth } : {}),
      },
    };
    if (signal) init.signal = signal;
    return init;
  };

  // Tentativa 1: usa challenge cacheado se houver
  if (this.cachedChallenge) {
    const auth = this.makeAuthHeader("POST", path);
    const r = await fetch(url, baseInit(auth));
    if (r.status !== 401) return r;
    await r.body?.cancel().catch(() => {});
    this.cachedChallenge = null;
    this.nc = 0;
  }

  // Tentativa 2: sem auth, espera 401 com challenge
  const r1 = await fetch(url, baseInit(undefined));
  if (r1.status !== 401) return r1;

  const challengeHeader = r1.headers.get("www-authenticate");
  const challenge = parseDigestChallenge(challengeHeader ?? "");
  if (!challenge) {
    logger.warn({ path, header: challengeHeader }, "no Digest challenge in 401");
    return r1;
  }
  await r1.body?.cancel().catch(() => {});
  this.cachedChallenge = challenge;
  this.nc = 0;

  // Tentativa 3: re-envia com auth (body é o mesmo Buffer, sem stream consumido)
  const auth = this.makeAuthHeader("POST", path);
  return fetch(url, baseInit(auth));
}
```

- [ ] **Step 2: TDD — Teste do `parseFaceList`**

```typescript
// packages/edge/tests/unit/ingest/dahua-face-db-client.test.ts
import { describe, expect, test } from "bun:test";
import { parseFaceList } from "../../../src/ingest/dahua-face-db-client.js";

describe("parseFaceList", () => {
  test("parseia formato indexado Dahua", () => {
    const text = `face[0].FaceID=ABC123
face[0].Name=João Silva
face[0].GroupID=clientes
face[1].FaceID=DEF456
face[1].Name=Maria
totalCount=2`;
    const entries = parseFaceList(text);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ face_id: "ABC123", name: "João Silva", group_id: "clientes" });
    expect(entries[1]).toMatchObject({ face_id: "DEF456", name: "Maria" });
  });

  test("ignora linhas sem face_id", () => {
    const text = "face[0].Name=Anonymous\nfoo=bar";
    expect(parseFaceList(text)).toEqual([]);
  });
});
```

Run → 2 pass.

- [ ] **Step 3: Commit**

```bash
git add packages/edge/src/ingest/dahua-face-db-client.ts \
  packages/edge/src/ingest/dahua-http-client.ts \
  packages/edge/tests/unit/ingest/dahua-face-db-client.test.ts
git commit -m "feat(ingest): add Dahua Face DB CRUD client (add/delete/list/count)"
```

---

### Task 3.2: REST endpoints `/api/cameras/:id/face-db`

**Files:**
- Create: `packages/edge/src/api/routes/face-db.ts`
- Modify: `packages/edge/src/api/server.ts`
- Create: `packages/edge/tests/unit/api/routes/face-db.test.ts`

- [ ] **Step 1: Factory pattern (segue padrão de discovery routes)**

```typescript
// packages/edge/src/api/routes/face-db.ts
import { Hono } from "hono";
import { z } from "zod";
import type { FaceDbEntry } from "../../ingest/dahua-face-db-client.js";

export interface FaceDbDeps {
  list: (cameraId: string) => Promise<FaceDbEntry[]>;
  add: (cameraId: string, name: string, image: Buffer) => Promise<{ face_id: string }>;
  remove: (cameraId: string, faceId: string) => Promise<void>;
  count: (cameraId: string) => Promise<number>;
}

const addBody = z.object({
  name: z.string().min(1).max(100),
  image_base64: z.string().min(100), // JPEG base64
});

export function createFaceDbRoutes(deps: FaceDbDeps): Hono {
  const r = new Hono();

  r.get("/cameras/:id/face-db", async (c) => {
    const cameraId = c.req.param("id");
    const entries = await deps.list(cameraId);
    return c.json({ entries });
  });

  r.get("/cameras/:id/face-db/count", async (c) => {
    const cameraId = c.req.param("id");
    const count = await deps.count(cameraId);
    return c.json({ count });
  });

  r.post("/cameras/:id/face-db", async (c) => {
    const cameraId = c.req.param("id");
    const raw = await c.req.json().catch(() => ({}));
    const parsed = addBody.safeParse(raw);
    if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    const image = Buffer.from(parsed.data.image_base64, "base64");
    const result = await deps.add(cameraId, parsed.data.name, image);
    return c.json(result, 201);
  });

  r.delete("/cameras/:id/face-db/:faceId", async (c) => {
    const cameraId = c.req.param("id");
    const faceId = c.req.param("faceId");
    await deps.remove(cameraId, faceId);
    return c.body(null, 204);
  });

  return r;
}
```

- [ ] **Step 2: Wire-up no `server.ts`**

```typescript
// Adicionar imports + mount após /api/discovery:
import { createFaceDbRoutes } from "./routes/face-db.js";
import { DahuaFaceDbClient } from "../ingest/dahua-face-db-client.js";
import { DahuaHttpClient } from "../ingest/dahua-http-client.js";
import { camerasRepo } from "../persistence/repositories/index.js";

async function buildFaceDbClient(cameraId: string): Promise<DahuaFaceDbClient> {
  const camera = await camerasRepo.findById(cameraId);
  if (!camera) throw new Error(`camera ${cameraId} not found`);
  if (!env.CAMERA_USER || !env.CAMERA_PASS) throw new Error("CAMERA credentials missing");
  const http = new DahuaHttpClient({
    baseUrl: `http://${camera.ip_address}`,
    username: env.CAMERA_USER,
    password: env.CAMERA_PASS,
  });
  return new DahuaFaceDbClient(http);
}

app.route(
  "/api",
  createFaceDbRoutes({
    list: async (cameraId) => (await buildFaceDbClient(cameraId)).list(),
    add: async (cameraId, name, image) => ({
      face_id: await (await buildFaceDbClient(cameraId)).add({ name, image }),
    }),
    remove: async (cameraId, faceId) => (await buildFaceDbClient(cameraId)).delete(faceId),
    count: async (cameraId) => (await buildFaceDbClient(cameraId)).count(),
  }),
);
```

- [ ] **Step 3: TDD — Tests com deps mockados**

```typescript
// packages/edge/tests/unit/api/routes/face-db.test.ts
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createFaceDbRoutes, type FaceDbDeps } from "../../../../src/api/routes/face-db.js";

function mount(deps: FaceDbDeps): Hono {
  const app = new Hono();
  app.route("/api", createFaceDbRoutes(deps));
  return app;
}

describe("Face DB routes", () => {
  test("GET /cameras/:id/face-db retorna entries", async () => {
    const app = mount({
      list: async () => [{ face_id: "X", name: "Joe" }],
      add: async () => ({ face_id: "new" }),
      remove: async () => {},
      count: async () => 1,
    });
    const res = await app.request("/api/cameras/cam1/face-db");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toHaveLength(1);
  });

  test("POST /cameras/:id/face-db rejeita body sem image_base64", async () => {
    const app = mount({
      list: async () => [],
      add: async () => ({ face_id: "x" }),
      remove: async () => {},
      count: async () => 0,
    });
    const res = await app.request("/api/cameras/cam1/face-db", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /cameras/:id/face-db invoca add com Buffer decoded", async () => {
    let received: { name: string; size: number } | null = null;
    const app = mount({
      list: async () => [],
      add: async (_cameraId, name, image) => {
        received = { name, size: image.length };
        return { face_id: "abc" };
      },
      remove: async () => {},
      count: async () => 0,
    });
    const png = Buffer.from("test-image-data".repeat(20)); // 300 bytes
    const res = await app.request("/api/cameras/cam1/face-db", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test", image_base64: png.toString("base64") }),
    });
    expect(res.status).toBe(201);
    expect(received?.name).toBe("test");
    expect(received?.size).toBe(png.length);
  });

  test("DELETE retorna 204", async () => {
    const app = mount({
      list: async () => [],
      add: async () => ({ face_id: "" }),
      remove: async () => {},
      count: async () => 0,
    });
    const res = await app.request("/api/cameras/cam1/face-db/face1", { method: "DELETE" });
    expect(res.status).toBe(204);
  });
});
```

Run → 4 pass.

- [ ] **Step 4: Commit**

```bash
git add packages/edge/src/api/routes/face-db.ts packages/edge/src/api/server.ts \
  packages/edge/tests/unit/api/routes/face-db.test.ts
git commit -m "feat(api): expose CRUD endpoints for camera Face DB management"
```

---

### Task 3.3: reid-mgr lookup + wire-up no pipeline

**Files:**
- Create: `packages/edge/src/reid-mgr/lookup.ts`
- Create: `packages/edge/src/reid-mgr/index.ts`
- Modify: `packages/edge/src/ingest/pipeline.ts` (substituir `resolvePersonId` por reid-mgr — preserva contrato `(event) => Promise<string|null>`)
- Modify: `packages/edge/src/config/env.ts` (adicionar `REID_AUTOCREATE_ON_DESSYNC: z.coerce.boolean().default(false)`)
- Create: `packages/edge/tests/integration/reid-mgr/lookup.test.ts`

- [ ] **Step 0: Adicionar env flag**

```typescript
// envSchema:
REID_AUTOCREATE_ON_DESSYNC: z.coerce.boolean().default(false),
```

- [ ] **Step 1: Implementar `lookup.ts`**

```typescript
// packages/edge/src/reid-mgr/lookup.ts
import type { CanonicalEvent } from "@vipcam/shared";
import { getEnv } from "../config/env.js";
import { faceRecordsRepo, personsRepo } from "../persistence/repositories/index.js";
import { logger } from "../obs/logger.js";

/**
 * Estratégia A: dado um evento com camera_face_id, busca face_record vinculado.
 * Se existir → retorna person_id.
 * Se não existir e REID_AUTOCREATE_ON_DESSYNC=true, cria pessoa anônima vinculada;
 *   default false porque face_ids stale (firmware reset, delete pendente) podem
 *   poluir o DB com pessoas fantasmas que nunca mais reaparecem.
 */
export async function lookupByFaceDb(event: CanonicalEvent): Promise<string | null> {
  if (!event.camera_face_id) return null;

  const fr = await faceRecordsRepo.findByCameraFaceId(event.camera_face_id);
  if (fr) {
    logger.debug({ camera_face_id: event.camera_face_id, person_id: fr.person_id }, "reid A hit");
    return fr.person_id;
  }

  const env = getEnv();
  if (!env.REID_AUTOCREATE_ON_DESSYNC) {
    logger.warn(
      { camera_face_id: event.camera_face_id, type: event.type },
      "reid A: unknown camera_face_id, autocreate disabled — event treated as anonymous",
    );
    return null;
  }

  // Auto-create habilitado: cria pessoa anônima vinculada ao face_id desconhecido.
  // Apenas para event.type === "face.recognized" (face.detected sem face_id é
  // anônimo legítimo, não dessync — não deve criar)
  if (event.type !== "face.recognized") return null;

  const person = await personsRepo.create({
    person_type: "anonymous",
    display_name: null,
  });
  await faceRecordsRepo.create({
    person_id: person.id,
    camera_face_id: event.camera_face_id,
    snapshot_path: event.snapshot_path ?? "(no-snapshot-on-dessync)",
    is_primary: true,
  });
  logger.warn(
    { person_id: person.id, camera_face_id: event.camera_face_id },
    "reid A: auto-created person for unknown camera face_id (REID_AUTOCREATE_ON_DESSYNC)",
  );
  return person.id;
}
```

- [ ] **Step 2: Barrel + atualizar pipeline**

`reid-mgr/index.ts`:

```typescript
export { lookupByFaceDb } from "./lookup.js";
```

Em `ingest/pipeline.ts`, substituir `resolvePersonId` por:

```typescript
import { lookupByFaceDb } from "../reid-mgr/index.js";

// Trocar resolvePersonId por:
async function resolvePersonId(event: CanonicalEvent): Promise<string | null> {
  return lookupByFaceDb(event);
}
```

- [ ] **Step 3: Integration test**

```typescript
// packages/edge/tests/integration/reid-mgr/lookup.test.ts
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { lookupByFaceDb } from "../../../src/reid-mgr/lookup.js";
import { closeDb } from "../../../src/persistence/db.js";
import { faceRecordsRepo, personsRepo } from "../../../src/persistence/repositories/index.js";
import { truncateAll } from "../persistence/_helpers.js";
import type { CanonicalEvent } from "@vipcam/shared";

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
});

const baseEvent = (faceId: string | undefined): CanonicalEvent => ({
  type: faceId ? "face.recognized" : "face.detected",
  camera_id: "cam-1",
  detected_at: new Date().toISOString(),
  ...(faceId ? { camera_face_id: faceId } : {}),
  raw_event: {},
});

describe("lookupByFaceDb", () => {
  test("retorna null se evento não tem camera_face_id", async () => {
    expect(await lookupByFaceDb(baseEvent(undefined))).toBeNull();
  });

  test("encontra person via face_record existente", async () => {
    const p = await personsRepo.create({ display_name: "John" });
    await faceRecordsRepo.create({
      person_id: p.id,
      camera_face_id: "cam-face-X",
      snapshot_path: "/tmp/x.jpg",
    });
    const found = await lookupByFaceDb(baseEvent("cam-face-X"));
    expect(found).toBe(p.id);
  });

  test("auto-cria person anônimo se camera_face_id desconhecido", async () => {
    const newId = await lookupByFaceDb(baseEvent("cam-face-UNKNOWN"));
    expect(newId).toBeDefined();
    const p = await personsRepo.findById(newId!);
    expect(p?.person_type).toBe("anonymous");
  });
});
```

Run → 3 pass.

- [ ] **Step 4: Commit**

```bash
git add packages/edge/src/reid-mgr/ packages/edge/src/ingest/pipeline.ts \
  packages/edge/tests/integration/reid-mgr/
git commit -m "feat(reid-mgr): strategy A lookup via face_records, auto-create on dessync"
```

---

### Task 3.4: Frontend admin page `/cameras/:id/face-db`

**Files:**
- Create: `packages/web/src/app/cameras/[id]/face-db/page.tsx`
- Modify: `packages/web/src/lib/api-client.ts` (adicionar funções face-db)

- [ ] **Step 1: Estender `api-client.ts`**

```typescript
// Adicionar ao final de api-client.ts:
export interface FaceDbEntry {
  face_id: string;
  name?: string;
  group_id?: string;
}

export async function listFaceDb(cameraId: string): Promise<FaceDbEntry[]> {
  const r = await fetch(`${API_URL}/api/cameras/${cameraId}/face-db`, { cache: "no-store" });
  if (!r.ok) await throwApiError(r, "failed_to_list_face_db");
  const body = (await r.json()) as { entries: FaceDbEntry[] };
  return body.entries;
}

/** btoa-safe encoding sem Buffer (que não existe no browser). Chunked p/ fotos > 100KB. */
function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000; // 32KB chunks evitam stack overflow no String.fromCharCode(...)
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export async function addFaceDb(cameraId: string, name: string, image: File): Promise<string> {
  const buffer = await image.arrayBuffer();
  const base64 = bufferToBase64(buffer);
  const r = await fetch(`${API_URL}/api/cameras/${cameraId}/face-db`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, image_base64: base64 }),
  });
  if (!r.ok) await throwApiError(r, "failed_to_add_face");
  const body = (await r.json()) as { face_id: string };
  return body.face_id;
}

export async function deleteFaceDb(cameraId: string, faceId: string): Promise<void> {
  const r = await fetch(`${API_URL}/api/cameras/${cameraId}/face-db/${faceId}`, {
    method: "DELETE",
  });
  if (!r.ok) await throwApiError(r, "failed_to_delete_face");
}
```

⚠ Frontend usa `Buffer` mas runtime navegador não tem Buffer global. Adaptar para `btoa(String.fromCharCode(...new Uint8Array(buffer)))` ou polyfill.

- [ ] **Step 2: Criar página**

```tsx
// packages/web/src/app/cameras/[id]/face-db/page.tsx
"use client";

import { addFaceDb, deleteFaceDb, type FaceDbEntry, listFaceDb } from "@/lib/api-client";
import { useEffect, useState } from "react";

export default function FaceDbPage({ params }: { params: { id: string } }) {
  const cameraId = params.id;
  const [entries, setEntries] = useState<FaceDbEntry[]>([]);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setEntries(await listFaceDb(cameraId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => { refresh(); }, [cameraId]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !name) return;
    setLoading(true);
    setError(null);
    try {
      await addFaceDb(cameraId, name, file);
      setName("");
      setFile(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(faceId: string) {
    if (!confirm(`Remover ${faceId}?`)) return;
    try {
      await deleteFaceDb(cameraId, faceId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">Face DB — Câmera {cameraId}</h1>
      <p className="mt-2 text-neutral-600">Pessoas cadastradas na câmera ({entries.length})</p>

      {error && (
        <div className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          ❌ {error}
        </div>
      )}

      <form onSubmit={handleAdd} className="mt-6 space-y-3 rounded border border-neutral-200 p-4">
        <h2 className="font-semibold">Cadastrar nova face</h2>
        <input
          type="text"
          placeholder="Nome"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded border border-neutral-300 p-2"
        />
        <input
          type="file"
          accept="image/jpeg,image/png"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="w-full"
        />
        <button
          type="submit"
          disabled={loading || !file || !name}
          className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading ? "Enviando..." : "Cadastrar"}
        </button>
      </form>

      <table className="mt-6 w-full text-sm">
        <thead className="bg-neutral-100">
          <tr>
            <th className="p-2 text-left">FaceID</th>
            <th className="p-2 text-left">Nome</th>
            <th className="p-2 text-left">Grupo</th>
            <th className="p-2 text-right">Ações</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.face_id} className="border-b border-neutral-200">
              <td className="p-2 font-mono text-xs">{e.face_id}</td>
              <td className="p-2">{e.name ?? "—"}</td>
              <td className="p-2">{e.group_id ?? "—"}</td>
              <td className="p-2 text-right">
                <button
                  type="button"
                  onClick={() => handleDelete(e.face_id)}
                  className="text-red-700 hover:underline"
                >
                  Remover
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
```

- [ ] **Step 3: Smoke test do build**

```bash
cd packages/web && bun run build
# Expected: build OK, /cameras/[id]/face-db listada (dynamic route)
```

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/lib/api-client.ts packages/web/src/app/cameras/
git commit -m "feat(web): add /cameras/:id/face-db admin page (list, add, delete)"
```

---

### Task 3.5: Verificação intermediária do Chunk 3

- [ ] **Step 1: Suite + lint + build**

```bash
cd packages/edge && API_KEY=k DATABASE_URL=postgres://vipcam:vipcam@localhost:5432/vipcam bun test
cd /d/Dev/Barbearia\ VIP/DH-IPC-HFW5442T-ASE && bun run typecheck && bun run lint
cd packages/web && bun run build
```

Esperado: ~50 testes (Onda 1: 22, Chunk 2: ~18, Chunk 3: ~9), tudo verde.

- [ ] **Step 2: Smoke test contra câmera real (se disponível) ou skip**

Manual: cadastrar uma face via UI `/cameras/<UUID>/face-db`, verificar que `count` reflete via `GET /api/cameras/<UUID>/face-db/count`. Quando essa face passar em frente da câmera, evento deve chegar com `camera_face_id` populado e pipeline deve linkar à pessoa cadastrada.

⚠ **Sem câmera real, este passo só valida que a stack inteira compila e responde sem 500.** Validação completa só após Task 1.10 + cadastro real.

**Checkpoint Chunk 3 atingido:** estratégia A end-to-end disponível. Próxima fase (ERP + match temporal) trata clientes que **não estão pré-cadastrados na câmera**.

---

## Chunk 4: Fase 4 — ERP integration + match temporal + sync funcionários

Esta fase fecha o MVP: lê funcionários do ERP MySQL local (com fotos) e auto-cadastra no Face DB câmera; lê check-ins do ERP em near-real-time; quando um check-in chega, tenta vincular a alguma face anônima recém-detectada via janela temporal de ±5min.

### Task 4.1: MySQL client + env config

**Files:**
- Modify: `packages/edge/src/config/env.ts` (adicionar ERP_MYSQL_URL)
- Modify: `packages/edge/.env.example`
- Create: `packages/edge/src/erp-sync/mysql-client.ts`
- Modify: `packages/edge/package.json` (dep mysql2)

- [ ] **Step 1: Adicionar env (TDD RED + GREEN)**

Adicionar ao `envSchema`:

```typescript
ERP_MYSQL_URL: z
  .string()
  .regex(/^mysql:\/\//, "ERP_MYSQL_URL must start with mysql://")
  .optional(),
```

Adicionar 1 teste smoke em `env.test.ts` (`aceita ERP_MYSQL_URL válido`).

- [ ] **Step 2: Atualizar `.env.example`**

```bash
# ERP MySQL local (mesma máquina via host.docker.internal ou 127.0.0.1)
ERP_MYSQL_URL=mysql://erp_reader:senha@127.0.0.1:3306/barbearia_erp
```

- [ ] **Step 3: Instalar mysql2**

```bash
cd packages/edge && bun add mysql2
```

- [ ] **Step 4: Implementar `mysql-client.ts`**

```typescript
import mysql, { type Pool, type PoolConnection } from "mysql2/promise";
import { getEnv } from "../config/env.js";
import { logger } from "../obs/logger.js";

let _pool: Pool | undefined;

export function getErpPool(): Pool {
  if (_pool) return _pool;
  const env = getEnv();
  if (!env.ERP_MYSQL_URL) throw new Error("ERP_MYSQL_URL is required");
  _pool = mysql.createPool({
    uri: env.ERP_MYSQL_URL,
    connectionLimit: 5,
    waitForConnections: true,
    queueLimit: 0,
  });
  logger.info("ERP MySQL pool initialized");
  return _pool;
}

export async function withErpConn<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await getErpPool().getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

export async function closeErpPool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
  }
}
```

- [ ] **Step 5: Smoke test conexão (manual; só funciona com ERP local rodando)**

Skip se ERP não disponível. Senão:

```bash
ERP_MYSQL_URL=mysql://... API_KEY=k bun -e \
  "import('./src/erp-sync/mysql-client.ts').then(async m => { const p = m.getErpPool(); const [r] = await p.query('SELECT 1 as ok'); console.log(r); await m.closeErpPool(); })"
```
Expected: `[{ ok: 1 }]`.

- [ ] **Step 6: Commit**

```bash
git add packages/edge/src/erp-sync/mysql-client.ts packages/edge/src/config/env.ts \
  packages/edge/.env.example packages/edge/package.json packages/edge/bun.lock
git commit -m "feat(erp-sync): add mysql2 connection pool with env validation"
```

---

### Task 4.2: ERP schema discovery (configurável)

⚠ O ERP é proprietário do usuário — não conhecemos a estrutura exata. Esta task expõe **queries configuráveis via env** para mapear o schema real do ERP às nossas entidades, sem hard-coding.

**Files:**
- Modify: `packages/edge/src/config/env.ts` (queries SQL configuráveis)
- Create: `packages/edge/src/erp-sync/queries.ts`
- Modify: `packages/edge/.env.example`

- [ ] **Step 1: Adicionar queries ao env**

```typescript
// Em envSchema, adicionar (todas opcionais com defaults sensatos):
ERP_QUERY_EMPLOYEES: z.string().default(
  "SELECT id, name, role, photo_url, photo_updated_at, is_active FROM employees WHERE is_active = 1",
),
ERP_QUERY_CLIENTS: z.string().default(
  "SELECT id, name, phone, is_active FROM clients WHERE is_active = 1",
),
ERP_QUERY_CHECKINS_SINCE: z.string().default(
  "SELECT id, client_id, event_type, occurred_at, metadata FROM checkins WHERE occurred_at >= ? ORDER BY occurred_at",
),
```

- [ ] **Step 2: Criar `queries.ts` (helpers)**

```typescript
// packages/edge/src/erp-sync/queries.ts
import type { RowDataPacket } from "mysql2/promise";
import { getEnv } from "../config/env.js";
import { withErpConn } from "./mysql-client.js";

export interface ErpEmployeeRow extends RowDataPacket {
  id: string | number;
  name: string;
  role?: string;
  photo_url?: string;
  photo_updated_at?: Date | string;
  is_active: number | boolean;
}

export interface ErpClientRow extends RowDataPacket {
  id: string | number;
  name: string;
  phone?: string;
  is_active: number | boolean;
}

export interface ErpCheckinRow extends RowDataPacket {
  id: string | number;
  client_id: string | number;
  event_type: string;
  occurred_at: Date | string;
  metadata?: string | null; // JSON string
}

export async function fetchErpEmployees(): Promise<ErpEmployeeRow[]> {
  const env = getEnv();
  return withErpConn(async (conn) => {
    const [rows] = await conn.execute<ErpEmployeeRow[]>(env.ERP_QUERY_EMPLOYEES);
    return rows;
  });
}

export async function fetchErpClients(): Promise<ErpClientRow[]> {
  const env = getEnv();
  return withErpConn(async (conn) => {
    const [rows] = await conn.execute<ErpClientRow[]>(env.ERP_QUERY_CLIENTS);
    return rows;
  });
}

export async function fetchErpCheckinsSince(since: Date): Promise<ErpCheckinRow[]> {
  const env = getEnv();
  return withErpConn(async (conn) => {
    const [rows] = await conn.execute<ErpCheckinRow[]>(env.ERP_QUERY_CHECKINS_SINCE, [since]);
    return rows;
  });
}
```

- [ ] **Step 3: Atualizar `.env.example` com instruções**

```bash
# === ERP Integration ===
# As queries abaixo devem ser ajustadas ao schema do seu ERP MySQL.
# Defaults assumem tabelas employees/clients/checkins com colunas comuns.
# Reader/usuário do MySQL precisa ter SELECT nessas tabelas.
ERP_QUERY_EMPLOYEES="SELECT id, name, role, photo_url, photo_updated_at, is_active FROM employees WHERE is_active = 1"
ERP_QUERY_CLIENTS="SELECT id, name, phone, is_active FROM clients WHERE is_active = 1"
ERP_QUERY_CHECKINS_SINCE="SELECT id, client_id, event_type, occurred_at, metadata FROM checkins WHERE occurred_at >= ? ORDER BY occurred_at"
```

- [ ] **Step 4: Validation no boot — verifica que queries retornam colunas esperadas**

Adicionar a `queries.ts`:

```typescript
const REQUIRED_COLUMNS = {
  employees: ["id", "name", "is_active"],
  clients: ["id", "name", "is_active"],
  checkins: ["id", "client_id", "event_type", "occurred_at"],
};

export async function validateErpQueries(): Promise<void> {
  const env = getEnv();
  await withErpConn(async (conn) => {
    for (const [kind, query] of [
      ["employees", `${env.ERP_QUERY_EMPLOYEES} LIMIT 1`],
      ["clients", `${env.ERP_QUERY_CLIENTS} LIMIT 1`],
    ] as const) {
      const [rows, fields] = await conn.execute(query);
      const cols = fields.map((f) => f.name.toLowerCase());
      for (const required of REQUIRED_COLUMNS[kind]) {
        if (!cols.includes(required.toLowerCase())) {
          throw new Error(
            `ERP query "${kind}" missing required column: "${required}". Got: ${cols.join(", ")}. Use SQL AS to alias if your schema differs.`,
          );
        }
      }
      logger.info({ kind, columns: cols, sample_rows: (rows as RowDataPacket[]).length }, "ERP query validated");
    }
    // Checkins query usa "?" param — validar com new Date(0)
    const [, fields] = await conn.execute(env.ERP_QUERY_CHECKINS_SINCE + " LIMIT 1", [new Date(0)]);
    const cols = fields.map((f) => f.name.toLowerCase());
    for (const required of REQUIRED_COLUMNS.checkins) {
      if (!cols.includes(required.toLowerCase())) {
        throw new Error(`ERP query "checkins" missing required column: "${required}". Got: ${cols.join(", ")}.`);
      }
    }
    logger.info({ kind: "checkins", columns: cols }, "ERP query validated");
  });
}
```

Chamar `validateErpQueries()` no `main.ts` antes de `startScheduler()` — falha hard se schema do ERP não bate, evitando descobrir 30s depois quando o cron dispara.

- [ ] **Step 5: Atualizar `.env.example` com instrução crítica**

Adicionar comentário antes das ERP_QUERY_*:

```bash
# === IMPORTANTE ===
# Estas queries DEVEM retornar exatamente as colunas listadas no comentário.
# Use SQL "AS" para alias se seu schema usa nomes diferentes.
# Boot do edge faz validateErpQueries() — falha hard se faltar coluna.
```

- [ ] **Step 6: Commit**

```bash
git add packages/edge/src/erp-sync/queries.ts packages/edge/src/config/env.ts \
  packages/edge/.env.example
git commit -m "feat(erp-sync): add configurable SQL queries with boot-time column validation"
```

---

### Task 4.3: Sync funcionários — cache no DB local (sem upload Face DB ainda)

**Files:**
- Create: `packages/edge/src/erp-sync/employees.ts`
- Create: `packages/edge/tests/integration/erp-sync/employees.test.ts`

- [ ] **Step 1: Implementar sync básico (sem upload Face DB)**

```typescript
// packages/edge/src/erp-sync/employees.ts
import { logger } from "../obs/logger.js";
import { erpRepo, personsRepo } from "../persistence/repositories/index.js";
import { fetchErpEmployees } from "./queries.js";

export interface SyncResult {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
}

/**
 * Sincroniza funcionários do ERP para o cache local.
 * Cria Person para cada funcionário novo. Upload da foto pro Face DB
 * câmera fica em Task 4.4.
 */
export async function syncEmployees(): Promise<SyncResult> {
  const rows = await fetchErpEmployees();
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const erpId = String(row.id);
    const existing = await erpRepo.findEmployeeByErpId(erpId);

    if (!existing) {
      // Cache local
      await erpRepo.upsertEmployee({
        erp_id: erpId,
        name: row.name,
        role: row.role,
        photo_path: row.photo_url, // path/URL bruto; download em Task 4.4
        photo_hash: null,
        is_active: Boolean(row.is_active),
        erp_updated_at: row.photo_updated_at ? new Date(row.photo_updated_at) : null,
      });
      // Person vinculada
      await personsRepo.create({
        person_type: "employee",
        display_name: row.name,
        erp_employee_id: erpId,
      });
      created += 1;
    } else if (row.name !== existing.name || Boolean(row.is_active) !== existing.is_active) {
      await erpRepo.upsertEmployee({
        ...existing,
        name: row.name,
        role: row.role,
        is_active: Boolean(row.is_active),
      });
      // Atualizar Person também
      const person = await personsRepo.findByErpEmployeeId(erpId);
      if (person) await personsRepo.update(person.id, { display_name: row.name });
      updated += 1;
    } else {
      skipped += 1;
    }
  }

  logger.info({ fetched: rows.length, created, updated, skipped }, "employee sync complete");
  return { fetched: rows.length, created, updated, skipped };
}
```

- [ ] **Step 2: Integration test com fetchErpEmployees mockado**

```typescript
// packages/edge/tests/integration/erp-sync/employees.test.ts
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as queries from "../../../src/erp-sync/queries.js";
import { syncEmployees } from "../../../src/erp-sync/employees.js";
import { closeDb } from "../../../src/persistence/db.js";
import { erpRepo, personsRepo } from "../../../src/persistence/repositories/index.js";
import { truncateAll } from "../persistence/_helpers.js";

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
});

describe("syncEmployees", () => {
  test("cria Person + erp_employee para cada funcionário novo", async () => {
    mock.module("../../../src/erp-sync/queries.js", () => ({
      ...queries,
      fetchErpEmployees: async () => [
        { id: 1, name: "Barbeiro 1", role: "barber", is_active: 1 } as never,
        { id: 2, name: "Barbeiro 2", role: "barber", is_active: 1 } as never,
      ],
    }));
    const result = await syncEmployees();
    expect(result.created).toBe(2);
    expect(await personsRepo.findByErpEmployeeId("1")).not.toBeNull();
    expect(await erpRepo.findEmployeeByErpId("2")).not.toBeNull();
  });

  test("idempotência: rodar duas vezes não cria duplicatas", async () => {
    mock.module("../../../src/erp-sync/queries.js", () => ({
      ...queries,
      fetchErpEmployees: async () => [{ id: 1, name: "X", is_active: 1 } as never],
    }));
    await syncEmployees();
    const result2 = await syncEmployees();
    expect(result2.created).toBe(0);
    expect(result2.skipped).toBe(1);
  });
});
```

Run → 2 pass.

- [ ] **Step 3: Commit**

```bash
git add packages/edge/src/erp-sync/employees.ts \
  packages/edge/tests/integration/erp-sync/employees.test.ts
git commit -m "feat(erp-sync): sync employees to local cache + create Person records"
```

---

### Task 4.4: Upload de fotos de funcionários ao Face DB câmera

**Files:**
- Create: `packages/edge/src/erp-sync/employee-face-upload.ts`
- Modify: `packages/edge/src/erp-sync/employees.ts` (chamar upload após create/photo change)

- [ ] **Step 1: Implementar uploader**

```typescript
// packages/edge/src/erp-sync/employee-face-upload.ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DahuaFaceDbClient } from "../ingest/dahua-face-db-client.js";
import { DahuaHttpClient } from "../ingest/dahua-http-client.js";
import { getEnv } from "../config/env.js";
import { logger } from "../obs/logger.js";
import {
  camerasRepo,
  erpRepo,
  faceRecordsRepo,
} from "../persistence/repositories/index.js";

/**
 * Baixa a foto do funcionário (URL ou path local), faz hash, faz upload ao Face DB
 * câmera, e cria face_record vinculando Person ↔ camera_face_id.
 * Idempotente via photo_hash.
 *
 * Ordem das operações (importante — evita orphan state):
 *  1. Skip cedo se URL+timestamp não mudou (evita download)
 *  2. Download + hash; skip se hash igual ao cache
 *  3. Upload nova face → recebe cameraFaceId NOVO
 *  4. Cria novo face_record local (DB primeiro, mais rápido reverter)
 *  5. Apaga face_record antigo + face antiga da câmera (best-effort)
 *  6. Atualiza erp_employee cache (photo_hash)
 *
 * Se passo 3 falhar → estado inalterado (face antiga continua válida)
 * Se passo 5 falhar → face órfã na câmera (audit log alerta), mas DB consistente
 */
export async function uploadEmployeePhoto(
  personId: string,
  erpEmployeeId: string,
  photoUrl: string,
  options?: { erpUpdatedAt?: Date | null },
): Promise<{ uploaded: boolean; reason?: string }> {
  const env = getEnv();
  if (!env.CAMERA_USER || !env.CAMERA_PASS) {
    return { uploaded: false, reason: "camera_credentials_missing" };
  }

  const camera = await camerasRepo.getDefault();
  if (!camera) return { uploaded: false, reason: "no_camera_configured" };

  const existing = await erpRepo.findEmployeeByErpId(erpEmployeeId);

  // Skip cedo: URL + timestamp ERP não mudaram → assumir hash igual sem download
  if (
    existing?.photo_path === photoUrl &&
    existing.photo_hash &&
    options?.erpUpdatedAt &&
    existing.erp_updated_at &&
    options.erpUpdatedAt.getTime() === existing.erp_updated_at.getTime()
  ) {
    return { uploaded: false, reason: "url_and_timestamp_unchanged" };
  }

  const image = await fetchPhoto(photoUrl);
  const hash = createHash("sha256").update(image).digest("hex");

  if (existing?.photo_hash === hash) {
    return { uploaded: false, reason: "photo_unchanged" };
  }

  const http = new DahuaHttpClient({
    baseUrl: `http://${camera.ip_address}`,
    username: env.CAMERA_USER,
    password: env.CAMERA_PASS,
  });
  const faceDb = new DahuaFaceDbClient(http);

  // 1. Upload primeiro — se falhar, estado anterior preservado
  const newCameraFaceId = await faceDb.add({
    name: existing?.name ?? "Funcionário",
    image,
  });

  // 2. Capturar face_record antigo ANTES de criar o novo (para cleanup)
  const oldFr = await faceRecordsRepo.findPrimaryByPersonId(personId);

  // 3. Criar novo face_record (DB consistente após este ponto)
  await faceRecordsRepo.create({
    person_id: personId,
    camera_face_id: newCameraFaceId,
    snapshot_path: photoUrl,
    is_primary: true,
  });

  // 4. Cleanup do antigo (best-effort — falha gera órfão na câmera, alerta no log)
  if (oldFr) {
    try {
      if (oldFr.camera_face_id) {
        await faceDb.delete(oldFr.camera_face_id);
      }
      await faceRecordsRepo.delete(oldFr.id);
    } catch (err) {
      logger.error(
        { err, oldFrId: oldFr.id, oldCameraFaceId: oldFr.camera_face_id },
        "ORPHAN: failed to cleanup old face — manual investigation needed",
      );
    }
  }

  // 5. Atualizar cache ERP
  await erpRepo.upsertEmployee({
    ...(existing ?? { erp_id: erpEmployeeId, name: "?", is_active: true }),
    photo_path: photoUrl,
    photo_hash: hash,
  });

  logger.info(
    { personId, newCameraFaceId, hash: hash.slice(0, 8) },
    "employee photo uploaded to camera",
  );
  return { uploaded: true };
}

async function fetchPhoto(urlOrPath: string): Promise<Buffer> {
  if (urlOrPath.startsWith("http")) {
    const res = await fetch(urlOrPath);
    if (!res.ok) throw new Error(`photo fetch failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return readFile(urlOrPath);
}
```

- [ ] **Step 2: Wire-up no `syncEmployees`**

```typescript
// Em employees.ts, dentro do for loop, após create:
import { uploadEmployeePhoto } from "./employee-face-upload.js";

// Após "Person vinculada" no caminho create:
if (row.photo_url) {
  try {
    await uploadEmployeePhoto(person.id, erpId, row.photo_url);
  } catch (err) {
    logger.warn({ err, erpId }, "employee photo upload failed — Person created without face record");
  }
}

// Análogo no caminho update se photo_updated_at mudou
```

- [ ] **Step 3: Smoke test (manual com câmera real ou skip)**

Skip se câmera não disponível. Documentar que validação completa só após Task 1.10.

- [ ] **Step 4: Commit**

```bash
git add packages/edge/src/erp-sync/employee-face-upload.ts \
  packages/edge/src/erp-sync/employees.ts
git commit -m "feat(erp-sync): upload employee photos to camera Face DB with hash idempotency"
```

---

### Task 4.5: Sync clientes (sem foto, só cache)

**Files:**
- Create: `packages/edge/src/erp-sync/clients.ts`
- Create: `packages/edge/tests/integration/erp-sync/clients.test.ts`

- [ ] **Step 1: Implementar sync de clientes (idêntico padrão a employees, mais simples — sem foto)**

```typescript
// packages/edge/src/erp-sync/clients.ts
import { logger } from "../obs/logger.js";
import { erpRepo } from "../persistence/repositories/index.js";
import { fetchErpClients } from "./queries.js";
import type { SyncResult } from "./employees.js";

export async function syncClients(): Promise<SyncResult> {
  const rows = await fetchErpClients();
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const erpId = String(row.id);
    const existing = await erpRepo.findClientByErpId(erpId);

    if (!existing) {
      await erpRepo.upsertClient({
        erp_id: erpId,
        name: row.name,
        phone: row.phone,
        is_active: Boolean(row.is_active),
      });
      created += 1;
    } else if (existing.name !== row.name || existing.is_active !== Boolean(row.is_active)) {
      await erpRepo.upsertClient({ ...existing, name: row.name, is_active: Boolean(row.is_active) });
      updated += 1;
    } else {
      skipped += 1;
    }
  }

  logger.info({ fetched: rows.length, created, updated, skipped }, "client sync complete");
  return { fetched: rows.length, created, updated, skipped };
}
```

- [ ] **Step 2: Smoke test (1 teste)**

Pattern idêntico ao Task 4.3 Step 2. Skip TDD elaborado, basta 1 teste.

- [ ] **Step 3: Commit**

```bash
git add packages/edge/src/erp-sync/clients.ts \
  packages/edge/tests/integration/erp-sync/clients.test.ts
git commit -m "feat(erp-sync): sync clients to local cache (no photos)"
```

---

### Task 4.6: Polling de check-ins do ERP

**Files:**
- Create: `packages/edge/src/erp-sync/checkins.ts`
- Create: `packages/edge/tests/integration/erp-sync/checkins.test.ts`

Estratégia: cada poll lê check-ins desde o último timestamp processado. Cursor persistido em-memória + reconciliado no boot via maior `synced_at` do `erp_checkins`.

- [ ] **Step 1: Implementar `checkins.ts`**

```typescript
// packages/edge/src/erp-sync/checkins.ts
import { sql } from "drizzle-orm";
import { logger } from "../obs/logger.js";
import { getDb } from "../persistence/db.js";
import { erpCheckins } from "../persistence/schema/erp-cache.js";
import { erpRepo } from "../persistence/repositories/index.js";
import { fetchErpCheckinsSince } from "./queries.js";

let cursor: Date | null = null;

async function getInitialCursor(): Promise<Date> {
  // Pega o maior occurred_at já visto no cache, ou 1h atrás se vazio
  const rows = await getDb()
    .select({ max: sql<Date | null>`MAX(${erpCheckins.occurred_at})` })
    .from(erpCheckins);
  const stored = rows[0]?.max;
  if (stored) return new Date(stored);
  return new Date(Date.now() - 3600_000);
}

export async function pollCheckins(): Promise<{ fetched: number; new_: number }> {
  if (!cursor) cursor = await getInitialCursor();
  const rows = await fetchErpCheckinsSince(cursor);
  let new_ = 0;

  for (const row of rows) {
    const erpId = String(row.id);
    const occurredAt = new Date(row.occurred_at);
    // Cursor avança SEMPRE — mesmo se já vimos o erp_id (evita re-fetch eterno
    // de checkins antigos retornados pela query "since cursor").
    if (!cursor || occurredAt > cursor) cursor = occurredAt;

    const existing = await erpRepo.findCheckinByErpId(erpId);
    if (existing) continue;

    await erpRepo.upsertCheckin({
      erp_id: erpId,
      erp_client_id: String(row.client_id),
      event_type: row.event_type,
      occurred_at: occurredAt,
      metadata: row.metadata ? safeJsonParse(row.metadata) : {},
    });
    new_ += 1;
  }

  logger.info({ fetched: rows.length, new_ }, "checkins poll complete");
  return { fetched: rows.length, new_ };
}

function safeJsonParse(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

// Reset interno só para testes
export function _resetCursor(): void {
  cursor = null;
}
```

- [ ] **Step 2: Integration test com mock**

Smoke test similar a Task 4.3, 2 cenários (primeiro poll com 2 rows; segundo poll vazio).

- [ ] **Step 3: Commit**

```bash
git add packages/edge/src/erp-sync/checkins.ts \
  packages/edge/tests/integration/erp-sync/checkins.test.ts
git commit -m "feat(erp-sync): poll new ERP checkins with cursor persistence"
```

---

### Task 4.7: Match temporal — janela + matcher (TDD)

**Files:**
- Create: `packages/edge/src/match-temp/window.ts`
- Create: `packages/edge/src/match-temp/matcher.ts`
- Create: `packages/edge/tests/unit/match-temp/window.test.ts`
- Create: `packages/edge/tests/unit/match-temp/matcher.test.ts`
- Modify: `packages/edge/src/config/env.ts` (MATCH_WINDOW_SECONDS)

- [ ] **Step 1: Adicionar config**

```typescript
// envSchema:
MATCH_WINDOW_SECONDS: z.coerce.number().int().positive().default(300), // ±5min
```

- [ ] **Step 2: TDD — `window.ts`**

```typescript
// packages/edge/tests/unit/match-temp/window.test.ts
import { describe, expect, test } from "bun:test";
import { computeWindow } from "../../../src/match-temp/window.ts";

describe("computeWindow", () => {
  test("retorna [T-N, T+N] em segundos", () => {
    const t = new Date("2026-05-01T14:00:00Z");
    const w = computeWindow(t, 300);
    expect(w.start.toISOString()).toBe("2026-05-01T13:55:00.000Z");
    expect(w.end.toISOString()).toBe("2026-05-01T14:05:00.000Z");
  });
});
```

```typescript
// packages/edge/src/match-temp/window.ts
export interface TimeWindow {
  start: Date;
  end: Date;
}

export function computeWindow(center: Date, halfWidthSeconds: number): TimeWindow {
  const halfMs = halfWidthSeconds * 1000;
  return {
    start: new Date(center.getTime() - halfMs),
    end: new Date(center.getTime() + halfMs),
  };
}
```

Run → 1 pass.

- [ ] **Step 3: TDD — `matcher.ts` (decisão pura)**

```typescript
// packages/edge/tests/unit/match-temp/matcher.test.ts
import { describe, expect, test } from "bun:test";
import { decideMatch } from "../../../src/match-temp/matcher.js";

describe("decideMatch", () => {
  test("0 candidatas → rejected", () => {
    expect(decideMatch([])).toEqual({ decision: "rejected", chosen_detection_id: null });
  });

  test("1 candidata → auto_matched", () => {
    expect(decideMatch(["det-1"])).toEqual({
      decision: "auto_matched",
      chosen_detection_id: "det-1",
    });
  });

  test(">1 candidatas → ambiguous, sem escolha", () => {
    expect(decideMatch(["det-1", "det-2", "det-3"])).toEqual({
      decision: "ambiguous",
      chosen_detection_id: null,
    });
  });
});
```

```typescript
// packages/edge/src/match-temp/matcher.ts
export type MatchDecisionType = "auto_matched" | "ambiguous" | "rejected";

export interface MatchDecision {
  decision: MatchDecisionType;
  chosen_detection_id: string | null;
}

/**
 * Política conservadora:
 * - 1 candidata anônima → auto match
 * - >1 candidatas → ambíguo, requer revisão manual
 * - 0 → rejeitado (logar para tuning de janela)
 */
export function decideMatch(anonymousDetectionIds: readonly string[]): MatchDecision {
  if (anonymousDetectionIds.length === 0) {
    return { decision: "rejected", chosen_detection_id: null };
  }
  if (anonymousDetectionIds.length === 1) {
    return { decision: "auto_matched", chosen_detection_id: anonymousDetectionIds[0]! };
  }
  return { decision: "ambiguous", chosen_detection_id: null };
}
```

Run → 3 pass.

- [ ] **Step 4: Commit**

```bash
git add packages/edge/src/match-temp/ packages/edge/tests/unit/match-temp/ \
  packages/edge/src/config/env.ts
git commit -m "feat(match-temp): pure window calc + decision matcher"
```

---

### Task 4.8: Match temporal — orchestrator + persistência

**Files:**
- Create: `packages/edge/src/match-temp/orchestrator.ts`
- Create: `packages/edge/tests/integration/match-temp/orchestrator.test.ts`

- [ ] **Step 1: Implementar orchestrator (lê checkin → busca anônimas → decide → persiste)**

```typescript
// packages/edge/src/match-temp/orchestrator.ts
import { getEnv } from "../config/env.js";
import { logger } from "../obs/logger.js";
import {
  detectionsRepo,
  erpRepo,
  matchAttemptsRepo,
  personsRepo,
  sessionsRepo,
} from "../persistence/repositories/index.js";
import type { ErpCheckin } from "../persistence/schema/erp-cache.js";
import { decideMatch } from "./matcher.js";
import { computeWindow } from "./window.js";

/**
 * Para um checkin não-processado, busca face anônimas dentro da janela ±N seg
 * e tenta vincular. Idempotente (marca processed_at no fim).
 */
export async function processCheckin(checkin: ErpCheckin): Promise<void> {
  if (checkin.processed_at) return;
  const env = getEnv();
  const window = computeWindow(checkin.occurred_at, env.MATCH_WINDOW_SECONDS);

  const anonymousDetections = await detectionsRepo.findAnonymousInWindow(
    window.start,
    window.end,
  );
  const decision = decideMatch(anonymousDetections.map((d) => d.id));

  await matchAttemptsRepo.create({
    detection_id: decision.chosen_detection_id,
    erp_checkin_id: checkin.erp_id,
    decision: decision.decision,
    decided_by: "system",
    notes:
      decision.decision === "ambiguous"
        ? `${anonymousDetections.length} candidates`
        : undefined,
  });

  if (decision.decision === "auto_matched" && decision.chosen_detection_id) {
    const det = anonymousDetections.find((d) => d.id === decision.chosen_detection_id)!;
    // Vincula Person → erp_client
    let person = await personsRepo.findByErpClientId(checkin.erp_client_id);
    const erpClient = await erpRepo.findClientByErpId(checkin.erp_client_id);
    if (!person) {
      person = await personsRepo.create({
        person_type: "client",
        display_name: erpClient?.name ?? "Cliente",
        erp_client_id: checkin.erp_client_id,
      });
    }
    // Atualiza detection + session com person_id
    await detectionsRepo.linkToPerson(det.id, person.id);
    if (det.session_id) {
      await sessionsRepo.linkToPerson(det.session_id, person.id, checkin.erp_id);
    }
    logger.info(
      { person_id: person.id, detection_id: det.id, checkin_id: checkin.erp_id },
      "auto-matched anonymous detection to ERP client",
    );
  }

  await erpRepo.markCheckinProcessed(checkin.erp_id);
}

/**
 * Loop: pega N checkins não-processados e processa cada um.
 */
export async function processAllPendingCheckins(limit = 100): Promise<number> {
  const pending = await erpRepo.findUnprocessedCheckinsBefore(new Date(), limit);
  for (const c of pending) {
    try {
      await processCheckin(c);
    } catch (err) {
      logger.error({ err, checkin_id: c.erp_id }, "checkin processing failed");
    }
  }
  return pending.length;
}
```

- [ ] **Step 2: Integration test E2E (cliente confirma → face anônima vinculada)**

```typescript
// packages/edge/tests/integration/match-temp/orchestrator.test.ts
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { processCheckin } from "../../../src/match-temp/orchestrator.js";
import { closeDb } from "../../../src/persistence/db.js";
import {
  camerasRepo,
  detectionsRepo,
  erpRepo,
  matchAttemptsRepo,
  personsRepo,
  sessionsRepo,
} from "../../../src/persistence/repositories/index.js";
import { truncateAll } from "../persistence/_helpers.js";

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
});

describe("processCheckin", () => {
  test("auto_match: 1 detection anônima na janela → vinculação", async () => {
    const cam = await camerasRepo.create({ name: "c", ip_address: "x" });
    await erpRepo.upsertClient({ erp_id: "cli-1", name: "Cliente Teste", is_active: true });
    const session = await sessionsRepo.create({
      camera_id: cam.id,
      started_at: new Date("2026-05-01T14:00:00Z"),
      detection_count: 1,
    });
    const det = await detectionsRepo.create({
      camera_id: cam.id,
      session_id: session.id,
      detected_at: new Date("2026-05-01T14:01:00Z"),
      raw_event: {},
      face_attrs: {},
    });
    const checkin = await erpRepo.upsertCheckin({
      erp_id: "chk-1",
      erp_client_id: "cli-1",
      event_type: "appointment_confirmed",
      occurred_at: new Date("2026-05-01T14:00:30Z"),
    });

    await processCheckin(checkin);

    const updatedDet = await detectionsRepo.findById(det.id);
    expect(updatedDet?.person_id).toBeDefined();
    const person = await personsRepo.findByErpClientId("cli-1");
    expect(person?.id).toBe(updatedDet?.person_id!);
    const attempts = await matchAttemptsRepo.findByCheckin("chk-1");
    expect(attempts[0]?.decision).toBe("auto_matched");
  });

  test("ambiguous: 2 detections anônimas → match_attempt sem vinculação", async () => {
    // Setup similar com 2 detections diferentes na janela
    // ... (~25 linhas)
    // Asserts: decision='ambiguous', chosen_detection_id=null, nenhuma detection foi vinculada
  });
});
```

Run → 2+ pass.

- [ ] **Step 3: Commit**

```bash
git add packages/edge/src/match-temp/orchestrator.ts \
  packages/edge/tests/integration/match-temp/orchestrator.test.ts
git commit -m "feat(match-temp): orchestrator binds ERP checkins to anonymous detections"
```

---

### Task 4.9: Upload-back após match (sobe face anônima ao Face DB câmera)

**Files:**
- Create: `packages/edge/src/match-temp/upload-back.ts`
- Modify: `packages/edge/src/match-temp/orchestrator.ts` (chamar após auto_matched)

- [ ] **Step 1: Implementar `upload-back.ts`**

```typescript
// packages/edge/src/match-temp/upload-back.ts
import { readFile } from "node:fs/promises";
import { DahuaFaceDbClient } from "../ingest/dahua-face-db-client.js";
import { DahuaHttpClient } from "../ingest/dahua-http-client.js";
import { getEnv } from "../config/env.js";
import { logger } from "../obs/logger.js";
import {
  camerasRepo,
  detectionsRepo,
  faceRecordsRepo,
  personsRepo,
} from "../persistence/repositories/index.js";

/**
 * Após auto_match de uma detection anônima → cliente do ERP, sobe a face
 * pro Face DB câmera para que próximas visitas já cheguem identificadas.
 */
export async function uploadBackAfterMatch(
  detectionId: string,
  personId: string,
): Promise<{ uploaded: boolean; reason?: string }> {
  const det = await detectionsRepo.findById(detectionId);
  if (!det?.snapshot_path) return { uploaded: false, reason: "no_snapshot" };

  const env = getEnv();
  if (!env.CAMERA_USER || !env.CAMERA_PASS) return { uploaded: false, reason: "no_credentials" };

  const camera = await camerasRepo.getDefault();
  if (!camera) return { uploaded: false, reason: "no_camera" };

  const person = await personsRepo.findById(personId);
  if (!person) return { uploaded: false, reason: "person_not_found" };

  const image = await readFile(det.snapshot_path);
  const http = new DahuaHttpClient({
    baseUrl: `http://${camera.ip_address}`,
    username: env.CAMERA_USER,
    password: env.CAMERA_PASS,
  });
  const faceDb = new DahuaFaceDbClient(http);

  const faceId = await faceDb.add({
    name: person.display_name ?? "Cliente",
    image,
  });

  await faceRecordsRepo.create({
    person_id: personId,
    camera_face_id: faceId,
    snapshot_path: det.snapshot_path,
    is_primary: true,
  });

  logger.info({ personId, faceId }, "uploaded back face to camera DB after match");
  return { uploaded: true };
}
```

- [ ] **Step 2: Wire-up no orchestrator**

```typescript
// Em orchestrator.ts, após detectionsRepo.linkToPerson:
import { uploadBackAfterMatch } from "./upload-back.js";

// fire-and-forget — não bloqueia processamento de próximos checkins
void uploadBackAfterMatch(det.id, person.id).catch((err) =>
  logger.warn({ err, detection_id: det.id }, "upload-back failed"),
);
```

- [ ] **Step 3: Commit**

```bash
git add packages/edge/src/match-temp/upload-back.ts \
  packages/edge/src/match-temp/orchestrator.ts
git commit -m "feat(match-temp): upload anonymous face to camera DB after auto-match"
```

---

### Task 4.10: Scheduler — sync periódico

**Files:**
- Create: `packages/edge/src/erp-sync/scheduler.ts`
- Modify: `packages/edge/src/main.ts`
- Modify: `packages/edge/package.json` (dep node-cron)

- [ ] **Step 1: Instalar dep**

```bash
cd packages/edge && bun add node-cron && bun add -d @types/node-cron
```

- [ ] **Step 2: Implementar scheduler**

```typescript
// packages/edge/src/erp-sync/scheduler.ts
import cron from "node-cron";
import { logger } from "../obs/logger.js";
import { syncClients } from "./clients.js";
import { syncEmployees } from "./employees.js";
import { pollCheckins } from "./checkins.js";
import { processAllPendingCheckins } from "../match-temp/orchestrator.js";

export interface SchedulerHandle {
  stop: () => void;
}

/**
 * Guard contra invocações concorrentes do mesmo job — node-cron NÃO previne.
 * Se job anterior ainda roda quando o cron dispara, skip com warn log.
 */
function withRunningGuard(name: string, fn: () => Promise<void>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) {
      logger.warn({ job: name }, "scheduler: skipping — previous run still in progress");
      return;
    }
    running = true;
    try {
      await fn();
    } catch (err) {
      logger.error({ err, job: name }, "scheduled job failed");
    } finally {
      running = false;
    }
  };
}

export function startScheduler(): SchedulerHandle {
  // Funcionários: hourly (mudanças raras)
  const empJob = cron.schedule(
    "0 * * * *",
    withRunningGuard("employees", async () => {
      await syncEmployees();
    }),
  );

  // Clientes: a cada 15min
  const cliJob = cron.schedule(
    "*/15 * * * *",
    withRunningGuard("clients", async () => {
      await syncClients();
    }),
  );

  // Checkins: a cada 30s (near-real-time pra match temporal)
  const chkJob = cron.schedule(
    "*/30 * * * * *",
    withRunningGuard("checkins", async () => {
      await pollCheckins();
      await processAllPendingCheckins();
    }),
  );

  logger.info("ERP sync scheduler started");

  return {
    stop() {
      empJob.stop();
      cliJob.stop();
      chkJob.stop();
      logger.info("ERP sync scheduler stopped");
    },
  };
}
```

- [ ] **Step 3: Wire-up no main.ts**

```typescript
// Após start de listeners:
import { startScheduler } from "./erp-sync/scheduler.js";

let schedulerHandle: { stop: () => void } | null = null;
if (env.ERP_MYSQL_URL) {
  schedulerHandle = startScheduler();
}

// No graceful shutdown:
if (schedulerHandle) schedulerHandle.stop();
```

- [ ] **Step 4: Commit**

```bash
git add packages/edge/src/erp-sync/scheduler.ts packages/edge/src/main.ts \
  packages/edge/package.json packages/edge/bun.lock
git commit -m "feat(erp-sync): scheduler runs employee/client sync + checkin polling on cron"
```

---

### Task 4.11: REST endpoints para sync manual + match revisão

**Files:**
- Create: `packages/edge/src/api/routes/erp.ts`
- Create: `packages/edge/src/api/routes/matches.ts`
- Modify: `packages/edge/src/api/server.ts`

- [ ] **Step 1: ERP routes (factory pattern)**

```typescript
// packages/edge/src/api/routes/erp.ts
import { Hono } from "hono";

export interface ErpDeps {
  syncEmployees: () => Promise<{ created: number; updated: number; skipped: number }>;
  syncClients: () => Promise<{ created: number; updated: number; skipped: number }>;
  pollCheckins: () => Promise<{ fetched: number; new_: number }>;
  status: () => Promise<{
    employees_count: number;
    clients_count: number;
    last_checkin_at: string | null;
  }>;
}

export function createErpRoutes(deps: ErpDeps): Hono {
  const r = new Hono();

  r.post("/sync/employees", async (c) => c.json(await deps.syncEmployees()));
  r.post("/sync/clients", async (c) => c.json(await deps.syncClients()));
  r.post("/sync/checkins", async (c) => c.json(await deps.pollCheckins()));
  r.get("/sync/status", async (c) => c.json(await deps.status()));

  return r;
}
```

- [ ] **Step 2: Match routes**

```typescript
// packages/edge/src/api/routes/matches.ts
import { Hono } from "hono";
import { z } from "zod";
import type { MatchAttempt } from "../../persistence/schema/match-attempts.js";

export interface MatchDeps {
  listPending: (limit: number) => Promise<MatchAttempt[]>;
  resolve: (id: string, chosenDetectionId: string, chosenPersonId: string) => Promise<void>;
  reject: (id: string, reason?: string) => Promise<void>;
}

const resolveBody = z.object({
  chosen_detection_id: z.string().uuid(),
  chosen_person_id: z.string().uuid(),
});

export function createMatchRoutes(deps: MatchDeps): Hono {
  const r = new Hono();

  r.get("/pending", async (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    const items = await deps.listPending(limit);
    return c.json({ items });
  });

  r.post("/:id/resolve", async (c) => {
    const id = c.req.param("id");
    const raw = await c.req.json().catch(() => ({}));
    const parsed = resolveBody.safeParse(raw);
    if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
    await deps.resolve(id, parsed.data.chosen_detection_id, parsed.data.chosen_person_id);
    return c.json({ ok: true });
  });

  r.post("/:id/reject", async (c) => {
    const id = c.req.param("id");
    const reason = (await c.req.json().catch(() => ({}))) as { reason?: string };
    await deps.reject(id, reason.reason);
    return c.json({ ok: true });
  });

  return r;
}
```

- [ ] **Step 3: Wire-up no server.ts**

Mount em `/api/erp` e `/api/matches`. Implementar deps reais usando os módulos `erp-sync/*` e `matchAttemptsRepo`.

- [ ] **Step 4: Smoke tests com deps mockados**

Pattern idêntico a discovery routes — 4-5 tests por arquivo.

- [ ] **Step 5: Commit**

```bash
git add packages/edge/src/api/routes/erp.ts packages/edge/src/api/routes/matches.ts \
  packages/edge/src/api/server.ts packages/edge/tests/unit/api/routes/
git commit -m "feat(api): expose /api/erp/sync/* and /api/matches/* endpoints"
```

---

### Task 4.12: Verificação final do Chunk 4 + Onda 2

- [ ] **Step 1: Suite completa**

```bash
cd packages/edge && API_KEY=k DATABASE_URL=postgres://vipcam:vipcam@localhost:5432/vipcam bun test
# Expected: ~75 testes total (Onda 1: 22, Chunk 2: 18, Chunk 3: 9, Chunk 4: ~26)
```

- [ ] **Step 2: Typecheck + lint + build**

```bash
cd /d/Dev/Barbearia\ VIP/DH-IPC-HFW5442T-ASE && bun run typecheck && bun run lint
cd packages/web && bun run build
```

- [ ] **Step 3: Smoke test full-stack (sem ERP/câmera real)**

```bash
bun run dev &
sleep 8
curl -fs http://localhost:4000/api/health | jq
curl -fs http://localhost:3000/discovery > /dev/null && echo "discovery ok"
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:4000/api/erp/sync/employees
# 503 esperado se ERP não configurado, 200 se sync rodou
kill %1
```

- [ ] **Step 4: Documentar limitações no spec**

Atualizar `docs/superpowers/specs/2026-04-29-camera-monitoring-design.md` Seção 11 (Riscos):
- R1 (discovery não rodou) → ainda pendente
- R2 (Face DB capacidade) → adicionar item: "validar capacidade real após Task 1.10"
- Adicionar nova seção "## 0. Estado pós-Onda 2" com lista do que está implementado e o que ainda depende de Task 1.10.

Commit:

```bash
git add docs/superpowers/specs/
git commit -m "docs: register Onda 2 implementation state in spec"
```

**Checkpoint Onda 2 atingido:** ingest pipeline completo (eventos → DB), re-id A funcional (camera reconhece → person identificada), funcionários cadastrados via ERP sync, clientes vinculados via match temporal. **Pendente para validação real:** Task 1.10 (discovery contra câmera), conexão ERP MySQL real (env + queries ajustadas).

Próxima Onda (3): Fases 5+6 — frontend completo (lista de pessoas, perfil com Stack B + Timeline A, /matches UI) + failover B (re-id local com InsightFace).

---

## Próximas ondas (placeholder, não planejar agora)

- **Onda 3:** Fases 5 + 6 — frontend completo + failover B (re-id local). Planejar após Onda 2 ter rodado em produção (mesmo que com 1 unidade) por algumas semanas para sentir gaps de UX.
- **Onda 4:** Fase 7 — hardening + deploy on-premise (systemd units, retention job, deploy.md).
