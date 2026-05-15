import { describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import type { PersonSummary } from "@vipcam/shared";
import * as React from "react";

const samples: PersonSummary[] = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    display_name: "Ana Costa",
    person_type: "client",
    photo_path: null,
    last_seen_at: "2026-05-14T13:00:00Z",
    total_visits: 14,
    erp_client_id: "100",
    erp_employee_id: null,
    phone: "11999",
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    display_name: "João Silva",
    person_type: "employee",
    photo_path: null,
    last_seen_at: null,
    total_visits: 1,
    erp_client_id: null,
    erp_employee_id: "10",
    phone: null,
  },
];

mock.module("../../../src/lib/queries/persons", () => ({
  usePeople: () => ({ data: { items: samples, total: 2 }, isLoading: false, isFetching: false }),
}));

describe("<PersonTable>", () => {
  test("renderiza linhas com nome, telefone, total_visits", async () => {
    const { PersonTable } = await import("../../../src/components/person-table");
    render(<PersonTable />);
    expect(screen.getByText("Ana Costa")).toBeTruthy();
    expect(screen.getByText("João Silva")).toBeTruthy();
    expect(screen.getByText("11999")).toBeTruthy();
    expect(screen.getByText("14")).toBeTruthy();
  });

  test("renderiza search input + select de tipo", async () => {
    const { PersonTable } = await import("../../../src/components/person-table");
    render(<PersonTable />);
    expect(screen.getByPlaceholderText(/buscar/i)).toBeTruthy();
    expect(screen.getByRole("combobox")).toBeTruthy();
  });
});
