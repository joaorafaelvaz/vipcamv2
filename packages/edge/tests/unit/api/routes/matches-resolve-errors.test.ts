import { describe, expect, test } from "bun:test";
import { createMatchRoutes } from "../../../../src/api/routes/matches.js";
import { ResolveError } from "../../../../src/match-temp/review.js";

function app(resolve: (...args: any[]) => Promise<void>) {
  return createMatchRoutes({
    listPending: async () => [],
    resolve,
    reject: async () => undefined,
  });
}

// IMPORTANTE: route schema é snake_case (verificado em matches.ts:26-29 —
// `chosen_detection_id` / `chosen_person_id`). Body camelCase seria 400 por
// schema validation, NÃO 409/410 — mascararia o bug que queremos testar.
const validBody = JSON.stringify({
  chosen_detection_id: "11111111-1111-1111-1111-111111111111",
  chosen_person_id: "22222222-2222-2222-2222-222222222222",
});

describe("POST /api/matches/:id/resolve error mapping (Onda 9-A)", () => {
  test("concurrent_merge → 409", async () => {
    const r = await app(async () => {
      throw new ResolveError("concurrent_merge", "race");
    }).request("/rma-1/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: validBody,
    });
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.error).toBe("concurrent_merge");
  });

  test("previous_person_gone → 410", async () => {
    const r = await app(async () => {
      throw new ResolveError("previous_person_gone", "W gone");
    }).request("/rma-1/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: validBody,
    });
    expect(r.status).toBe(410);
    expect((await r.json()).error).toBe("previous_person_gone");
  });

  test("not_found → 404 (regressão existente)", async () => {
    const r = await app(async () => {
      throw new ResolveError("not_found", "");
    }).request("/rma-1/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: validBody,
    });
    expect(r.status).toBe(404);
  });
});
