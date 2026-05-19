import { parseMultipartChunks } from "../discovery/capture.js";
import { parseDahuaEventLine } from "./dahua-event-parse.js";

export interface CapturedRawEvent {
  index: number;
  received_at: string;
  raw: string;
  parsed?: { code?: string; action?: string; data?: unknown };
}

export interface ConsumeStreamOptions {
  /** ReadableStream do body de uma resposta multipart/x-mixed-replace. */
  reader: ReadableStreamDefaultReader<Uint8Array>;
  /** Boundary token (com ou sem --) extraído do Content-Type. */
  boundary: string;
  /** Index inicial para `event.index` (permite continuidade entre runs). */
  startIndex?: number;
  /** Chamado para cada evento parseado. Pipe assíncrono (caller não aguarda). */
  onEvent: (event: CapturedRawEvent) => void;
  /** Permite cancelamento externo. */
  signal: AbortSignal;
  /** Override (testes): now() injetável. Default: () => new Date().toISOString(). */
  now?: () => string;
  /** Onda 6: tap opcional injetado p/ o image-probe. Recebe os bytes crus
   *  do chunk + boundary ANTES do parse string. Exceções são engolidas —
   *  nunca quebram o ingest. Ausente = comportamento idêntico ao anterior. */
  probeTap?: (chunk: Buffer, boundary: string) => void;
}

/**
 * Consome um ReadableStream multipart, parseia chunks Dahua e despacha cada
 * evento para `onEvent`. Função pura (não toca DB nem rede além do reader).
 *
 * Encerra em 3 condições:
 *   1. `done` do reader (EOF)
 *   2. `signal.aborted`
 *   3. exceção propagada (chamador trata via try/catch)
 *
 * Por contrato, `onEvent` deve ser fire-and-forget — não awaitamos cada
 * chamada para não bloquear leitura do próximo chunk no socket.
 */
export async function consumeStream(opts: ConsumeStreamOptions): Promise<number> {
  const now = opts.now ?? (() => new Date().toISOString());
  let pending: Buffer = Buffer.alloc(0);
  let eventIdx = opts.startIndex ?? 0;

  try {
    while (!opts.signal.aborted) {
      const { done, value } = await opts.reader.read();
      if (done) break;
      if (value) {
        const chunkBuf = Buffer.from(value);
        pending = Buffer.concat([pending, chunkBuf]);
        if (opts.probeTap) {
          try {
            opts.probeTap(chunkBuf, opts.boundary);
          } catch {
            /* probe é best-effort — nunca quebra o ingest */
          }
        }
      }

      const { events, remainder } = parseMultipartChunks(pending, opts.boundary);
      pending = remainder;

      for (const raw of events) {
        const parsed = parseDahuaEventLine(raw);
        const captured: CapturedRawEvent = {
          index: eventIdx++,
          received_at: now(),
          raw,
        };
        if (parsed !== undefined) captured.parsed = parsed;
        opts.onEvent(captured);
      }
    }
  } finally {
    await opts.reader.cancel().catch(() => {});
  }
  return eventIdx;
}
