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

const rejectBody = z.object({
  reason: z.string().optional(),
});

/**
 * Endpoints REST para revisão manual de matches ambíguos.
 *
 * - GET /pending: lista match_attempts decision='ambiguous' (operador escolhe um)
 * - POST /:id/resolve: vincula detection escolhida ao Person/erp_client
 *   (decision vira auto_matched, decided_by='user')
 * - POST /:id/reject: descarta o match attempt (decision='rejected', decided_by='user')
 *
 * Auth fica delegada a middleware externo (middleware X-API-Key vem em Onda 3).
 */
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
    if (!parsed.success) {
      return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    }
    await deps.resolve(id, parsed.data.chosen_detection_id, parsed.data.chosen_person_id);
    return c.json({ ok: true });
  });

  r.post("/:id/reject", async (c) => {
    const id = c.req.param("id");
    const raw = await c.req.json().catch(() => ({}));
    const parsed = rejectBody.safeParse(raw);
    const reason = parsed.success ? parsed.data.reason : undefined;
    await deps.reject(id, reason);
    return c.json({ ok: true });
  });

  return r;
}
