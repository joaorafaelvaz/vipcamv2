export type ProbeStatus = "ok" | "auth_failed" | "not_found" | "timeout" | "error" | "skipped";

export interface ProbeResult {
  name: string; // "magicBox.getSystemInfo"
  endpoint: string; // "/cgi-bin/magicBox.cgi?action=getSystemInfo"
  status: ProbeStatus;
  http_status?: number;
  duration_ms: number;
  raw_response_excerpt?: string; // primeiros 1000 chars
  error?: string;
  parsed?: unknown; // se conseguimos extrair algo estruturado
}

export interface DiscoveryReport {
  generated_at: string; // ISO
  camera_ip: string;
  camera_model?: string; // se conseguir extrair
  camera_serial?: string;
  firmware?: string;
  probes: ProbeResult[];
  events_captured: number;
  capture_duration_seconds: number;
  event_types_seen: Record<string, number>; // type -> count
  attribute_keys_seen: string[]; // chaves vistas em payloads de face
  has_emotion_attribute: boolean;
  has_age_attribute: boolean;
  has_gender_attribute: boolean;
  recommended_ingest_channel: "http_attach_sse" | "polling" | "onvif" | "unknown";
  fork_decision_required: string[]; // ex: "câmera não entrega emoção — escolher entre 10.2(a) e 10.2(b) da spec"
}
