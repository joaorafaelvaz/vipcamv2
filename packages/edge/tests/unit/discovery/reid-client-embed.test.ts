import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { EmbedResult } from "@vipcam/shared";
import { ReidError, embed } from "../../../src/discovery/image-probe/reid-client.js";

const ORIG_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
});

describe("reid-client.embed", () => {
  test("POSTs multipart com file + bbox form fields, parses JSON em EmbedResult", async () => {
    const fakeResult: EmbedResult = {
      embedding: Array(512).fill(0.01),
      det_score: 0.95,
      infer_ms: 28,
      model_name: "buffalo_s",
      model_revision: "insightface-0.7.3",
      crop_jpeg_b64: "/9j/4AAQSkZJRg==",
    };
    let receivedUrl = "";
    let receivedBody: FormData | null = null;
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      receivedUrl = url.toString();
      receivedBody = init?.body as FormData;
      return new Response(JSON.stringify(fakeResult), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const result = await embed("http://127.0.0.1:5005", Buffer.from("fake-frame-bytes"), {
      x: 10,
      y: 20,
      w: 100,
      h: 100,
    });

    expect(result).toEqual(fakeResult);
    expect(receivedUrl).toBe("http://127.0.0.1:5005/embed");
    expect(receivedBody).toBeInstanceOf(FormData);
    const fd = receivedBody as unknown as FormData;
    expect(fd.get("x")).toBe("10");
    expect(fd.get("y")).toBe("20");
    expect(fd.get("w")).toBe("100");
    expect(fd.get("h")).toBe("100");
    expect(fd.get("file")).toBeInstanceOf(Blob);
  });

  test("throws ReidError on HTTP non-2xx, carrying .status (caller mapeia 422→no_face, 5xx→sidecar_error)", async () => {
    // Regressão Onda 9-B: o seeder lê err.status pra bifurcar 422 (no_face)
    // vs 5xx (sidecar_error). Se ReidError não carregar status, todo erro
    // HTTP cai no bucket "network" → 422 vira sidecar_error (falso alarme).
    for (const status of [400, 422, 503]) {
      globalThis.fetch = mock(
        async () => new Response('{"detail":"x"}', { status }),
      ) as unknown as typeof globalThis.fetch;
      const err = await embed("http://127.0.0.1:5005", Buffer.from("x"), {
        x: 0,
        y: 0,
        w: 1,
        h: 1,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(ReidError);
      expect((err as ReidError).status).toBe(status);
    }
  });

  test("throws ReidError on fetch failure (network/timeout) — sem .status", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const err = await embed("http://127.0.0.1:5005", Buffer.from("x"), {
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ReidError);
    expect((err as ReidError).status).toBeUndefined();
  });

  test("attaches AbortSignal.timeout() by default", async () => {
    let receivedSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_url, init?: RequestInit) => {
      receivedSignal = init?.signal ?? undefined;
      return new Response(
        JSON.stringify({
          embedding: [],
          det_score: 0,
          infer_ms: 0,
          model_name: "x",
          model_revision: "y",
          crop_jpeg_b64: "",
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;
    await embed("http://x", Buffer.from(""), { x: 0, y: 0, w: 1, h: 1 });
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });
});
