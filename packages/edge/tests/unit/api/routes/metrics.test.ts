import { describe, expect, test } from "bun:test";
import type { MetricsOverview } from "@vipcam/shared";
import { createMetricsRoutes } from "../../../../src/api/routes/metrics.js";

const fake: MetricsOverview = {
  days: 7,
  visits: { points: [], trend: { slope: 0, direction: "flat" } },
  peak: { cells: [] },
  recurrence: { new_count: 0, returning_count: 0, identified_visits: 0, total_visits: 0 },
  sentiment: { buckets: [] },
};

function app() {
  return createMetricsRoutes({
    overview: async (days) => ({ ...fake, days }),
  });
}

describe("createMetricsRoutes GET /overview", () => {
  test("default days=7", async () => {
    const res = await app().request("/overview");
    expect(res.status).toBe(200);
    expect((await res.json()).days).toBe(7);
  });
  test("days=30 honored", async () => {
    const res = await app().request("/overview?days=30");
    expect((await res.json()).days).toBe(30);
  });
  test("invalid days → 400", async () => {
    const res = await app().request("/overview?days=99");
    expect(res.status).toBe(400);
  });
});
