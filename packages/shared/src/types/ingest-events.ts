import type { ISO8601 } from "./index.js";

/**
 * Evento canônico do domínio, agnóstico do fabricante da câmera.
 * Normalizers (Dahua hoje, possivelmente Hikvision/Axis no futuro) produzem isso.
 *
 * Após Discovery 2026-05-11: o tipo "face.recognized" foi REMOVIDO porque
 * a câmera DH-IPC-HFW5442T-ASE não tem Face DB embarcado (P3+P4 refutadas).
 * Reconhecimento entre sessões fica para Onda 3 (failover B com InsightFace).
 */
export type CanonicalEventType =
  | "face.detected.start" // Face entrou em frame (action=Start)
  | "face.detected.stop"; // Face saiu de frame (action=Stop)

export interface FaceAttributes {
  // Demografia
  age?: number; // exato (Dahua entrega 1-100)
  gender?: "male" | "female" | "unknown"; // mapeado de Sex (string)
  // Emoção
  emotion?: string; // "Calm"|"Happy"|"Sad"|"Angry"|"Surprise"|"Disgust"|"Fear"|"Confused"|"Neutral"
  emotion_intensity?: number; // 0-100 (do campo Express)
  // Acessórios / oclusão (booleanos derivados de campos numéricos Dahua)
  glasses?: boolean; // Glass: 1=NoGlasses, 2=WearGlasses
  mask?: boolean; // Mask: 1=No, 2=Yes
  beard?: boolean; // Beard: 1=No, 2=Yes
  mouth_open?: boolean; // Mouth: 1=closed, 2=open
  eyes_open?: boolean; // Eye: 1=closed, 2=open
  // Qualidade da detecção
  confidence?: number; // 0-255
  face_quality?: number; // 0-100 (filtro recomendado: >= 40)
  // Geometria da face (útil pra qualidade de snapshot e re-id futura)
  pitch_deg?: number; // Angle[0]
  yaw_deg?: number; // Angle[1]
  roll_deg?: number; // Angle[2]
  // Permite ingest preservar atributos não-mapeados
  raw?: Record<string, unknown>;
}

export interface BBox {
  // Pixels normalizados para 0-1 (independente da escala fixed-point original).
  // Multiplicar pela resolução do snapshot pra obter pixels reais.
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CanonicalEvent {
  type: CanonicalEventType;
  camera_id: string; // UUID interno (não o ID do manufacturer)
  detected_at: ISO8601;
  // Track ID dentro da sessão (estável enquanto pessoa visível; Dahua: ObjectID)
  track_id?: string;
  bbox?: BBox;
  face_attrs?: FaceAttributes;
  snapshot_path?: string; // path local ou URL da snapshot, se disponível
  raw_event: Record<string, unknown>; // payload original (Dahua nested data.*)
}
