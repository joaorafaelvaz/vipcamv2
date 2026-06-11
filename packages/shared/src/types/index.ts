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

/** Onda 10 — item da fila de curadoria "identificar funcionário".
 * Anônimo frequente + amostras de fotos pra o operador reconhecer. */
export interface IdentifyQueueItem {
  person_id: UUID;
  detection_count: number;
  last_seen_at: ISO8601 | null;
  /** Até 3 snapshot_paths recentes (relativos — web resolve via snapshotUrl). */
  snapshots: string[];
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
  /**
   * Onda 9-A: presente apenas quando match_attempts.previous_person_id != null
   * (caso divergente reid+ERP). UI mostra warning block com info de W.
   * `| null` (não só `undefined`) pq backend pode enviar null explicit quando
   * o JOIN com prev_persons devolve linha mas FK SET NULL zerou no live state.
   */
  previous_person?: {
    id: UUID;
    display_name: string | null;
    person_type: "client" | "employee" | "anonymous";
    thumbnail_path: string | null;
  } | null;
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

// ---- Onda 5: dashboard de métricas de negócio ----

export interface VisitsFlowPoint {
  date: string; // local date YYYY-MM-DD
  count: number;
}
export interface VisitsFlow {
  points: VisitsFlowPoint[];
  trend: { slope: number; direction: "up" | "down" | "flat" };
}
export interface PeakHourCell {
  weekday: number; // 0-6 (0=domingo, local)
  hour: number; // 0-23 (local)
  count: number;
}
export interface PeakHours {
  cells: PeakHourCell[];
}
export interface RecurrenceBreakdown {
  new_count: number;
  returning_count: number;
  identified_visits: number;
  total_visits: number;
}
export interface SentimentBucket {
  emotion: string; // inclui "n/d"
  count: number;
}
export interface SentimentBreakdown {
  buckets: SentimentBucket[];
}
export interface MetricsOverview {
  days: 7 | 30;
  visits: VisitsFlow;
  peak: PeakHours;
  recurrence: RecurrenceBreakdown;
  sentiment: SentimentBreakdown;
}
