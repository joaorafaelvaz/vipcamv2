import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import type { MetricsOverview } from "@vipcam/shared";
import * as React from "react";
import { MetricKpis } from "../../../src/components/metrics/metric-kpis";

const data: MetricsOverview = {
  days: 7,
  visits: {
    points: [
      { date: "2026-05-10", count: 10 },
      { date: "2026-05-11", count: 20 },
    ],
    trend: { slope: 1, direction: "up" },
  },
  peak: { cells: [] },
  recurrence: { new_count: 3, returning_count: 7, identified_visits: 10, total_visits: 30 },
  sentiment: {
    buckets: [
      { emotion: "happy", count: 12 },
      { emotion: "n/d", count: 1 },
    ],
  },
};

describe("MetricKpis", () => {
  test("mostra total de visitas e % recorrentes", () => {
    render(<MetricKpis data={data} />);
    expect(screen.getByText("30")).toBeDefined();
    expect(screen.getByText(/70%/)).toBeDefined();
  });
});
