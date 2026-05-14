import { describe, expect, test } from "bun:test";
import type { DashboardSummary } from "@vipcam/shared";
import { Hono } from "hono";
import { createDashboardRoutes } from "../../../../src/api/routes/dashboard.js";

const stubSummary: DashboardSummary = {
  pending_matches: 2,
  last_detection_at: "2026-05-14T13:00:00Z",
  detections_today: 47,
  persons_total: { client: 30, employee: 369 },
};

describe("GET /api/dashboard/summary", () => {
  test("retorna DashboardSummary do deps", async () => {
    let called = 0;
    const app = new Hono();
    app.route(
      "/api/dashboard",
      createDashboardRoutes({
        summary: async () => {
          called += 1;
          return stubSummary;
        },
      }),
    );
    const res = await app.request("/api/dashboard/summary");
    expect(res.status).toBe(200);
    expect(called).toBe(1);
    const body = (await res.json()) as DashboardSummary;
    expect(body).toEqual(stubSummary);
  });
});
