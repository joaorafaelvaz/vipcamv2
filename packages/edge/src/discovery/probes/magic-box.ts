import type { ProbeResult } from "@vipcam/shared";
import type { ProbeFn } from "../types.js";

const ENDPOINTS = [
  { name: "magicBox.getSystemInfo", path: "/cgi-bin/magicBox.cgi?action=getSystemInfo" },
  { name: "magicBox.getDeviceType", path: "/cgi-bin/magicBox.cgi?action=getDeviceType" },
  { name: "magicBox.getSerialNo", path: "/cgi-bin/magicBox.cgi?action=getSerialNo" },
  { name: "magicBox.getSoftwareVersion", path: "/cgi-bin/magicBox.cgi?action=getSoftwareVersion" },
];

export function parseMagicBoxKeyValue(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

export function makeMagicBoxProbes(): ProbeFn[] {
  return ENDPOINTS.map(({ name, path }) => {
    const fn: ProbeFn = async (client) => {
      if (!client) {
        return { name, endpoint: path, status: "skipped", duration_ms: 0 };
      }
      const t0 = Date.now();
      try {
        const r = await client.get(path);
        const text = await r.text();
        const duration = Date.now() - t0;
        if (r.status === 401) {
          return {
            name,
            endpoint: path,
            status: "auth_failed",
            http_status: 401,
            duration_ms: duration,
          };
        }
        if (r.status === 404) {
          return {
            name,
            endpoint: path,
            status: "not_found",
            http_status: 404,
            duration_ms: duration,
          };
        }
        if (r.status >= 200 && r.status < 300) {
          const result: ProbeResult = {
            name,
            endpoint: path,
            status: "ok",
            http_status: r.status,
            duration_ms: duration,
            raw_response_excerpt: text.slice(0, 1000),
            parsed: parseMagicBoxKeyValue(text),
          };
          return result;
        }
        return {
          name,
          endpoint: path,
          status: "error",
          http_status: r.status,
          duration_ms: duration,
          raw_response_excerpt: text.slice(0, 1000),
          error: `unexpected status ${r.status}`,
        };
      } catch (err) {
        const isTimeout = err instanceof Error && err.name === "TimeoutError";
        return {
          name,
          endpoint: path,
          status: isTimeout ? "timeout" : "error",
          duration_ms: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };
    Object.defineProperty(fn, "name", { value: name });
    return fn;
  });
}
