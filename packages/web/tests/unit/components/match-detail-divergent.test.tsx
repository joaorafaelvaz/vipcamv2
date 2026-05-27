import { describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import type { MatchPendingEnriched } from "@vipcam/shared";
import * as React from "react";

let resolveCalls = 0;
let rejectCalls = 0;

const installMocks = () => {
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
    snapshotUrl: (p: string | null) => (p ? `/snapshots/${p}` : null),
    ApiError: class extends Error {},
  }));
};
installMocks();

const baseMatch: MatchPendingEnriched = {
  match_attempt_id: "11111111-1111-1111-1111-111111111111",
  decided_at: "2026-05-26T14:00:00Z",
  notes: null,
  checkin: {
    erp_id: "chk-1",
    client_name: "Maria",
    client_phone: "11999",
    erp_client_id: "cli-y",
    person_id: "22222222-2222-2222-2222-222222222222",
    occurred_at: "2026-05-26T14:00:00Z",
    event_type: "appointment_confirmed",
  },
  candidates: [
    {
      id: "33333333-3333-3333-3333-333333333333",
      detected_at: "2026-05-26T14:00:30Z",
      snapshot_path: null,
      face_attrs: { age: 32, gender: "Female" },
      dominant_emotion: "happy",
      emotion_confidence: 0.8,
      session_id: "ss1",
      camera_id: "cam-1",
    },
  ],
};

describe("MatchDetail divergent (Onda 9-A)", () => {
  test("clássico (sem previous_person) → não renderiza warning block", async () => {
    installMocks();
    const { MatchDetail } = await import("../../../src/components/match-detail");
    render(<MatchDetail match={baseMatch} />);
    expect(screen.queryByText(/já está ligada/i)).toBeNull();
  });

  test("divergente com W nomeado → warning block visível com nome", async () => {
    installMocks();
    const { MatchDetail } = await import("../../../src/components/match-detail");
    const m: MatchPendingEnriched = {
      ...baseMatch,
      previous_person: {
        id: "p-W",
        display_name: "Wagner",
        person_type: "client",
        thumbnail_path: "2026-05-20/wagner.jpg",
      },
    };
    render(<MatchDetail match={m} />);
    expect(screen.getByText(/já está ligada/i)).toBeTruthy();
    // "Wagner" aparece em 3 lugares: warning span + per-candidate button + reject button
    // (botões usam labels adaptativos quando isDivergent). Validar que warning block
    // contém a span font-bold com Wagner.
    const wagnerNodes = screen.getAllByText(/Wagner/);
    expect(wagnerNodes.length).toBeGreaterThan(0);
    expect(wagnerNodes.some((n) => n.className.includes("font-bold"))).toBe(true);
  });

  test("W com display_name=null → fallback 'Anônima <prefix>'", async () => {
    installMocks();
    const { MatchDetail } = await import("../../../src/components/match-detail");
    const m: MatchPendingEnriched = {
      ...baseMatch,
      previous_person: {
        id: "p-anon-1234abcd",
        display_name: null,
        person_type: "anonymous",
        thumbnail_path: null,
      },
    };
    render(<MatchDetail match={m} />);
    // "Anônima p-anon-1..." aparece em múltiplos lugares: warning span + botões
    // adaptativos (merge X → Y / manter X). Validar pelo menos 1 match.
    const fallbackNodes = screen.getAllByText(/Anônima p-anon-1/i);
    expect(fallbackNodes.length).toBeGreaterThan(0);
  });

  test("W sem thumbnail → sem img com alt 'previous'", async () => {
    installMocks();
    const { MatchDetail } = await import("../../../src/components/match-detail");
    const m: MatchPendingEnriched = {
      ...baseMatch,
      previous_person: {
        id: "p-W",
        display_name: "W",
        person_type: "anonymous",
        thumbnail_path: null,
      },
    };
    render(<MatchDetail match={m} />);
    const imgs = screen.queryAllByRole("img");
    const wImg = imgs.find((i) => i.getAttribute("alt")?.toLowerCase().includes("previous"));
    expect(wImg).toBeUndefined();
  });

  test("isStaleSame (W.id === checkin.person_id) → buttons hidden + italic caption visible", async () => {
    installMocks();
    const { MatchDetail } = await import("../../../src/components/match-detail");
    const m: MatchPendingEnriched = {
      ...baseMatch,
      previous_person: {
        id: baseMatch.checkin.person_id!,  // same as Y
        display_name: "Maria",
        person_type: "client",
        thumbnail_path: null,
      },
    };
    render(<MatchDetail match={m} />);
    // Buttons hidden
    expect(screen.queryByText(/é essa pessoa/i)).toBeNull();
    expect(screen.queryByText(/rejeitar/i)).toBeNull();
    expect(screen.queryByText(/merge/i)).toBeNull();
    // Caption visible
    expect(screen.getByText(/aguardando dedup automática/i)).toBeTruthy();
  });
});
