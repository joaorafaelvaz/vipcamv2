import { beforeEach, describe, expect, test } from "bun:test";
import {
  HEALTHY_FAILURE_THRESHOLD,
  _resetHealth,
  getJobHealth,
  recordJobFailure,
  recordJobSuccess,
} from "../../../src/erp-sync/scheduler-health.js";

beforeEach(() => {
  _resetHealth();
});

describe("scheduler health registry", () => {
  test("getJobHealth retorna array vazio antes de qualquer record", () => {
    expect(getJobHealth()).toEqual([]);
  });

  test("recordJobSuccess inicializa entry com consecutive_failures=0", () => {
    recordJobSuccess("employees");
    const [entry] = getJobHealth();
    expect(entry?.name).toBe("employees");
    expect(entry?.consecutive_failures).toBe(0);
    expect(entry?.last_success_at).toBeInstanceOf(Date);
    expect(entry?.last_failure_at).toBeNull();
    expect(entry?.healthy).toBe(true);
  });

  test("recordJobFailure incrementa consecutive_failures e armazena erro", () => {
    recordJobFailure("checkins", new Error("ERP timeout"));
    const [entry] = getJobHealth();
    expect(entry?.consecutive_failures).toBe(1);
    expect(entry?.last_failure_at).toBeInstanceOf(Date);
    expect(entry?.last_error).toBe("ERP timeout");
    expect(entry?.healthy).toBe(true); // 1 < THRESHOLD
  });

  test("após THRESHOLD failures consecutivas, healthy=false", () => {
    for (let i = 0; i < HEALTHY_FAILURE_THRESHOLD; i++) {
      recordJobFailure("checkins", new Error(`fail ${i}`));
    }
    const [entry] = getJobHealth();
    expect(entry?.consecutive_failures).toBe(HEALTHY_FAILURE_THRESHOLD);
    expect(entry?.healthy).toBe(false);
  });

  test("um success reseta consecutive_failures e healthy volta a true", () => {
    for (let i = 0; i < HEALTHY_FAILURE_THRESHOLD + 2; i++) {
      recordJobFailure("checkins", new Error("x"));
    }
    expect(getJobHealth()[0]?.healthy).toBe(false);

    recordJobSuccess("checkins");
    const [entry] = getJobHealth();
    expect(entry?.consecutive_failures).toBe(0);
    expect(entry?.healthy).toBe(true);
  });

  test("jobs distintos rastreiam separadamente", () => {
    recordJobSuccess("employees");
    recordJobFailure("checkins", new Error("nope"));
    recordJobSuccess("clients");

    const all = getJobHealth();
    expect(all).toHaveLength(3);
    const checkins = all.find((j) => j.name === "checkins");
    const employees = all.find((j) => j.name === "employees");
    expect(checkins?.consecutive_failures).toBe(1);
    expect(employees?.consecutive_failures).toBe(0);
  });
});
