import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { IdentifyQueueItem } from "@vipcam/shared";
import * as React from "react";

const items: IdentifyQueueItem[] = [
  {
    person_id: "a1111111-1111-1111-1111-111111111111",
    detection_count: 36,
    last_seen_at: "2026-06-02T18:00:00Z",
    snapshots: ["2026-06-02/x1.jpg", "2026-06-02/x2.jpg"],
  },
  {
    person_id: "a2222222-2222-2222-2222-222222222222",
    detection_count: 12,
    last_seen_at: null,
    snapshots: [],
  },
];

let queueData: IdentifyQueueItem[] = items;
const dismissCalls: string[] = [];

mock.module("../../../src/lib/api-client", () => ({
  snapshotUrl: (p: string | null) => (p ? `http://test/snapshots/${p}` : null),
  apiFetch: async () => ({}),
  ApiError: class extends Error {},
}));
mock.module("../../../src/lib/queries/identify", () => ({
  useIdentifyQueue: () => ({ data: queueData, isLoading: false }),
  useDismissIdentify: () => ({
    mutate: (id: string) => dismissCalls.push(id),
    isPending: false,
  }),
  useIdentifyAsEmployee: () => ({ mutate: () => undefined, isPending: false }),
}));
mock.module("../../../src/lib/queries/persons", () => ({
  usePeople: () => ({ data: { items: [], total: 0 }, isLoading: false }),
}));

beforeEach(() => {
  queueData = items;
  dismissCalls.length = 0;
});

describe("<IdentifyQueue>", () => {
  test("renderiza itens: contagem de detecções, fotos e ações", async () => {
    const { IdentifyQueue } = await import("../../../src/components/identify-queue");
    render(<IdentifyQueue />);

    expect(screen.getByText(/36 detecções/i)).toBeTruthy();
    expect(screen.getByText(/12 detecções/i)).toBeTruthy();
    // fotos do 1º item via snapshotUrl (2 imgs)
    expect(screen.getAllByRole("img").length).toBe(2);
    // ação por item
    expect(screen.getAllByText(/é funcionário/i).length).toBe(2);
    expect(screen.getAllByText(/ignorar/i).length).toBe(2);
  });

  test("Ignorar dispara dismiss com o person_id", async () => {
    const { IdentifyQueue } = await import("../../../src/components/identify-queue");
    render(<IdentifyQueue />);
    const buttons = screen.getAllByText(/ignorar/i);
    const first = buttons[0];
    if (!first) throw new Error("botão ignorar não encontrado");
    fireEvent.click(first);
    expect(dismissCalls).toEqual(["a1111111-1111-1111-1111-111111111111"]);
  });

  test("fila vazia → empty state", async () => {
    queueData = [];
    const { IdentifyQueue } = await import("../../../src/components/identify-queue");
    render(<IdentifyQueue />);
    expect(screen.getByText(/nenhum anônimo frequente/i)).toBeTruthy();
  });
});
