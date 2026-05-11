import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDahuaEventLine } from "../ingest/dahua-event-parse.js";
import type { DahuaHttpClient } from "../ingest/dahua-http-client.js";
import { logger } from "../obs/logger.js";

export interface CapturedEvent {
  index: number;
  received_at: string;
  raw: string;
  parsed?: { code?: string; action?: string; data?: unknown };
}

export interface CaptureResult {
  events: CapturedEvent[];
  duration_seconds: number;
  saved_to: string;
}

/**
 * Parser de multipart/x-mixed-replace tal como a Dahua usa, preservando bytes
 * não-consumidos para que o caller possa concatenar com chunks futuros sem perder
 * eventos parciais nas bordas.
 */
export interface ParseResult {
  events: string[];
  remainder: Buffer;
}

export function parseMultipartChunks(buf: Buffer, boundary: string): ParseResult {
  const boundaryBuf = Buffer.from(boundary);
  const events: string[] = [];

  let cursor = 0;
  let lastBoundaryEnd = 0;

  while (true) {
    const idx = buf.indexOf(boundaryBuf, cursor);
    if (idx < 0) break;
    const next = buf.indexOf(boundaryBuf, idx + boundaryBuf.length);
    if (next < 0) {
      // Não temos o boundary que fecha esta parte ainda — para aqui e devolve remainder
      break;
    }
    const part = buf.slice(idx + boundaryBuf.length, next).toString("utf8");
    const sep = part.indexOf("\r\n\r\n") >= 0 ? "\r\n\r\n" : "\n\n";
    const headerEnd = part.indexOf(sep);
    if (headerEnd >= 0) {
      const body = part.slice(headerEnd + sep.length).trim();
      if (body) events.push(body);
    }
    cursor = next;
    lastBoundaryEnd = next;
  }

  // Mantém tudo a partir do último boundary completo (inclusive) como remainder,
  // para que o próximo parse encontre o boundary novamente como delimitador inicial.
  const remainder = buf.slice(lastBoundaryEnd);
  return { events, remainder };
}

function tryParseDahuaEventLine(raw: string): CapturedEvent["parsed"] {
  // Delega para o parser shared (extraído em Onda 2 Task 2.11).
  return parseDahuaEventLine(raw);
}

export async function captureEvents(
  client: DahuaHttpClient,
  durationSeconds: number,
  outputDir: string,
): Promise<CaptureResult> {
  await mkdir(outputDir, { recursive: true });
  const path = "/cgi-bin/eventManager.cgi?action=attach&codes=[All]";
  const t0 = Date.now();
  const events: CapturedEvent[] = [];

  logger.info({ durationSeconds, path }, "starting event capture");

  // AbortController garante que reader.read() não fique pendurado depois do deadline
  // (caso a câmera não envie nenhum chunk durante o intervalo, a leitura ficaria bloqueada
  // até a conexão TCP morrer; o abort força a saída).
  const abortCtrl = new AbortController();
  const timer = setTimeout(() => abortCtrl.abort(), durationSeconds * 1000);

  const response = await client.getStream(path, { signal: abortCtrl.signal });

  if (!response.body) {
    clearTimeout(timer);
    return { events: [], duration_seconds: 0, saved_to: outputDir };
  }

  const ct = response.headers.get("content-type") ?? "";
  const boundaryMatch = ct.match(/boundary=([^;]+)/i);
  const boundary = boundaryMatch?.[1] ? `--${boundaryMatch[1]}` : "--myboundary";

  const reader = response.body.getReader();
  let pending: Buffer = Buffer.alloc(0);

  try {
    while (!abortCtrl.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) pending = Buffer.concat([pending, Buffer.from(value)]);

      const { events: parsed, remainder } = parseMultipartChunks(pending, boundary);
      pending = remainder; // preserva bytes não-consumidos para próxima iteração
      for (const raw of parsed) {
        const parsedLine = tryParseDahuaEventLine(raw);
        const event: CapturedEvent = {
          index: events.length,
          received_at: new Date().toISOString(),
          raw,
        };
        if (parsedLine !== undefined) event.parsed = parsedLine;
        events.push(event);
      }
    }
  } catch (err) {
    // Abort esperado quando deadline acaba — não propagar como erro.
    if (!(err instanceof Error && err.name === "AbortError")) {
      throw err;
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }

  // Salva todos os eventos como NDJSON para auditoria
  const outFile = join(outputDir, `events-${Date.now()}.ndjson`);
  const ndjson = events.map((e) => JSON.stringify(e)).join("\n");
  await writeFile(outFile, ndjson, "utf8");

  const result: CaptureResult = {
    events,
    duration_seconds: Math.round((Date.now() - t0) / 1000),
    saved_to: outFile,
  };
  logger.info({ count: events.length, file: outFile }, "event capture complete");
  return result;
}
