import { describe, expect, test } from "bun:test";
import { parseEnv } from "../../../src/config/env.js";

const base = { API_KEY: "k" };

describe("METRICS_TZ env", () => {
  test("defaults to America/Sao_Paulo", () => {
    const env = parseEnv({ ...base });
    expect(env.METRICS_TZ).toBe("America/Sao_Paulo");
  });
  test("accepts override", () => {
    const env = parseEnv({ ...base, METRICS_TZ: "UTC" });
    expect(env.METRICS_TZ).toBe("UTC");
  });
});
