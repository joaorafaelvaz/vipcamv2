import type { HealthCheck } from "@vipcam/shared";

export interface ReidHealthCheck extends HealthCheck {
  model_name?: string;
  model_revision?: string;
  /** True quando REID_ENABLED=false — skip ping, ok=true (sem degradar overall). */
  disabled?: boolean;
}

/**
 * Ping síncrono ao /health do sidecar reid (Onda 7 §3.4).
 *
 * Timeout 1s — sidecar é localhost; latency normal <10ms. Se demorar mais,
 * algo está errado e degrade health pra "degraded" no /api/health.
 *
 * Sem cache — estado sempre real. /api/health é raro o suficiente pra que
 * isso não seja problema (uptime monitoring chama cada 30-60s).
 */
export async function pingReid(
  reidBaseUrl: string,
  opts: { disabled?: boolean } = {},
): Promise<ReidHealthCheck> {
  if (opts.disabled) {
    return { ok: true, disabled: true };
  }
  const t0 = Date.now();
  try {
    const r = await fetch(`${reidBaseUrl}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!r.ok) {
      return { ok: false, error: `HTTP ${r.status}` };
    }
    const body = (await r.json()) as {
      model_name?: string;
      model_revision?: string;
    };
    return {
      ok: true,
      latency_ms: Date.now() - t0,
      ...(body.model_name ? { model_name: body.model_name } : {}),
      ...(body.model_revision ? { model_revision: body.model_revision } : {}),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
