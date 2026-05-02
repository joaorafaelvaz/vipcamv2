// Tipos de domínio compartilhados entre edge e web.
// Esta onda só tem stubs; entidades reais (Person, Detection, Session) entram nas Fases 2+.

export type ISO8601 = string;
export type UUID = string;

// Health response usado pela Fase 0 e expandido nas Fases 2+.
export interface HealthCheck {
  ok: boolean;
  latency_ms?: number;
  error?: string;
}

export interface HealthResponse {
  status: "healthy" | "degraded" | "down";
  uptime_seconds: number;
  checks: Record<string, HealthCheck>;
}
