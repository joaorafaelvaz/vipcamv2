// Probe testa o endpoint /cgi-bin/snapshot.cgi (captura JPEG sob demanda).
// Esse endpoint é requisito da Fase 4 (upload de snapshot ao Face DB) e da
// captura de imagens para exibição na UI; validamos disponibilidade aqui.
import type { ProbeResult, ProbeStatus } from "@vipcam/shared";
import type { ProbeFn } from "../types.js";

export function makeSnapshotProbe(): ProbeFn {
  const path = "/cgi-bin/snapshot.cgi?channel=1";
  const fn: ProbeFn = async (client) => {
    if (!client) {
      return { name: "snapshot.fetch", endpoint: path, status: "skipped", duration_ms: 0 };
    }
    const t0 = Date.now();
    try {
      const r = await client.get(path);
      const duration = Date.now() - t0;
      const ct = r.headers.get("content-type") ?? "";
      const isImage = ct.startsWith("image/");
      // Não baixamos a imagem inteira no relatório — só confirmamos que ela vem.
      if (r.body) await r.body.cancel().catch(() => {});
      if (r.status === 200 && isImage) {
        return {
          name: "snapshot.fetch",
          endpoint: path,
          status: "ok",
          http_status: 200,
          duration_ms: duration,
          parsed: { content_type: ct },
        };
      }
      const status: ProbeStatus =
        r.status === 401 ? "auth_failed" : r.status === 404 ? "not_found" : "error";
      const result: ProbeResult = {
        name: "snapshot.fetch",
        endpoint: path,
        status,
        http_status: r.status,
        duration_ms: duration,
      };
      if (!isImage) result.error = `expected image, got ${ct}`;
      return result;
    } catch (err) {
      return {
        name: "snapshot.fetch",
        endpoint: path,
        status: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "error",
        duration_ms: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
  Object.defineProperty(fn, "name", { value: "snapshot.fetch" });
  return fn;
}
