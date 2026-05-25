// Usa fireEvent direto (não user-event) — @testing-library/user-event não
// está nas deps; fireEvent é parte do @testing-library/react já instalado.
import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReidMatchPendingEnriched } from "@vipcam/shared";
import * as React from "react";

// Mock api-client pra evitar parseClientEnv (que exige NEXT_PUBLIC_*).
// Devolve URL stub quando há path, null quando não há — mesma semântica real.
mock.module("../../../src/lib/api-client", () => ({
  snapshotUrl: (path: string | null) => (path ? `http://stub/snapshots/${path}` : null),
  apiFetch: async () => ({}),
  ApiError: class extends Error {},
}));

import { ReidMatchCard } from "../../../src/components/reid-match-card";

const item: ReidMatchPendingEnriched = {
  id: "rma-1",
  distance: 0.45,
  decided_at: "2026-05-20T14:00:00Z",
  detection: {
    id: "d1",
    detected_at: "2026-05-20T14:00:00Z",
    snapshot_path: "2026-05-20/d1.jpg",
    camera_id: "c1",
  },
  candidate: {
    face_record_id: "fr1",
    person_id: "p1",
    snapshot_path: "2026-05-15/fr1.jpg",
    person_display_name: "João Cliente",
    person_type: "client",
  },
};

describe("ReidMatchCard", () => {
  test("renders both snapshots + distance + candidate name", () => {
    render(<ReidMatchCard item={item} onResolve={() => {}} loading={false} />);
    expect(screen.getByText("João Cliente")).toBeDefined();
    expect(screen.getByText(/0\.45/)).toBeDefined();
    const images = screen.getAllByRole("img");
    expect(images.length).toBe(2);
  });

  test("renders fallback 'sem snapshot' divs when snapshot_path is null", () => {
    const noSnap: ReidMatchPendingEnriched = {
      ...item,
      detection: { ...item.detection, snapshot_path: null },
    };
    render(<ReidMatchCard item={noSnap} onResolve={() => {}} loading={false} />);
    const semSnaps = screen.getAllByText(/sem snapshot/i);
    expect(semSnaps.length).toBeGreaterThanOrEqual(1);
  });

  test("disabled buttons when loading=true", () => {
    render(<ReidMatchCard item={item} onResolve={() => {}} loading={true} />);
    const buttons = screen.getAllByRole("button");
    for (const b of buttons) expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  test("fires onResolve with 'matched_to_candidate' when 'Mesma pessoa' clicked", () => {
    let received: { id: string; decision: string } | null = null;
    render(
      <ReidMatchCard
        item={item}
        onResolve={(p) => {
          received = p;
        }}
        loading={false}
      />,
    );
    fireEvent.click(screen.getByText(/mesma pessoa/i));
    expect(received).toEqual({ id: "rma-1", decision: "matched_to_candidate" });
  });

  test("fires onResolve with 'rejected_new_person' when 'Pessoas diferentes' clicked", () => {
    let received: { id: string; decision: string } | null = null;
    render(
      <ReidMatchCard
        item={item}
        onResolve={(p) => {
          received = p;
        }}
        loading={false}
      />,
    );
    fireEvent.click(screen.getByText(/pessoas diferentes/i));
    expect(received).toEqual({ id: "rma-1", decision: "rejected_new_person" });
  });
});
