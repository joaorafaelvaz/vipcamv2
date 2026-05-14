import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { type MatchDeps, createMatchRoutes } from "../../../../src/api/routes/matches.js";
import { ResolveError } from "../../../../src/match-temp/review.js";
import type { MatchAttempt } from "../../../../src/persistence/schema/match-attempts.js";

function mountWith(deps: MatchDeps): Hono {
  const app = new Hono();
  app.route("/api/matches", createMatchRoutes(deps));
  // Mimica server.ts: onError global pra errors não-tipados → 500
  // (sem isso, Hono leaks o stack do throw).
  app.onError((_err, c) => c.json({ error: "internal_error" }, 500));
  return app;
}

const stubAttempt: MatchAttempt = {
  id: "11111111-1111-1111-1111-111111111111",
  detection_id: null,
  erp_checkin_id: "erp-1",
  confidence_score: null,
  decision: "ambiguous",
  decided_at: new Date("2026-05-12T12:00:00Z"),
  decided_by: "system",
  notes: "3 candidates",
};

function deps(overrides: Partial<MatchDeps> = {}): MatchDeps {
  return {
    listPending: async () => [stubAttempt],
    resolve: async () => {},
    reject: async () => {},
    ...overrides,
  };
}

describe("GET /api/matches/pending", () => {
  test("usa limit default=50 quando query string não informa", async () => {
    let receivedLimit: number | undefined;
    const app = mountWith(
      deps({
        listPending: async (limit) => {
          receivedLimit = limit;
          return [stubAttempt];
        },
      }),
    );
    const res = await app.request("/api/matches/pending");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: MatchAttempt[] };
    expect(receivedLimit).toBe(50);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.id).toBe(stubAttempt.id);
  });

  test("respeita ?limit= explícito", async () => {
    let receivedLimit: number | undefined;
    const app = mountWith(
      deps({
        listPending: async (limit) => {
          receivedLimit = limit;
          return [];
        },
      }),
    );
    const res = await app.request("/api/matches/pending?limit=10");
    expect(res.status).toBe(200);
    expect(receivedLimit).toBe(10);
  });
});

describe("POST /api/matches/:id/resolve", () => {
  const validId = "22222222-2222-2222-2222-222222222222";
  const validBody = {
    chosen_detection_id: "33333333-3333-3333-3333-333333333333",
    chosen_person_id: "44444444-4444-4444-4444-444444444444",
  };

  test("invoca deps.resolve com id, detection e person quando body válido", async () => {
    let calledWith: { id: string; det: string; person: string } | undefined;
    const app = mountWith(
      deps({
        resolve: async (id, det, person) => {
          calledWith = { id, det, person };
        },
      }),
    );
    const res = await app.request(`/api/matches/${validId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(calledWith).toEqual({
      id: validId,
      det: validBody.chosen_detection_id,
      person: validBody.chosen_person_id,
    });
  });

  test("rejeita body sem chosen_person_id (zod 400)", async () => {
    let resolveCalled = false;
    const app = mountWith(
      deps({
        resolve: async () => {
          resolveCalled = true;
        },
      }),
    );
    const res = await app.request(`/api/matches/${validId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chosen_detection_id: validBody.chosen_detection_id }),
    });
    expect(res.status).toBe(400);
    expect(resolveCalled).toBe(false);
  });

  test("rejeita body com uuid inválido", async () => {
    const app = mountWith(deps());
    const res = await app.request(`/api/matches/${validId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chosen_detection_id: "not-a-uuid",
        chosen_person_id: validBody.chosen_person_id,
      }),
    });
    expect(res.status).toBe(400);
  });

  // C2: ResolveError → HTTP code mapping
  test("ResolveError(not_found) → 404", async () => {
    const app = mountWith(
      deps({
        resolve: async () => {
          throw new ResolveError("not_found", "match_attempt does not exist");
        },
      }),
    );
    const res = await app.request(`/api/matches/${validId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("ResolveError(already_resolved) → 409", async () => {
    const app = mountWith(
      deps({
        resolve: async () => {
          throw new ResolveError("already_resolved", "match already auto_matched");
        },
      }),
    );
    const res = await app.request(`/api/matches/${validId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(409);
  });

  test("ResolveError(detection_outside_window) → 400", async () => {
    const app = mountWith(
      deps({
        resolve: async () => {
          throw new ResolveError(
            "detection_outside_window",
            "detection is not within match window",
          );
        },
      }),
    );
    const res = await app.request(`/api/matches/${validId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("detection_outside_window");
  });

  test("ResolveError(person_client_mismatch) → 400", async () => {
    const app = mountWith(
      deps({
        resolve: async () => {
          throw new ResolveError(
            "person_client_mismatch",
            "person.erp_client_id != checkin.erp_client_id",
          );
        },
      }),
    );
    const res = await app.request(`/api/matches/${validId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(400);
  });

  test("Error genérico não-tipado → 500 (não vaza interno)", async () => {
    const app = mountWith(
      deps({
        resolve: async () => {
          throw new Error("ECONNREFUSED postgres");
        },
      }),
    );
    const res = await app.request(`/api/matches/${validId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("internal_error");
    // Mensagem específica NÃO deve vazar pro client
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });
});

describe("POST /api/matches/:id/reject", () => {
  const validId = "55555555-5555-5555-5555-555555555555";

  test("aceita body vazio (reason opcional) e chama deps.reject", async () => {
    let calledWith: { id: string; reason: string | undefined } | undefined;
    const app = mountWith(
      deps({
        reject: async (id, reason) => {
          calledWith = { id, reason };
        },
      }),
    );
    const res = await app.request(`/api/matches/${validId}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(calledWith).toEqual({ id: validId, reason: undefined });
  });

  test("repassa reason quando informado", async () => {
    let receivedReason: string | undefined;
    const app = mountWith(
      deps({
        reject: async (_id, reason) => {
          receivedReason = reason;
        },
      }),
    );
    const res = await app.request(`/api/matches/${validId}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "operator confirmed mismatch" }),
    });
    expect(res.status).toBe(200);
    expect(receivedReason).toBe("operator confirmed mismatch");
  });
});
