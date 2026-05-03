import { describe, expect, test } from "bun:test";
import { makeFaceInfoProbes } from "../../../../src/discovery/probes/face-info.js";

describe("makeFaceInfoProbes", () => {
  test("retorna 2 probes que ficam skipped sem client", async () => {
    const probes = makeFaceInfoProbes();
    expect(probes).toHaveLength(2);
    for (const probe of probes) {
      const r = await probe(undefined);
      expect(r.status).toBe("skipped");
    }
  });
});
