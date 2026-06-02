import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { pollCheckins } from "../../../src/erp-sync/checkins.js";
import * as queries from "../../../src/erp-sync/queries.js";
import { closeDb } from "../../../src/persistence/db.js";
import { erpRepo } from "../../../src/persistence/repositories/index.js";
import { truncateAll } from "../persistence/_helpers.js";

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await closeDb();
});

const NOW = new Date("2026-05-31T14:00:00Z");
const clock = () => NOW;

function stubFetch(rows: unknown[], capture?: (since: Date) => void) {
  mock.module("../../../src/erp-sync/queries.js", () => ({
    ...queries,
    fetchErpCheckinsSince: async (since: Date) => {
      capture?.(since);
      return rows as never;
    },
  }));
}

describe("pollCheckins (janela deslizante)", () => {
  test("passa since = now − lookback (default 24h) pro fetch", async () => {
    let seen: Date | undefined;
    stubFetch([], (s) => {
      seen = s;
    });
    await pollCheckins({ now: clock });
    expect(seen?.toISOString()).toBe("2026-05-30T14:00:00.000Z");
  });

  test("insere todos os rows novos; metadata parseado", async () => {
    stubFetch([
      {
        id: 10,
        client_id: 100,
        event_type: "appointment_confirmed",
        occurred_at: new Date("2026-05-31T13:30:00Z"),
        metadata: '{"service":"cut"}',
      },
      {
        id: 11,
        client_id: 100,
        event_type: "appointment_confirmed",
        occurred_at: new Date("2026-05-31T13:45:00Z"),
        metadata: null,
      },
    ]);
    const r = await pollCheckins({ now: clock });
    expect(r.fetched).toBe(2);
    expect(r.new_).toBe(2);
    const c = await erpRepo.findCheckinByErpId("10");
    expect(c?.event_type).toBe("appointment_confirmed");
    expect(c?.metadata).toEqual({ service: "cut" });
  });

  test("re-poll dos mesmos rows: dedup por erp_id → new_=0 (idempotência sem cursor)", async () => {
    stubFetch([
      {
        id: 10,
        client_id: 100,
        event_type: "x",
        occurred_at: new Date("2026-05-31T13:30:00Z"),
        metadata: null,
      },
    ]);
    await pollCheckins({ now: clock });
    const r = await pollCheckins({ now: clock });
    expect(r.fetched).toBe(1);
    expect(r.new_).toBe(0);
  });

  test("metadata malformado vira {} sem crashar", async () => {
    stubFetch([
      {
        id: 50,
        client_id: 1,
        event_type: "x",
        occurred_at: new Date("2026-05-31T13:30:00Z"),
        metadata: "not-json{",
      },
    ]);
    const r = await pollCheckins({ now: clock });
    expect(r.new_).toBe(1);
    expect((await erpRepo.findCheckinByErpId("50"))?.metadata).toEqual({});
  });

  test("row com client_id null é pulado (defensivo) e não derruba o batch", async () => {
    stubFetch([
      {
        id: 60,
        client_id: null,
        event_type: "x",
        occurred_at: new Date("2026-05-31T13:30:00Z"),
        metadata: null,
      },
      {
        id: 61,
        client_id: 5,
        event_type: "x",
        occurred_at: new Date("2026-05-31T13:31:00Z"),
        metadata: null,
      },
    ]);
    const r = await pollCheckins({ now: clock });
    expect(r.fetched).toBe(2);
    expect(r.new_).toBe(1); // só o 61 entra
    expect(await erpRepo.findCheckinByErpId("60")).toBeNull();
    expect(await erpRepo.findCheckinByErpId("61")).not.toBeNull();
  });
});
