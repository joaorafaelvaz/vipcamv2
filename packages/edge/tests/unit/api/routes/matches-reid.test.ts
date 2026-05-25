import { describe, expect, test } from "bun:test";
import type { ReidMatchPendingEnriched } from "@vipcam/shared";
import { createMatchesReidRoutes } from "../../../../src/api/routes/matches-reid.js";

const fakeItem: ReidMatchPendingEnriched = {
  id: "rma-1",
  distance: 0.45,
  decided_at: "2026-05-20T14:00:00Z",
  detection: {
    id: "det-1",
    detected_at: "2026-05-20T14:00:00Z",
    snapshot_path: "2026-05-20/det-1.jpg",
    camera_id: "cam-1",
  },
  candidate: {
    face_record_id: "fr-1",
    person_id: "p-1",
    snapshot_path: "2026-05-15/cand.jpg",
    person_display_name: "João",
    person_type: "client",
  },
};

function app(deps: {
  findPending: (limit: number) => Promise<ReidMatchPendingEnriched[]>;
  resolve: (id: string, decision: string, userId: string) => Promise<void>;
}) {
  return createMatchesReidRoutes(deps);
}

describe("GET /pending", () => {
  test("default limit=50", async () => {
    let received: number | undefined;
    const r = await app({
      findPending: async (l) => {
        received = l;
        return [fakeItem];
      },
      resolve: async () => undefined,
    }).request("/pending");
    expect(r.status).toBe(200);
    expect(received).toBe(50);
    expect(await r.json()).toEqual([fakeItem]);
  });

  test("limit=200 boundary OK", async () => {
    const r = await app({
      findPending: async () => [],
      resolve: async () => undefined,
    }).request("/pending?limit=200");
    expect(r.status).toBe(200);
  });

  test("invalid limit → 400", async () => {
    for (const bad of ["0", "201", "-1", "abc", "1.5"]) {
      const r = await app({
        findPending: async () => [],
        resolve: async () => undefined,
      }).request(`/pending?limit=${bad}`);
      expect(r.status).toBe(400);
    }
  });
});

describe("POST /:id/resolve", () => {
  test("matched_to_candidate → 204", async () => {
    const calls: Array<[string, string, string]> = [];
    const r = await app({
      findPending: async () => [],
      resolve: async (id, decision, user) => {
        calls.push([id, decision, user]);
      },
    }).request("/rma-1/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "matched_to_candidate" }),
    });
    expect(r.status).toBe(204);
    expect(calls).toEqual([["rma-1", "matched_to_candidate", "system"]]);
  });

  test("rejected_new_person → 204", async () => {
    let received: string | undefined;
    const r = await app({
      findPending: async () => [],
      resolve: async (_id, decision) => {
        received = decision;
      },
    }).request("/rma-2/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "rejected_new_person" }),
    });
    expect(r.status).toBe(204);
    expect(received).toBe("rejected_new_person");
  });

  test("decision inválida → 400", async () => {
    const r = await app({
      findPending: async () => [],
      resolve: async () => undefined,
    }).request("/rma-1/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "something_else" }),
    });
    expect(r.status).toBe(400);
  });

  test("resolve throws → 409 Conflict (race condition: já resolvido)", async () => {
    const r = await app({
      findPending: async () => [],
      resolve: async () => {
        throw new Error("not found or not ambiguous");
      },
    }).request("/rma-1/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "matched_to_candidate" }),
    });
    expect(r.status).toBe(409);
  });
});
