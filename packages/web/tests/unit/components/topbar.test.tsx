import { describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type * as React from "react";

// Mock ANTES do import dinâmico do Topbar
mock.module("../../../src/lib/api-client", () => ({
  apiFetch: async () => ({
    pending_matches: 3,
    last_detection_at: "2026-05-14T13:00:00Z",
    detections_today: 47,
    persons_total: { client: 30, employee: 369 },
  }),
  ApiError: class extends Error {
    status = 0;
    code = "";
  },
  snapshotUrl: () => null,
}));

mock.module("next/navigation", () => ({
  usePathname: () => "/live",
}));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("Topbar", () => {
  test("renderiza tabs e badge de matches", async () => {
    const { Topbar } = await import("../../../src/components/topbar");
    render(wrap(<Topbar />));
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByText("Pessoas")).toBeTruthy();
    expect(screen.getByText("Matches")).toBeTruthy();
    const badge = await screen.findByText("3");
    expect(badge).toBeTruthy();
  });
});
