import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { MatchPendingEnriched } from "@vipcam/shared";
import * as React from "react";

let resolveCalls = 0;
let rejectCalls = 0;

mock.module("../../../src/lib/queries/matches", () => ({
  useResolveMatch: () => ({
    mutate: () => {
      resolveCalls += 1;
    },
    isPending: false,
  }),
  useRejectMatch: () => ({
    mutate: () => {
      rejectCalls += 1;
    },
    isPending: false,
  }),
}));
mock.module("../../../src/lib/api-client", () => ({
  apiFetch: async () => ({}),
  snapshotUrl: () => null,
  ApiError: class extends Error {},
}));

const sample: MatchPendingEnriched = {
  match_attempt_id: "11111111-1111-1111-1111-111111111111",
  decided_at: "2026-05-14T13:00:00Z",
  notes: "3 candidates",
  checkin: {
    erp_id: "chk-1",
    client_name: "Ana Costa",
    client_phone: "11999",
    erp_client_id: "100",
    person_id: "99999999-9999-9999-9999-999999999999",
    occurred_at: "2026-05-14T12:58:00Z",
    event_type: "appointment_confirmed",
  },
  candidates: [
    {
      id: "22222222-2222-2222-2222-222222222222",
      detected_at: "2026-05-14T12:57:30Z",
      snapshot_path: null,
      face_attrs: { age: 32, gender: "Female" },
      dominant_emotion: "happy",
      emotion_confidence: 0.8,
      session_id: "ss1",
      camera_id: "cam-1",
    },
  ],
};

describe("<MatchDetail>", () => {
  test("renderiza checkin info + candidates + notes", async () => {
    const { MatchDetail } = await import("../../../src/components/match-detail");
    render(<MatchDetail match={sample} />);
    expect(screen.getByText("Ana Costa")).toBeTruthy();
    expect(screen.getByText(/11999/)).toBeTruthy();
    expect(screen.getByText(/3 candidates/i)).toBeTruthy();
  });

  test("clique 'É essa pessoa' chama useResolveMatch", async () => {
    resolveCalls = 0;
    const { MatchDetail } = await import("../../../src/components/match-detail");
    render(<MatchDetail match={sample} />);
    const btn = screen.getAllByText(/é essa pessoa/i)[0];
    if (!btn) throw new Error("button not found");
    fireEvent.click(btn);
    expect(resolveCalls).toBe(1);
  });

  test("clique 'Rejeitar' chama useRejectMatch", async () => {
    rejectCalls = 0;
    const { MatchDetail } = await import("../../../src/components/match-detail");
    render(<MatchDetail match={sample} />);
    fireEvent.click(screen.getByText(/rejeitar/i));
    expect(rejectCalls).toBe(1);
  });
});
