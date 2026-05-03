import type { ProbeStatus } from "@vipcam/shared";
import type { ProbeFn } from "../types.js";

const ENDPOINTS = [
  { name: "faceInfo.getCollectionList", path: "/cgi-bin/FaceInfoManager.cgi?action=getCollection" },
  { name: "faceInfo.getCount", path: "/cgi-bin/FaceInfoManager.cgi?action=getCount" },
];

function statusFromHttp(httpStatus: number): ProbeStatus {
  if (httpStatus === 200) return "ok";
  if (httpStatus === 401) return "auth_failed";
  if (httpStatus === 404) return "not_found";
  return "error";
}

export function makeFaceInfoProbes(): ProbeFn[] {
  return ENDPOINTS.map(({ name, path }) => {
    const fn: ProbeFn = async (client) => {
      if (!client) return { name, endpoint: path, status: "skipped", duration_ms: 0 };
      const t0 = Date.now();
      try {
        const r = await client.get(path);
        const text = await r.text();
        return {
          name,
          endpoint: path,
          status: statusFromHttp(r.status),
          http_status: r.status,
          duration_ms: Date.now() - t0,
          raw_response_excerpt: text.slice(0, 1000),
        };
      } catch (err) {
        return {
          name,
          endpoint: path,
          status: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "error",
          duration_ms: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };
    Object.defineProperty(fn, "name", { value: name });
    return fn;
  });
}
