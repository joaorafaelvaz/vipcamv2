import { describe, expect, test } from "bun:test";
import { parseEnv } from "../../../src/config/env.js";

describe("parseEnv", () => {
  test("retorna config válida quando vars obrigatórias estão presentes", () => {
    const result = parseEnv({
      EDGE_PORT: "4000",
      LOG_LEVEL: "info",
      NODE_ENV: "development",
      API_KEY: "test-key",
    });
    expect(result.EDGE_PORT).toBe(4000);
    expect(result.API_KEY).toBe("test-key");
  });

  test("aplica defaults quando vars opcionais ausentes", () => {
    const result = parseEnv({ API_KEY: "test-key" });
    expect(result.EDGE_PORT).toBe(4000);
    expect(result.LOG_LEVEL).toBe("info");
    expect(result.NODE_ENV).toBe("development");
  });

  test("lança erro quando API_KEY ausente", () => {
    expect(() => parseEnv({})).toThrow(/API_KEY/);
  });

  test("lança erro quando EDGE_PORT não é numérico", () => {
    expect(() => parseEnv({ API_KEY: "k", EDGE_PORT: "abc" })).toThrow();
  });
});
