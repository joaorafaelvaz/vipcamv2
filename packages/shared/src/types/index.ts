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

// === Onda 3 — visibility dashboard ===

export interface PersonSummary {
  id: UUID;
  display_name: string | null;
  person_type: "client" | "employee" | "anonymous";
  photo_path: string | null;
  last_seen_at: ISO8601 | null;
  total_visits: number;
  erp_client_id: string | null;
  erp_employee_id: string | null;
  phone: string | null;
}

export interface PersonDetail extends PersonSummary {
  avg_dominant_emotion: string | null;
  first_seen_at: ISO8601 | null;
  avg_visit_duration_min: number | null;
}

export interface DetectionThumbnail {
  id: UUID;
  detected_at: ISO8601;
  snapshot_path: string | null;
  face_attrs: Record<string, unknown>;
  dominant_emotion: string | null;
  emotion_confidence: number | null;
  session_id: UUID | null;
  camera_id: UUID;
}

export interface SessionWithDetections {
  id: UUID;
  started_at: ISO8601;
  ended_at: ISO8601 | null;
  detection_count: number;
  dominant_emotion: string | null;
  linked_erp_checkin_id: string | null;
  detections: DetectionThumbnail[];
}

export interface MatchPendingEnriched {
  match_attempt_id: UUID;
  decided_at: ISO8601;
  notes: string | null;
  checkin: {
    erp_id: string;
    client_name: string | null;
    client_phone: string | null;
    erp_client_id: string;
    person_id: UUID | null;
    occurred_at: ISO8601;
    event_type: string;
  };
  candidates: DetectionThumbnail[];
}

export interface LiveDetectionEvent {
  type: "detection";
  detection: DetectionThumbnail;
  person: PersonSummary | null;
}

export interface DashboardSummary {
  pending_matches: number;
  last_detection_at: ISO8601 | null;
  detections_today: number;
  persons_total: { client: number; employee: number };
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
}
