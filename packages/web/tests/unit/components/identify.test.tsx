// Onda 10 — IdentifyEmployeeDialog + IdentifyQueue num ÚNICO arquivo.
// bun:test mock.module é process-global e o RE-mock de um módulo já
// instanciado por outro arquivo não substitui de forma confiável (visto
// empiricamente: mock incompleto de queries/identify registrado num arquivo
// anterior vazou e quebrou o seguinte com "Export named ... not found").
// Um arquivo = um conjunto de mocks completo = determinístico.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { IdentifyQueueItem } from "@vipcam/shared";
import * as React from "react";

const employees = [
  {
    id: "e1111111-1111-1111-1111-111111111111",
    display_name: "Carlos Barbeiro",
    person_type: "employee",
    photo_path: null,
    last_seen_at: null,
    total_visits: 0,
    erp_client_id: null,
    erp_employee_id: "10",
    phone: null,
  },
  {
    id: "e2222222-2222-2222-2222-222222222222",
    display_name: "Diego Caixa",
    person_type: "employee",
    photo_path: null,
    last_seen_at: null,
    total_visits: 0,
    erp_client_id: null,
    erp_employee_id: "11",
    phone: null,
  },
];

const queueItems: IdentifyQueueItem[] = [
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

let queueData: IdentifyQueueItem[] = queueItems;
const identifyCalls: Array<{ anonId: string; employeePersonId: string }> = [];
const dismissCalls: string[] = [];

mock.module("../../../src/lib/api-client", () => ({
  snapshotUrl: (p: string | null) => (p ? `http://test/snapshots/${p}` : null),
  apiFetch: async () => ({}),
  ApiError: class extends Error {},
}));
mock.module("../../../src/lib/queries/persons", () => ({
  usePeople: () => ({ data: { items: employees, total: 2 }, isLoading: false }),
}));
mock.module("../../../src/lib/queries/identify", () => ({
  useIdentifyQueue: () => ({ data: queueData, isLoading: false }),
  useDismissIdentify: () => ({
    mutate: (id: string) => dismissCalls.push(id),
    isPending: false,
  }),
  useIdentifyAsEmployee: () => ({
    mutate: (
      p: { anonId: string; employeePersonId: string },
      opts?: { onSuccess?: () => void },
    ) => {
      identifyCalls.push(p);
      opts?.onSuccess?.();
    },
    isPending: false,
  }),
}));

const ANON = "a1111111-1111-1111-1111-111111111111";

beforeEach(() => {
  queueData = queueItems;
  identifyCalls.length = 0;
  dismissCalls.length = 0;
});

describe("<IdentifyEmployeeDialog>", () => {
  test("renderiza o trigger 'É funcionário…'", async () => {
    const { IdentifyEmployeeDialog } = await import(
      "../../../src/components/identify-employee-dialog"
    );
    render(<IdentifyEmployeeDialog anonId={ANON} />);
    expect(screen.getByText(/é funcionário/i)).toBeTruthy();
  });

  test("aberto: lista funcionários e filtra pelo input", async () => {
    const { IdentifyEmployeeDialog } = await import(
      "../../../src/components/identify-employee-dialog"
    );
    render(<IdentifyEmployeeDialog anonId={ANON} defaultOpen />);
    expect(screen.getByText("Carlos Barbeiro")).toBeTruthy();
    expect(screen.getByText("Diego Caixa")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/buscar funcionário/i), {
      target: { value: "diego" },
    });
    expect(screen.queryByText("Carlos Barbeiro")).toBeNull();
    expect(screen.getByText("Diego Caixa")).toBeTruthy();
  });

  test("selecionar funcionário + Confirmar → mutate(anonId, employeePersonId)", async () => {
    const { IdentifyEmployeeDialog } = await import(
      "../../../src/components/identify-employee-dialog"
    );
    render(<IdentifyEmployeeDialog anonId={ANON} defaultOpen />);

    const confirm = screen.getByRole("button", { name: /confirmar/i });
    expect(confirm.hasAttribute("disabled")).toBe(true); // nada selecionado

    fireEvent.click(screen.getByText("Diego Caixa"));
    expect(confirm.hasAttribute("disabled")).toBe(false);

    fireEvent.click(confirm);
    expect(identifyCalls).toEqual([
      { anonId: ANON, employeePersonId: "e2222222-2222-2222-2222-222222222222" },
    ]);
  });
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
