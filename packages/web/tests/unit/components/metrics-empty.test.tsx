import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import * as React from "react";
import { VisitsFlowChart } from "../../../src/components/metrics/visits-flow-chart";
import { RecurrenceDonut } from "../../../src/components/metrics/recurrence-donut";

describe("estados vazios", () => {
  test("VisitsFlowChart sem pontos mostra mensagem", () => {
    render(<VisitsFlowChart points={[]} trend={{ slope: 0, direction: "flat" }} />);
    expect(screen.getByText(/sem dados/i)).toBeDefined();
  });
  test("RecurrenceDonut sem identificados mostra mensagem dedicada", () => {
    render(
      <RecurrenceDonut data={{ new_count: 0, returning_count: 0, identified_visits: 0, total_visits: 12 }} />,
    );
    expect(screen.getByText(/sem clientes identificados/i)).toBeDefined();
  });
});
