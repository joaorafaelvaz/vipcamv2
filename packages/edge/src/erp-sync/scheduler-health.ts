/**
 * Registry global das execuções dos cron jobs do scheduler.
 *
 * **I4 (review 2026-05-13):** validateErpQueries roda no boot, mas se schema
 * do ERP mudar em runtime (DBA renomeia coluna numa terça), o pollCheckins
 * passa a throw a cada 30s e o erro só aparece no journal — health check
 * fica green, monitoring não alerta. Esse registry expõe failures consecutivas
 * pra /api/health refletir degradação.
 *
 * Threshold default 5: pra checkins (30s interval) = 2.5min de erros = mostra
 * "degraded" no health. Pra clients (15min) = 1h15. Pra employees (hourly) = 5h.
 * Não é configurável por job — manter simples.
 */

export const HEALTHY_FAILURE_THRESHOLD = 5;

export interface JobHealth {
  name: string;
  consecutive_failures: number;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  last_error?: string;
  healthy: boolean;
}

const registry = new Map<string, JobHealth>();

function getOrInit(name: string): JobHealth {
  let entry = registry.get(name);
  if (!entry) {
    entry = {
      name,
      consecutive_failures: 0,
      last_success_at: null,
      last_failure_at: null,
      healthy: true,
    };
    registry.set(name, entry);
  }
  return entry;
}

export function recordJobSuccess(name: string): void {
  const entry = getOrInit(name);
  entry.consecutive_failures = 0;
  entry.last_success_at = new Date();
  entry.healthy = true;
}

export function recordJobFailure(name: string, err: unknown): void {
  const entry = getOrInit(name);
  entry.consecutive_failures += 1;
  entry.last_failure_at = new Date();
  entry.last_error = err instanceof Error ? err.message : String(err);
  entry.healthy = entry.consecutive_failures < HEALTHY_FAILURE_THRESHOLD;
}

export function getJobHealth(): JobHealth[] {
  return [...registry.values()];
}

/** Reset interno só para testes — usar em beforeEach. */
export function _resetHealth(): void {
  registry.clear();
}
