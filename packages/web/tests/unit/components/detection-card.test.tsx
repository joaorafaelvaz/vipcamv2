import { describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import type { LiveDetectionEvent } from "@vipcam/shared";
import * as React from "react";

mock.module("../../../src/lib/api-client", () => ({
  snapshotUrl: () => null,
  apiFetch: async () => ({}),
  ApiError: class extends Error {},
}));

const event: LiveDetectionEvent = {
  type: "detection",
  detection: {
    id: "11111111-1111-1111-1111-111111111111",
    detected_at: new Date().toISOString(),
    snapshot_path: null,
    face_attrs: { age: 30, gender: "Female" },
    dominant_emotion: "happy",
    emotion_confidence: 0.85,
    session_id: null,
    camera_id: "22222222-2222-2222-2222-222222222222",
  },
  person: {
    id: "33333333-3333-3333-3333-333333333333",
    display_name: "Ana",
    person_type: "client",
    photo_path: null,
    last_seen_at: null,
    total_visits: 1,
    erp_client_id: "100",
    erp_employee_id: null,
    phone: null,
  },
};

describe("<DetectionCard>", () => {
  test("mostra nome da person + emoção", async () => {
    const { DetectionCard } = await import("../../../src/components/detection-card");
    render(<DetectionCard event={event} />);
    expect(screen.getByText("Ana")).toBeTruthy();
    expect(screen.getByText(/happy/)).toBeTruthy();
  });

  test("anônimo quando person é null", async () => {
    const { DetectionCard } = await import("../../../src/components/detection-card");
    render(<DetectionCard event={{ ...event, person: null }} />);
    expect(screen.getByText("Anônimo")).toBeTruthy();
  });
});
