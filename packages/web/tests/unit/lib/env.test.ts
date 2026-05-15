import { describe, expect, test } from "bun:test";
import { parseClientEnv } from "../../../src/lib/env.js";

describe("parseClientEnv", () => {
  test("aceita env válido", () => {
    const env = parseClientEnv({
      NEXT_PUBLIC_API_URL: "http://localhost:4000",
      NEXT_PUBLIC_API_KEY: "secret",
    });
    expect(env.NEXT_PUBLIC_API_URL).toBe("http://localhost:4000");
    expect(env.NEXT_PUBLIC_API_KEY).toBe("secret");
  });

  test("rejeita API_URL sem protocolo", () => {
    expect(() =>
      parseClientEnv({ NEXT_PUBLIC_API_URL: "localhost:4000", NEXT_PUBLIC_API_KEY: "x" }),
    ).toThrow();
  });

  test("rejeita API_KEY vazia", () => {
    expect(() =>
      parseClientEnv({ NEXT_PUBLIC_API_URL: "http://l", NEXT_PUBLIC_API_KEY: "" }),
    ).toThrow();
  });

  test("rejeita API_URL ausente", () => {
    expect(() => parseClientEnv({ NEXT_PUBLIC_API_KEY: "x" })).toThrow();
  });
});
