import { describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import type { SessionWithDetections } from "@vipcam/shared";
import * as React from "react";

mock.module("../../../src/lib/api-client", () => ({
  snapshotUrl: () => null,
  apiFetch: async () => ({}),
  ApiError: class extends Error {},
}));

const sampleSession: SessionWithDetections = {
  id: "11111111-1111-1111-1111-111111111111",
  started_at: "2026-05-14T13:00:00Z",
  ended_at: "2026-05-14T13:42:00Z",
  detection_count: 18,
  dominant_emotion: "happy",
  linked_erp_checkin_id: "chk-1",
  detections: [
    {
      id: "22222222-2222-2222-2222-222222222222",
      detected_at: "2026-05-14T13:00:30Z",
      snapshot_path: "/var/lib/vipcam/snapshots/abc.jpg",
      face_attrs: { age: 30 },
      dominant_emotion: "happy",
      emotion_confidence: 0.85,
      session_id: "11111111-1111-1111-1111-111111111111",
      camera_id: "33333333-3333-3333-3333-333333333333",
    },
  ],
};

describe("<VisitCard>", () => {
  test("mostra duração calculada (start → end)", async () => {
    const { VisitCard } = await import("../../../src/components/visit-card");
    render(<VisitCard session={sampleSession} />);
    expect(screen.getByText(/42 min/)).toBeTruthy();
  });

  test("mostra detection_count + dominant_emotion", async () => {
    const { VisitCard } = await import("../../../src/components/visit-card");
    render(<VisitCard session={sampleSession} />);
    expect(screen.getByText(/18 detec/)).toBeTruthy();
    expect(screen.getByText(/happy/i)).toBeTruthy();
  });

  test("session sem ended_at mostra 'em andamento'", async () => {
    const { VisitCard } = await import("../../../src/components/visit-card");
    render(<VisitCard session={{ ...sampleSession, ended_at: null }} />);
    expect(screen.getByText(/em andamento/i)).toBeTruthy();
  });
});
