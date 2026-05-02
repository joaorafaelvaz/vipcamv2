import type { DiscoveryReport } from "@vipcam/shared";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** Lança um Error consistente a partir de uma resposta não-OK. */
async function throwApiError(r: Response, fallback: string): Promise<never> {
  const body = (await r.json().catch(() => ({}))) as { error?: string };
  const detail = body.error ?? fallback;
  throw new Error(`${r.status} ${detail}`);
}

export async function getLastDiscoveryReport(): Promise<DiscoveryReport | null> {
  const r = await fetch(`${API_URL}/api/discovery/last-report`, { cache: "no-store" });
  if (r.status === 404) return null;
  if (!r.ok) await throwApiError(r, "failed_to_fetch_last_report");
  const body = (await r.json()) as { report: DiscoveryReport };
  return body.report;
}

export async function runDiscovery(captureSeconds?: number): Promise<DiscoveryReport> {
  const r = await fetch(`${API_URL}/api/discovery/probe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capture_seconds: captureSeconds }),
  });
  if (!r.ok) await throwApiError(r, "discovery_failed");
  const body = (await r.json()) as { report: DiscoveryReport };
  return body.report;
}
