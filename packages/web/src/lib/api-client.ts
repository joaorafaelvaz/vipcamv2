import type { DiscoveryReport } from "@vipcam/shared";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export async function getLastDiscoveryReport(): Promise<DiscoveryReport | null> {
  const r = await fetch(`${API_URL}/api/discovery/last-report`, { cache: "no-store" });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`failed ${r.status}`);
  const body = (await r.json()) as { report: DiscoveryReport };
  return body.report;
}

export async function runDiscovery(captureSeconds?: number): Promise<DiscoveryReport> {
  const r = await fetch(`${API_URL}/api/discovery/probe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capture_seconds: captureSeconds }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: "unknown" }));
    throw new Error((err as { error: string }).error ?? "failed");
  }
  const body = (await r.json()) as { report: DiscoveryReport };
  return body.report;
}
