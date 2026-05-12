import { describe, expect, test } from "bun:test";
import { type CapturedRawEvent, consumeStream } from "../../../src/ingest/listener-stream.js";

const BOUNDARY = "--myboundary";

/**
 * Constrói um chunk multipart com um payload Dahua e o boundary correto.
 * Formato real visto na produção:
 *   --myboundary\r\nContent-Type: text/plain\r\n...\r\n\r\nCode=...;data=...\r\n--myboundary
 */
function makeMultipartChunk(payloads: string[]): Buffer {
  const parts = payloads.map(
    (body) =>
      `${BOUNDARY}\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\n\r\n${body}\r\n`,
  );
  return Buffer.from(parts.join("") + BOUNDARY);
}

/**
 * Cria ReadableStream a partir de uma sequência de chunks Buffer.
 * Cada read() retorna um chunk; após o último, retorna { done: true }.
 */
function streamFromChunks(chunks: Buffer[]): ReadableStreamDefaultReader<Uint8Array> {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (i < chunks.length) {
        ctrl.enqueue(new Uint8Array(chunks[i]!));
        i += 1;
      } else {
        ctrl.close();
      }
    },
  });
  return stream.getReader();
}

describe("consumeStream", () => {
  test("dispatcha 1 evento por payload Dahua observado no chunk", async () => {
    const events: CapturedRawEvent[] = [];
    const reader = streamFromChunks([
      makeMultipartChunk([
        'Code=FaceDetection;action=Start;index=0;data={"Object":{"ObjectID":1}}',
      ]),
    ]);
    const ac = new AbortController();
    const fixedNow = "2026-05-12T12:00:00.000Z";

    const finalIdx = await consumeStream({
      reader,
      boundary: BOUNDARY,
      signal: ac.signal,
      now: () => fixedNow,
      onEvent: (e) => events.push(e),
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.index).toBe(0);
    expect(events[0]?.received_at).toBe(fixedNow);
    expect(events[0]?.parsed?.code).toBe("FaceDetection");
    expect(events[0]?.parsed?.action).toBe("Start");
    expect((events[0]?.parsed?.data as { Object: { ObjectID: number } }).Object.ObjectID).toBe(1);
    expect(finalIdx).toBe(1);
  });

  test("respeita startIndex (continuidade entre runs)", async () => {
    const events: CapturedRawEvent[] = [];
    const reader = streamFromChunks([
      makeMultipartChunk(["Code=A;action=Start", "Code=B;action=Start"]),
    ]);

    await consumeStream({
      reader,
      boundary: BOUNDARY,
      signal: new AbortController().signal,
      startIndex: 100,
      onEvent: (e) => events.push(e),
    });

    expect(events.map((e) => e.index)).toEqual([100, 101]);
  });

  test("aceita múltiplos chunks e mantém remainder entre reads", async () => {
    // Chunk 1: parte do header sem body completo (sem evento ainda)
    // Chunk 2: complemento do body + boundary final
    const half1 = Buffer.from(`${BOUNDARY}\r\nContent-Type: text/plain\r\n\r\nCode=Test;action=`);
    const half2 = Buffer.from(`Start;data={"x":1}\r\n${BOUNDARY}`);

    const events: CapturedRawEvent[] = [];
    await consumeStream({
      reader: streamFromChunks([half1, half2]),
      boundary: BOUNDARY,
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.parsed?.code).toBe("Test");
    expect(events[0]?.parsed?.action).toBe("Start");
  });

  test("para quando signal.aborted", async () => {
    const events: CapturedRawEvent[] = [];
    const ac = new AbortController();
    ac.abort(); // já abortado antes do start

    const reader = streamFromChunks([makeMultipartChunk(["Code=X;action=Y"])]);
    await consumeStream({
      reader,
      boundary: BOUNDARY,
      signal: ac.signal,
      onEvent: (e) => events.push(e),
    });

    // Loop nem deveria entrar; signal aborted desde o início
    expect(events).toHaveLength(0);
  });

  test("não falha em payload sem '=' (parser retorna undefined)", async () => {
    const events: CapturedRawEvent[] = [];
    const reader = streamFromChunks([makeMultipartChunk(["garbage without equals"])]);

    await consumeStream({
      reader,
      boundary: BOUNDARY,
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.raw).toBe("garbage without equals");
    expect(events[0]?.parsed).toBeUndefined();
  });
});
