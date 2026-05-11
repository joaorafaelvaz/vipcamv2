/**
 * Parser shared entre discovery/capture.ts (single-shot) e ingest/listener.ts
 * (long-poll persistente). Linhas Dahua têm formato:
 *   "Code=FaceDetection;action=Start;index=0;data={...JSON nested...}"
 */
export interface ParsedDahuaEvent {
  code?: string;
  action?: string;
  data?: unknown;
}

/**
 * Parsea uma linha Dahua. Retorna `undefined` quando nada relevante foi
 * extraído (vs. `{}` que parecia "parseou mas vazio") — mantém o contrato
 * de `parsed?` semanticamente honesto.
 */
export function parseDahuaEventLine(raw: string): ParsedDahuaEvent | undefined {
  const out: ParsedDahuaEvent = {};
  for (const seg of raw.split(";")) {
    const eq = seg.indexOf("=");
    if (eq < 0) continue;
    const k = seg.slice(0, eq).trim().toLowerCase();
    const v = seg.slice(eq + 1).trim();
    if (k === "code") out.code = v;
    else if (k === "action") out.action = v;
    else if (k === "data") {
      try {
        out.data = JSON.parse(v);
      } catch {
        out.data = v;
      }
    }
  }
  if (out.code === undefined && out.action === undefined && out.data === undefined) {
    return undefined;
  }
  return out;
}
