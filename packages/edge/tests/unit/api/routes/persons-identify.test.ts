import { describe, expect, test } from "bun:test";
import { type PersonsDeps, createPersonsRoutes } from "../../../../src/api/routes/persons.js";

const ANON = "11111111-1111-1111-1111-111111111111";
const EMP = "22222222-2222-2222-2222-222222222222";

function makeDeps(over?: Partial<PersonsDeps>): PersonsDeps {
  return {
    list: async () => ({ items: [], total: 0 }),
    getById: async () => null,
    listSessions: async () => [],
    listIdentifyQueue: async () => [
      { person_id: ANON, detection_count: 5, last_seen_at: new Date("2026-06-03T12:00:00Z"), snapshots: ["a.jpg"] },
    ],
    findPersonType: async (id) => (id === ANON ? "anonymous" : id === EMP ? "employee" : null),
    mergeIntoEmployee: async () => undefined,
    dismissIdentify: async () => undefined,
    ...over,
  };
}

function req(
  app: ReturnType<typeof createPersonsRoutes>,
  method: string,
  path: string,
  body?: unknown,
) {
  return app.request(path, {
    method,
    ...(body
      ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
      : {}),
  });
}

describe("identify routes (Onda 10)", () => {
  test("GET /identify/queue → itens com last_seen_at ISO", async () => {
    const app = createPersonsRoutes(makeDeps());
    const r = await req(app, "GET", "/identify/queue");
    expect(r.status).toBe(200);
    const j = (await r.json()) as { items: Array<Record<string, unknown>> };
    expect(j.items[0]?.person_id).toBe(ANON);
    expect(j.items[0]?.detection_count).toBe(5);
    expect(j.items[0]?.last_seen_at).toBe("2026-06-03T12:00:00.000Z");
    expect(j.items[0]?.snapshots).toEqual(["a.jpg"]);
  });

  test("POST /:id/identify happy → 200 + mergeIntoEmployee(anon, emp)", async () => {
    const calls: Array<[string, string]> = [];
    const app = createPersonsRoutes(
      makeDeps({
        mergeIntoEmployee: async (a, e) => {
          calls.push([a, e]);
        },
      }),
    );
    const r = await req(app, "POST", `/${ANON}/identify`, { employee_person_id: EMP });
    expect(r.status).toBe(200);
    expect(calls).toEqual([[ANON, EMP]]);
  });

  test("POST identify: :id não-anônimo → 400 not_anonymous", async () => {
    const app = createPersonsRoutes(makeDeps());
    const r = await req(app, "POST", `/${EMP}/identify`, { employee_person_id: EMP });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("not_anonymous");
  });

  test("POST identify: alvo não-employee → 400 not_employee", async () => {
    const app = createPersonsRoutes(makeDeps());
    const r = await req(app, "POST", `/${ANON}/identify`, { employee_person_id: ANON });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("not_employee");
  });

  test("POST identify: :id inexistente → 404", async () => {
    const app = createPersonsRoutes(makeDeps());
    const r = await req(app, "POST", "/33333333-3333-3333-3333-333333333333/identify", {
      employee_person_id: EMP,
    });
    expect(r.status).toBe(404);
  });

  test("POST identify: merge lança 'not found' → 409 concurrent_merge", async () => {
    const app = createPersonsRoutes(
      makeDeps({
        mergeIntoEmployee: async () => {
          throw new Error("mergeInto: person not found (x or y)");
        },
      }),
    );
    const r = await req(app, "POST", `/${ANON}/identify`, { employee_person_id: EMP });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe("concurrent_merge");
  });

  test("POST identify: body inválido → 400 invalid_body", async () => {
    const app = createPersonsRoutes(makeDeps());
    const r = await req(app, "POST", `/${ANON}/identify`, { nope: 1 });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("invalid_body");
  });

  test("POST /:id/identify/dismiss → 200 e valida anônimo", async () => {
    const dismissed: string[] = [];
    const app = createPersonsRoutes(
      makeDeps({
        dismissIdentify: async (id) => {
          dismissed.push(id);
        },
      }),
    );
    const r = await req(app, "POST", `/${ANON}/identify/dismiss`);
    expect(r.status).toBe(200);
    expect(dismissed).toEqual([ANON]);

    const r2 = await req(app, "POST", `/${EMP}/identify/dismiss`);
    expect(r2.status).toBe(400);
    const r3 = await req(app, "POST", "/33333333-3333-3333-3333-333333333333/identify/dismiss");
    expect(r3.status).toBe(404);
  });
});
