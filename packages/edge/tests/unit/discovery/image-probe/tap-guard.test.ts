import { describe, expect, test } from "bun:test";
import { consumeStream } from "../../../../src/ingest/listener-stream.js";

function readerFrom(chunks: Uint8Array[]) {
  let i = 0;
  return {
    read: async () =>
      i < chunks.length ? { done: false, value: chunks[i++]! } : { done: true, value: undefined },
    cancel: async () => {},
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}
const B = "--myboundary";
const evt = Buffer.from(`${B}\r\nContent-Type: text/plain\r\n\r\nCode=Test;action=Start\r\n${B}`);

describe("consumeStream probeTap injection", () => {
  test("no probeTap → behaves exactly as before (events dispatched)", async () => {
    const seen: string[] = [];
    await consumeStream({
      reader: readerFrom([new Uint8Array(evt)]),
      boundary: B,
      signal: new AbortController().signal,
      onEvent: (e) => seen.push(e.raw),
    });
    expect(seen.length).toBeGreaterThan(0);
  });

  test("probeTap that THROWS does not break ingest (events still dispatched)", async () => {
    const seen: string[] = [];
    await consumeStream({
      reader: readerFrom([new Uint8Array(evt)]),
      boundary: B,
      signal: new AbortController().signal,
      onEvent: (e) => seen.push(e.raw),
      probeTap: () => {
        throw new Error("boom");
      },
    });
    expect(seen.length).toBeGreaterThan(0);
  });

  test("probeTap receives chunk bytes + boundary", async () => {
    let got: { len: number; b: string } | null = null;
    await consumeStream({
      reader: readerFrom([new Uint8Array(evt)]),
      boundary: B,
      signal: new AbortController().signal,
      onEvent: () => {},
      probeTap: (chunk, b) => {
        got = { len: chunk.length, b };
      },
    });
    expect(got).not.toBeNull();
    expect(got!.b).toBe(B);
  });
});
