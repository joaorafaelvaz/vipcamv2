import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  type ErpDeps,
  type ErpStatus,
  type SyncOpResult,
  createErpRoutes,
} from "../../../../src/api/routes/erp.js";

function mountWith(deps: ErpDeps): Hono {
  const app = new Hono();
  app.route("/api/erp", createErpRoutes(deps));
  return app;
}

const stubResult: SyncOpResult = { fetched: 3, created: 1, updated: 1, skipped: 1 };
const stubStatus: ErpStatus = {
  employees_count: 5,
  clients_count: 42,
  last_checkin_at: "2026-05-12T12:00:00Z",
};

function deps(overrides: Partial<ErpDeps> = {}): ErpDeps {
  return {
    syncEmployees: async () => stubResult,
    syncClients: async () => stubResult,
    pollCheckins: async () => ({ fetched: 2, new_: 2 }),
    status: async () => stubStatus,
    ...overrides,
  };
}

describe("POST /api/erp/sync/employees", () => {
  test("invoca syncEmployees e retorna o SyncOpResult como JSON", async () => {
    let called = 0;
    const app = mountWith(
      deps({
        syncEmployees: async () => {
          called += 1;
          return stubResult;
        },
      }),
    );
    const res = await app.request("/api/erp/sync/employees", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncOpResult;
    expect(called).toBe(1);
    expect(body).toEqual(stubResult);
  });
});

describe("POST /api/erp/sync/clients", () => {
  test("invoca syncClients e retorna o SyncOpResult como JSON", async () => {
    let called = 0;
    const app = mountWith(
      deps({
        syncClients: async () => {
          called += 1;
          return stubResult;
        },
      }),
    );
    const res = await app.request("/api/erp/sync/clients", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncOpResult;
    expect(called).toBe(1);
    expect(body).toEqual(stubResult);
  });
});

describe("POST /api/erp/sync/checkins", () => {
  test("invoca pollCheckins e retorna fetched/new_", async () => {
    let called = 0;
    const app = mountWith(
      deps({
        pollCheckins: async () => {
          called += 1;
          return { fetched: 7, new_: 3 };
        },
      }),
    );
    const res = await app.request("/api/erp/sync/checkins", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fetched: number; new_: number };
    expect(called).toBe(1);
    expect(body).toEqual({ fetched: 7, new_: 3 });
  });
});

describe("GET /api/erp/sync/status", () => {
  test("retorna ErpStatus com counts e last_checkin_at", async () => {
    const app = mountWith(deps());
    const res = await app.request("/api/erp/sync/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ErpStatus;
    expect(body).toEqual(stubStatus);
  });

  test("repassa last_checkin_at=null quando ainda não houve checkin", async () => {
    const app = mountWith(
      deps({
        status: async () => ({ employees_count: 0, clients_count: 0, last_checkin_at: null }),
      }),
    );
    const res = await app.request("/api/erp/sync/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ErpStatus;
    expect(body.last_checkin_at).toBeNull();
  });
});
