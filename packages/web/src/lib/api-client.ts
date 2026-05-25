import type { DiscoveryReport } from "@vipcam/shared";
import { getClientEnv } from "./env";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? `${status} ${code}`);
    this.name = "ApiError";
  }
}

interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

export async function apiFetch<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const env = getClientEnv();
  const url = `${env.NEXT_PUBLIC_API_URL}${path}`;
  const headers: Record<string, string> = {
    "X-API-Key": env.NEXT_PUBLIC_API_KEY,
  };
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const init: RequestInit = { method: opts.method ?? "GET", headers };
  if (body !== undefined) init.body = body;
  if (opts.signal !== undefined) init.signal = opts.signal;
  const res = await fetch(url, init);

  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, errBody.error ?? "unknown_error");
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

/** Constrói URL absoluta pra snapshot a partir do snapshot_path do edge.
 *
 * Onda 7 §2.3: snapshot_path é path relativo formato 'YYYY-MM-DD/<uuid>.jpg'.
 * URL final preserva ambos os segmentos pra rota /snapshots/:date/:filename
 * (regex anti-traversal valida cada um separado).
 */
export function snapshotUrl(snapshotPath: string | null): string | null {
  if (!snapshotPath) return null;
  const env = getClientEnv();
  return `${env.NEXT_PUBLIC_API_URL}/snapshots/${snapshotPath}`;
}

// ---- Discovery helpers (Onda 1, re-implementados via apiFetch) ----

export async function getLastDiscoveryReport(): Promise<DiscoveryReport | null> {
  try {
    const r = await apiFetch<{ report: DiscoveryReport }>("/api/discovery/last-report");
    return r.report;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export async function runDiscovery(captureSeconds?: number): Promise<DiscoveryReport> {
  const r = await apiFetch<{ report: DiscoveryReport }>("/api/discovery/probe", {
    method: "POST",
    body: captureSeconds !== undefined ? { capture_seconds: captureSeconds } : {},
  });
  return r.report;
}
