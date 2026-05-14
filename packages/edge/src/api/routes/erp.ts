import { Hono } from "hono";

/**
 * Resultado de uma operação de sync. Mantido genérico (qualquer sync_*
 * produz esse shape) pra simplificar UI e curl manual.
 */
export interface SyncOpResult {
  fetched?: number;
  created?: number;
  updated?: number;
  skipped?: number;
  new_?: number;
}

export interface ErpStatus {
  employees_count: number;
  clients_count: number;
  last_checkin_at: string | null;
}

export interface ErpDeps {
  syncEmployees: () => Promise<SyncOpResult>;
  syncClients: () => Promise<SyncOpResult>;
  pollCheckins: () => Promise<SyncOpResult>;
  status: () => Promise<ErpStatus>;
}

/**
 * Endpoints REST pra disparar sync manualmente (botão admin) + status.
 * Cron rodando em background ainda continua, esses endpoints são pra
 * acelerar feedback durante teste/debug ou força re-sync após mudança
 * de schema.
 */
export function createErpRoutes(deps: ErpDeps): Hono {
  const r = new Hono();

  r.post("/sync/employees", async (c) => c.json(await deps.syncEmployees()));
  r.post("/sync/clients", async (c) => c.json(await deps.syncClients()));
  r.post("/sync/checkins", async (c) => c.json(await deps.pollCheckins()));
  r.get("/sync/status", async (c) => c.json(await deps.status()));

  return r;
}
