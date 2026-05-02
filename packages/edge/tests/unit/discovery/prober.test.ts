import { describe, expect, test } from "bun:test";
import { runProbes } from "../../../src/discovery/prober.js";
import type { ProbeFn } from "../../../src/discovery/types.js";

describe("runProbes", () => {
  test("executa todas as probes e retorna lista de resultados em ordem", async () => {
    const probes: ProbeFn[] = [
      async () => ({
        name: "p1",
        endpoint: "/p1",
        status: "ok",
        duration_ms: 5,
      }),
      async () => ({
        name: "p2",
        endpoint: "/p2",
        status: "not_found",
        http_status: 404,
        duration_ms: 8,
      }),
    ];
    const results = await runProbes(probes);
    expect(results).toHaveLength(2);
    expect(results[0]?.name).toBe("p1");
    expect(results[1]?.status).toBe("not_found");
  });

  test("captura erro lançado por probe e converte em ProbeResult com status=error", async () => {
    const probes: ProbeFn[] = [
      async () => {
        throw new Error("boom");
      },
    ];
    const results = await runProbes(probes);
    expect(results[0]?.status).toBe("error");
    expect(results[0]?.error).toContain("boom");
  });
});
