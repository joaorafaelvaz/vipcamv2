import { describe, expect, test } from "bun:test";
import type {
  PaginatedResponse,
  PersonDetail,
  PersonSummary,
  SessionWithDetections,
} from "@vipcam/shared";
import { Hono } from "hono";
import { type PersonsDeps, createPersonsRoutes } from "../../../../src/api/routes/persons.js";

const stubPerson: PersonSummary = {
  id: "11111111-1111-1111-1111-111111111111",
  display_name: "Ana",
  person_type: "client",
  photo_path: null,
  last_seen_at: "2026-05-12T12:00:00Z",
  total_visits: 5,
  erp_client_id: "100",
  erp_employee_id: null,
  phone: "11999",
};

function mountWith(deps: PersonsDeps): Hono {
  const app = new Hono();
  app.route("/api/persons", createPersonsRoutes(deps));
  app.onError((_err, c) => c.json({ error: "internal_error" }, 500));
  return app;
}

function defaultDeps(overrides: Partial<PersonsDeps> = {}): PersonsDeps {
  return {
    list: async () => ({ items: [stubPerson], total: 1 }),
    getById: async () =>
      ({
        ...stubPerson,
        avg_dominant_emotion: "happy",
        first_seen_at: "2026-04-01T00:00:00Z",
        avg_visit_duration_min: 15,
      }) as PersonDetail,
    listSessions: async () => [],
    ...overrides,
  };
}

describe("GET /api/persons", () => {
  test("default sem query params: limit=50 offset=0 sem filtros", async () => {
    let receivedParams: unknown;
    const app = mountWith(
      defaultDeps({
        list: async (params) => {
          receivedParams = params;
          return { items: [stubPerson], total: 1 };
        },
      }),
    );
    const res = await app.request("/api/persons");
    expect(res.status).toBe(200);
    expect(receivedParams).toEqual({ limit: 50, offset: 0 });
  });

  test("aceita ?type=client&search=ana&limit=10&offset=20", async () => {
    let receivedParams: unknown;
    const app = mountWith(
      defaultDeps({
        list: async (params) => {
          receivedParams = params;
          return { items: [], total: 0 };
        },
      }),
    );
    const res = await app.request("/api/persons?type=client&search=ana&limit=10&offset=20");
    expect(res.status).toBe(200);
    expect(receivedParams).toEqual({ type: "client", search: "ana", limit: 10, offset: 20 });
  });

  test("rejeita ?type=outro com 400", async () => {
    const app = mountWith(defaultDeps());
    const res = await app.request("/api/persons?type=outro");
    expect(res.status).toBe(400);
  });

  test("clampa limit em [1, 200]", async () => {
    let receivedParams: { limit: number; offset: number } | undefined;
    const app = mountWith(
      defaultDeps({
        list: async (p) => {
          receivedParams = p;
          return { items: [], total: 0 };
        },
      }),
    );
    await app.request("/api/persons?limit=999");
    expect(receivedParams?.limit).toBe(200);
    await app.request("/api/persons?limit=0");
    expect(receivedParams?.limit).toBe(1);
  });
});

describe("GET /api/persons/:id", () => {
  test("retorna 200 com PersonDetail quando achado", async () => {
    const app = mountWith(defaultDeps());
    const res = await app.request(`/api/persons/${stubPerson.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PersonDetail;
    expect(body.id).toBe(stubPerson.id);
    expect(body.avg_dominant_emotion).toBe("happy");
  });

  test("retorna 404 quando getById devolve null", async () => {
    const app = mountWith(defaultDeps({ getById: async () => null }));
    const res = await app.request(`/api/persons/${stubPerson.id}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/persons/:id/sessions", () => {
  const stubSession: SessionWithDetections = {
    id: "22222222-2222-2222-2222-222222222222",
    started_at: "2026-05-12T10:00:00Z",
    ended_at: null,
    detection_count: 5,
    dominant_emotion: "happy",
    linked_erp_checkin_id: null,
    detections: [],
  };

  test("default limit=20, retorna { items }", async () => {
    let receivedLimit: number | undefined;
    const app = mountWith(
      defaultDeps({
        listSessions: async (_id, limit) => {
          receivedLimit = limit;
          return [stubSession];
        },
      }),
    );
    const res = await app.request(`/api/persons/${stubPerson.id}/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: SessionWithDetections[] };
    expect(receivedLimit).toBe(20);
    expect(body.items).toHaveLength(1);
  });

  test("aceita ?limit= explicit", async () => {
    let receivedLimit: number | undefined;
    const app = mountWith(
      defaultDeps({
        listSessions: async (_id, limit) => {
          receivedLimit = limit;
          return [];
        },
      }),
    );
    await app.request(`/api/persons/${stubPerson.id}/sessions?limit=5`);
    expect(receivedLimit).toBe(5);
  });
});

// Suppress unused import warning for PaginatedResponse (used via stubPerson type)
const _typeAlias: PaginatedResponse<PersonSummary> | undefined = undefined;
void _typeAlias;
