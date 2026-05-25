import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ORIG_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
});

import { pingReid } from "../../../../src/api/reid/health.js";

describe("pingReid", () => {
  test("returns ok=true + model metadata when /health responds 200", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            status: "healthy",
            version: "0.2.0",
            model_name: "buffalo_s",
            model_revision: "insightface-0.7.3",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof globalThis.fetch;

    const r = await pingReid("http://127.0.0.1:5005");
    expect(r.ok).toBe(true);
    expect(r.latency_ms).toBeGreaterThanOrEqual(0);
    expect(r.model_name).toBe("buffalo_s");
    expect(r.model_revision).toBe("insightface-0.7.3");
    expect(r.error).toBeUndefined();
  });

  test("returns ok=false on HTTP non-2xx", async () => {
    globalThis.fetch = mock(
      async () => new Response("server error", { status: 500 }),
    ) as unknown as typeof globalThis.fetch;
    const r = await pingReid("http://127.0.0.1:5005");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("HTTP 500");
  });

  test("returns ok=false on fetch failure (timeout/network)", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const r = await pingReid("http://127.0.0.1:5005");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ECONNREFUSED");
  });

  test("disabled flag short-circuits ping (REID_ENABLED=false)", async () => {
    let fetched = false;
    globalThis.fetch = mock(async () => {
      fetched = true;
      return new Response("never", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const r = await pingReid("http://127.0.0.1:5005", { disabled: true });
    expect(r.ok).toBe(true);
    expect(r.disabled).toBe(true);
    expect(fetched).toBe(false);
  });
});
