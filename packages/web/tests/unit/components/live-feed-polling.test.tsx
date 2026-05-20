import { describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { LiveDetectionEvent } from "@vipcam/shared";
import type * as React from "react";

// Mock api-client BEFORE importing LiveFeed (componente novo não importa
// mais getClientEnv — apiFetch internaliza isso).
mock.module("../../../src/lib/api-client", () => ({
  apiFetch: async () => [] as LiveDetectionEvent[],
  snapshotUrl: () => null,
  ApiError: class extends Error {},
}));

// Mock the hook so we control state deterministically.
const hookState: {
  data: LiveDetectionEvent[];
  isFetching: boolean;
  isError: boolean;
  status: "pending" | "success" | "error";
  lastEnabled?: boolean;
} = { data: [], isFetching: false, isError: false, status: "success" };

mock.module("../../../src/lib/queries/events", () => ({
  useRecentDetections: (opts: { enabled?: boolean } = {}) => {
    hookState.lastEnabled = opts.enabled ?? true;
    return hookState;
  },
}));

// Import AFTER the mocks.
import { LiveFeed } from "../../../src/components/live-feed";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("LiveFeed (polling)", () => {
  test("renders empty state when data is []", () => {
    hookState.data = [];
    hookState.isFetching = false;
    hookState.isError = false;
    hookState.status = "success";
    render(wrap(<LiveFeed />));
    expect(screen.getByText(/aguardando/i)).toBeDefined();
  });

  test("renders detection cards from hook data", () => {
    hookState.data = [
      {
        type: "detection",
        detection: {
          id: "d1",
          detected_at: "2026-05-20T15:00:00Z",
          snapshot_path: null,
          face_attrs: {},
          dominant_emotion: "happy",
          emotion_confidence: 0.9,
          session_id: null,
          camera_id: "c",
        },
        person: null,
      },
    ];
    render(wrap(<LiveFeed />));
    // Não asseguramos detalhes internos do DetectionCard; só o badge de contagem.
    expect(screen.getByText(/1 detec/i)).toBeDefined();
  });

  test("Pausar toggles hook.enabled", () => {
    hookState.data = [];
    hookState.lastEnabled = undefined;
    render(wrap(<LiveFeed />));
    // Initial render: enabled is true.
    expect(hookState.lastEnabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Pausar/i));
    expect(hookState.lastEnabled).toBe(false);
    fireEvent.click(screen.getByLabelText(/Pausar/i));
    expect(hookState.lastEnabled).toBe(true);
  });
});
