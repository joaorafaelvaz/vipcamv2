import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import type { LiveDetectionEvent } from "@vipcam/shared";

// Mock apiFetch BEFORE importing the hook.
let fetchCalls = 0;
let returnRows: LiveDetectionEvent[] = [];
mock.module("../../../src/lib/api-client", () => ({
  apiFetch: async () => {
    fetchCalls += 1;
    return returnRows;
  },
  snapshotUrl: () => null,
  ApiError: class extends Error {},
}));

// Import AFTER the mock.
import { useRecentDetections } from "../../../src/lib/queries/events";

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function Probe({ enabled, intervalMs }: { enabled: boolean; intervalMs: number }) {
  const q = useRecentDetections({ limit: 10, intervalMs, enabled });
  return <div data-testid="count">{q.data?.length ?? 0}</div>;
}

beforeEach(() => {
  fetchCalls = 0;
  returnRows = [];
});
afterEach(() => {
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

describe("useRecentDetections", () => {
  test("initial fetch + renders array length", async () => {
    returnRows = [
      { type: "detection", detection: { id: "a", detected_at: "t", snapshot_path: null,
        face_attrs: {}, dominant_emotion: null, emotion_confidence: null,
        session_id: null, camera_id: "c" }, person: null },
    ];
    const qc = makeClient();
    render(
      <QueryClientProvider client={qc}>
        <Probe enabled={true} intervalMs={1000} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("1"));
    expect(fetchCalls).toBe(1);
  });

  test("polls at intervalMs when enabled", async () => {
    returnRows = [];
    const qc = makeClient();
    render(
      <QueryClientProvider client={qc}>
        <Probe enabled={true} intervalMs={50} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(fetchCalls).toBeGreaterThanOrEqual(1));
    const a = fetchCalls;
    await new Promise((r) => setTimeout(r, 130));
    expect(fetchCalls).toBeGreaterThan(a);
  });

  test("does not poll when enabled=false", async () => {
    returnRows = [];
    const qc = makeClient();
    render(
      <QueryClientProvider client={qc}>
        <Probe enabled={false} intervalMs={50} />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 120));
    expect(fetchCalls).toBe(0);
  });
});
