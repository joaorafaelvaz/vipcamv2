import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { apiKeyMiddleware } from "../../../../src/api/middleware/api-key.js";

function appWithKey(key: string): Hono {
  const app = new Hono();
  app.use("/protected/*", apiKeyMiddleware(key));
  app.get("/protected/data", (c) => c.json({ secret: "shh" }));
  app.get("/public", (c) => c.json({ ok: true }));
  return app;
}

describe("apiKeyMiddleware", () => {
  const key = "valid-secret-123";

  test("retorna 401 quando X-API-Key header ausente", async () => {
    const app = appWithKey(key);
    const res = await app.request("/protected/data");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  test("retorna 401 quando X-API-Key incorreto", async () => {
    const app = appWithKey(key);
    const res = await app.request("/protected/data", {
      headers: { "X-API-Key": "wrong-key" },
    });
    expect(res.status).toBe(401);
  });

  test("permite request quando X-API-Key correto", async () => {
    const app = appWithKey(key);
    const res = await app.request("/protected/data", {
      headers: { "X-API-Key": key },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { secret: string };
    expect(body.secret).toBe("shh");
  });

  test("não interfere com rotas sem o middleware", async () => {
    const app = appWithKey(key);
    const res = await app.request("/public");
    expect(res.status).toBe(200);
  });

  test("aceita header case-insensitive (x-api-key lowercase)", async () => {
    const app = appWithKey(key);
    const res = await app.request("/protected/data", {
      headers: { "x-api-key": key },
    });
    expect(res.status).toBe(200);
  });
});

describe("apiKeyMiddleware — query param exception (SSE only)", () => {
  const key = "valid-secret-123";

  function appAllowingQueryOn(pathSuffix: string): Hono {
    const app = new Hono();
    app.use("/api/*", apiKeyMiddleware(key, { allowQueryOn: pathSuffix }));
    app.get("/api/events/stream", (c) => c.text("ok"));
    app.post("/api/erp/sync/employees", (c) => c.text("danger"));
    return app;
  }

  test("aceita ?api_key= em /api/events/stream", async () => {
    const app = appAllowingQueryOn("/api/events/stream");
    const res = await app.request(`/api/events/stream?api_key=${key}`);
    expect(res.status).toBe(200);
  });

  test("REJEITA ?api_key= em endpoint mutativo (mesma config)", async () => {
    const app = appAllowingQueryOn("/api/events/stream");
    const res = await app.request(`/api/erp/sync/employees?api_key=${key}`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("ainda aceita header X-API-Key normal em qualquer rota", async () => {
    const app = appAllowingQueryOn("/api/events/stream");
    const res = await app.request("/api/erp/sync/employees", {
      method: "POST",
      headers: { "X-API-Key": key },
    });
    expect(res.status).toBe(200);
  });
});
