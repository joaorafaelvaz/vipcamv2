import { describe, expect, test } from "bun:test";
import {
  classifyFetchError,
  fetchPhotoLive,
} from "../../../src/erp-sync/employee-face-seeder-deps.js";

describe("classifyFetchError", () => {
  test("AbortError/TimeoutError → timeout", () => {
    const err = new Error("aborted") as Error & { name?: string };
    err.name = "TimeoutError";
    expect(classifyFetchError(err)).toEqual({ kind: "timeout" });
  });

  test("ENOTFOUND → dns", () => {
    const err = new Error("getaddrinfo ENOTFOUND example.invalid") as Error & {
      code?: string;
    };
    err.code = "ENOTFOUND";
    expect(classifyFetchError(err)).toEqual({ kind: "dns" });
  });

  test("default → network c/ detail", () => {
    const err = new Error("ECONNREFUSED 127.0.0.1:80");
    expect(classifyFetchError(err)).toEqual({
      kind: "network",
      detail: "ECONNREFUSED 127.0.0.1:80",
    });
  });
});

describe("fetchPhotoLive (integration-lite — uses unreachable port)", () => {
  test("connection refused → { ok: false, error: 'network'|'timeout' }", async () => {
    // Porta 1 quase sempre rejeita conexão; pode também dar timeout em alguns OS
    const result = await fetchPhotoLive("http://127.0.0.1:1/no-such", 500);
    expect(result.ok).toBe(false);
    if (!result.ok && "error" in result) {
      expect(["network", "timeout", "dns"]).toContain(result.error);
    }
  });
});
