import type {
  IdentifyQueueItem,
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
  // Onda 10 — curadoria "identificar funcionário" (anônimo → employee):
  listIdentifyQueue: (limit: number) => Promise<
    Array<{
      person_id: string;
      detection_count: number;
      last_seen_at: Date | null;
      snapshots: string[];
    }>
  >;
  findPersonType: (id: string) => Promise<"client" | "employee" | "anonymous" | null>;
  /** mergeInto(anon → employee, 'user'). Lança /not found/ em race. */
  mergeIntoEmployee: (anonId: string, employeePersonId: string) => Promise<void>;
  dismissIdentify: (id: string) => Promise<void>;
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

// Onda 10 — body do POST /:id/identify
const identifyBody = z.object({
  employee_person_id: z.string().uuid(),
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

  // Onda 10 — fila de curadoria (anônimos frequentes, prováveis staff).
  // ANTES de /:id: Hono casa rotas na ordem — senão :id capturaria "identify".
  r.get("/identify/queue", async (c) => {
    const limit = clamp(Number(c.req.query("limit") ?? 20), 1, 100);
    const rows = await deps.listIdentifyQueue(limit);
    const items: IdentifyQueueItem[] = rows.map((row) => ({
      person_id: row.person_id,
      detection_count: row.detection_count,
      last_seen_at: row.last_seen_at ? row.last_seen_at.toISOString() : null,
      snapshots: row.snapshots,
    }));
    return c.json({ items });
  });

  // Onda 10 — "esse anônimo é o funcionário X": merge anon → employee.
  // O funcionário herda os face_records da câmera → reid passa a reconhecê-lo.
  r.post("/:id/identify", async (c) => {
    const id = c.req.param("id");
    const parsed = identifyBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    }
    const anonType = await deps.findPersonType(id);
    if (anonType === null) return c.json({ error: "not_found" }, 404);
    if (anonType !== "anonymous") return c.json({ error: "not_anonymous" }, 400);
    const empType = await deps.findPersonType(parsed.data.employee_person_id);
    if (empType !== "employee") return c.json({ error: "not_employee" }, 400);
    try {
      await deps.mergeIntoEmployee(id, parsed.data.employee_person_id);
    } catch (err) {
      // Race: anon já merged por outro caminho (auto-merge 9-D / outro operador).
      if (err instanceof Error && /not found/i.test(err.message)) {
        return c.json({ error: "concurrent_merge", message: err.message }, 409);
      }
      throw err;
    }
    return c.json({ ok: true });
  });

  // Onda 10 — "não é funcionário" (ex.: cliente frequente): sai da fila.
  r.post("/:id/identify/dismiss", async (c) => {
    const id = c.req.param("id");
    const t = await deps.findPersonType(id);
    if (t === null) return c.json({ error: "not_found" }, 404);
    if (t !== "anonymous") return c.json({ error: "not_anonymous" }, 400);
    await deps.dismissIdentify(id);
    return c.json({ ok: true });
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
