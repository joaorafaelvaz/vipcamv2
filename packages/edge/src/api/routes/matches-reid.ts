import type { ReidMatchPendingEnriched, ReidResolveDecision } from "@vipcam/shared";
import { Hono } from "hono";

export interface MatchesReidDeps {
  findPending: (limit: number) => Promise<ReidMatchPendingEnriched[]>;
  /** userId é placeholder "system" enquanto NextAuth não chega (Onda futura). */
  resolve: (id: string, decision: ReidResolveDecision, userId: string) => Promise<void>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const VALID_DECISIONS: ReidResolveDecision[] = ["matched_to_candidate", "rejected_new_person"];

/**
 * Reid borderline review endpoints (Onda 7 §5.3).
 *
 * Auth via apiKeyMiddleware aplicado em /api/matches/* no server.ts (já existe
 * pra aba temporal). userId placeholder "system" porque NextAuth é Onda futura.
 */
export function createMatchesReidRoutes(deps: MatchesReidDeps): Hono {
  const r = new Hono();

  r.get("/pending", async (c) => {
    const raw = c.req.query("limit");
    let limit = DEFAULT_LIMIT;
    if (raw !== undefined) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
        return c.json({ error: `limit must be 1..${MAX_LIMIT}` }, 400);
      }
      limit = n;
    }
    return c.json(await deps.findPending(limit));
  });

  r.post("/:id/resolve", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const decision = body?.decision as ReidResolveDecision | undefined;
    if (!decision || !VALID_DECISIONS.includes(decision)) {
      return c.json({ error: `decision must be one of ${VALID_DECISIONS.join("|")}` }, 400);
    }
    try {
      await deps.resolve(id, decision, "system");
      return new Response(null, { status: 204 });
    } catch (err) {
      // Race: outro operador resolveu primeiro, ou attempt já mudou de estado.
      return c.json({ error: err instanceof Error ? err.message : "conflict" }, 409);
    }
  });

  return r;
}
