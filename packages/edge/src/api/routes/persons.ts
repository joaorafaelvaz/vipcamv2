import type {
  PaginatedResponse,
  PersonDetail,
  PersonSummary,
  SessionWithDetections,
} from "@vipcam/shared";
import { Hono } from "hono";
import { z } from "zod";

export interface PersonsDeps {
  list: (params: {
    type?: "client" | "employee";
    search?: string;
    limit: number;
    offset: number;
  }) => Promise<PaginatedResponse<PersonSummary>>;
  getById: (id: string) => Promise<PersonDetail | null>;
  listSessions: (id: string, limit: number) => Promise<SessionWithDetections[]>;
}

const listQuery = z.object({
  type: z.enum(["client", "employee"]).optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().optional().default(50),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
});

const sessionsQuery = z.object({
  limit: z.coerce.number().int().positive().optional().default(20),
});

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Endpoints REST de pessoas (Onda 3 — visibility dashboard).
 *
 * - GET /        lista paginada com filtros opcionais (type, search)
 * - GET /:id     PersonDetail com agregados (avg_emotion, first_seen, etc)
 * - GET /:id/sessions  stack de visitas (com detections embedded)
 *
 * Auth via apiKeyMiddleware aplicado em /api/persons/* no server.ts.
 */
export function createPersonsRoutes(deps: PersonsDeps): Hono {
  const r = new Hono();

  r.get("/", async (c) => {
    const parsed = listQuery.safeParse({
      type: c.req.query("type"),
      search: c.req.query("search"),
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    });
    if (!parsed.success) {
      return c.json({ error: "invalid_query", issues: parsed.error.issues }, 400);
    }
    const params: Parameters<PersonsDeps["list"]>[0] = {
      limit: clamp(parsed.data.limit, 1, 200),
      offset: parsed.data.offset,
    };
    if (parsed.data.type !== undefined) params.type = parsed.data.type;
    if (parsed.data.search !== undefined) params.search = parsed.data.search;
    const result = await deps.list(params);
    return c.json(result);
  });

  r.get("/:id", async (c) => {
    const id = c.req.param("id");
    const person = await deps.getById(id);
    if (!person) return c.json({ error: "not_found" }, 404);
    return c.json(person);
  });

  r.get("/:id/sessions", async (c) => {
    const id = c.req.param("id");
    const parsed = sessionsQuery.safeParse({ limit: c.req.query("limit") });
    if (!parsed.success) return c.json({ error: "invalid_query" }, 400);
    const items = await deps.listSessions(id, clamp(parsed.data.limit, 1, 100));
    return c.json({ items });
  });

  return r;
}
