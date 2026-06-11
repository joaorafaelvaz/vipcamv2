import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
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

const identifyCalls: Array<{ anonId: string; employeePersonId: string }> = [];

mock.module("../../../src/lib/queries/persons", () => ({
  usePeople: () => ({ data: { items: employees, total: 2 }, isLoading: false }),
}));
mock.module("../../../src/lib/queries/identify", () => ({
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
  identifyCalls.length = 0;
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
