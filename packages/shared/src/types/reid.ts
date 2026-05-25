/** Saída de POST /embed do sidecar vipcam-reid (Onda 7 §3.1). */
export interface EmbedResult {
  /** Vetor 512-d normalizado (cosine-friendly). */
  embedding: number[];
  /** Confiança da detecção pós-crop (0..1). */
  det_score: number;
  infer_ms: number;
  model_name: string;
  model_revision: string;
  /** Crop reencoded JPEG q=85, base64-encoded. Edge decodifica e escreve em
   * disco via saveCrop (Onda 7 §2.1 — crop, não frame inteiro). */
  crop_jpeg_b64: string;
}

/**
 * Bbox em pixels inteiros para o sidecar reid (Onda 7 §3.1).
 *
 * Distinto de `BBox` em ingest-events.ts, que é normalizado 0..1 vindo do
 * evento Dahua. O sidecar Python espera **inteiros** (FastAPI `Form(...)`
 * com type `int` rejeita floats), então o caller no edge deve aplicar
 * `Math.floor()` em cada componente após desnormalizar pela resolução do
 * frame antes de chamar `embed()`.
 */
export interface ReidBBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Status do pipeline reid populado em detections.face_attrs.reid_status. */
export type ReidStatus =
  | "matched_strict" // auto-link a person existente
  | "borderline" // pediu revisão humana
  | "new_person" // criou anonymous nova
  | "unavailable" // sidecar down — graceful degrade
  | "inherited_session" // herdou person_id de detection prévia da mesma sessão
  | "disabled"; // REID_ENABLED=false
