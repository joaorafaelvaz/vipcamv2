/**
 * Parser multipart/x-mixed-replace byte-level e header-aware (Onda 6).
 *
 * Diferente de discovery/capture.ts:parseMultipartChunks (que faz
 * .toString("utf8") e descarta headers — corromperia image/jpeg), aqui
 * preservamos os headers de cada parte e o BODY como Buffer cru. Mesma
 * semântica de boundary/remainder (mantém do último boundary completo).
 */
export interface RawPart {
  headers: Record<string, string>; // lower-cased keys
  body: Buffer;
}
export interface RawParseResult {
  parts: RawPart[];
  remainder: Buffer;
}

const CRLF2 = Buffer.from("\r\n\r\n");
const LF2 = Buffer.from("\n\n");

function parseHeaders(headerBytes: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of headerBytes.toString("latin1").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * Encontra o próximo boundary token (`--boundary`) a partir de `from`, mas
 * apenas se for um delimitador *real*: ou está no offset 0 do stream, ou é
 * precedido por `\r\n` na wire. Ancorar no CRLF é o que garante a
 * binary-safety: bytes do corpo JPEG que por acaso contenham a substring
 * do boundary (ex.: `--myboundaryISH`) NÃO são confundidos com delimitador,
 * pois não vêm precedidos de `\r\n`.
 *
 * Retorna o offset onde o boundary token (`--boundary`) começa, ou -1.
 */
function findBoundary(buf: Buffer, bb: Buffer, from: number): number {
  let at = buf.indexOf(bb, from);
  while (at >= 0) {
    const crlfBefore = at >= 2 && buf[at - 2] === 0x0d && buf[at - 1] === 0x0a;
    if (at === 0 || crlfBefore) return at;
    at = buf.indexOf(bb, at + 1); // substring dentro do corpo — ignora
  }
  return -1;
}

export function parseMultipartPartsRaw(buf: Buffer, boundary: string): RawParseResult {
  const bb = Buffer.from(boundary);
  const parts: RawPart[] = [];
  let cursor = 0;
  let lastBoundary = 0;

  while (true) {
    const idx = findBoundary(buf, bb, cursor);
    if (idx < 0) break;
    const next = findBoundary(buf, bb, idx + bb.length);
    if (next < 0) break; // closing boundary not arrived → stop, keep remainder
    const partBuf = buf.subarray(idx + bb.length, next);

    let sepIdx = partBuf.indexOf(CRLF2);
    let sepLen = CRLF2.length;
    if (sepIdx < 0) {
      sepIdx = partBuf.indexOf(LF2);
      sepLen = LF2.length;
    }
    if (sepIdx >= 0) {
      const headers = parseHeaders(partBuf.subarray(0, sepIdx));
      let body = partBuf.subarray(sepIdx + sepLen);
      if (body.length >= 2 && body[0] === 0x0d && body[1] === 0x0a) body = body.subarray(2);
      else if (body.length >= 1 && body[0] === 0x0a) body = body.subarray(1);
      if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
        body = body.subarray(0, body.length - 2);
      } else if (body.length >= 1 && body[body.length - 1] === 0x0a) {
        body = body.subarray(0, body.length - 1);
      }
      if (body.length > 0) parts.push({ headers, body: Buffer.from(body) });
    }
    cursor = next;
    // Mantém o \r\n que precede o boundary no remainder, para que o próximo
    // parse (com chunk concatenado) reencontre o boundary ancorado em CRLF.
    lastBoundary = next >= 2 && buf[next - 2] === 0x0d && buf[next - 1] === 0x0a ? next - 2 : next;
  }

  return { parts, remainder: Buffer.from(buf.subarray(lastBoundary)) };
}
