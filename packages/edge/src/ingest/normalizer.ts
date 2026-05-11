import type { CanonicalEvent, FaceAttributes } from "@vipcam/shared";
import type { CapturedEvent } from "../discovery/capture.js";

const FACE_DETECTION_CODES = new Set(["FaceDetection"]);

/** Escala fixed-point dos BoundingBox da Dahua. Validar empiricamente em produção. */
const BBOX_FIXED_POINT_SCALE = 8192;

function parseGender(sex: unknown, gender: unknown): FaceAttributes["gender"] {
  if (typeof sex === "string") {
    const v = sex.toLowerCase();
    if (v === "man" || v === "male" || v === "m") return "male";
    if (v === "woman" || v === "female" || v === "f") return "female";
  }
  // Fallback no campo numérico Gender (1=male, 2=female em algumas versões; verificar)
  if (typeof gender === "number") {
    if (gender === 1) return "male";
    if (gender === 2) return "female";
  }
  return undefined;
}

function parseBbox(raw: unknown): CanonicalEvent["bbox"] {
  if (!Array.isArray(raw) || raw.length !== 4) return undefined;
  const [x1, y1, x2, y2] = raw.map(Number);
  if (
    x1 === undefined ||
    y1 === undefined ||
    x2 === undefined ||
    y2 === undefined ||
    !Number.isFinite(x1) ||
    !Number.isFinite(y1) ||
    !Number.isFinite(x2) ||
    !Number.isFinite(y2)
  ) {
    return undefined;
  }
  return {
    x: x1 / BBOX_FIXED_POINT_SCALE,
    y: y1 / BBOX_FIXED_POINT_SCALE,
    w: (x2 - x1) / BBOX_FIXED_POINT_SCALE,
    h: (y2 - y1) / BBOX_FIXED_POINT_SCALE,
  };
}

function dahuaBoolean(raw: unknown, trueValue = 2): boolean | undefined {
  // Dahua usa 1/2 para muitos atributos boolean (1=No, 2=Yes ou 1=closed, 2=open)
  if (typeof raw !== "number") return undefined;
  return raw === trueValue;
}

function extractAttrs(obj: Record<string, unknown>): FaceAttributes {
  const attrs: FaceAttributes = { raw: obj };
  const age = Number(obj.Age);
  if (Number.isFinite(age) && age > 0) attrs.age = age;

  const gender = parseGender(obj.Sex, obj.Gender);
  if (gender) attrs.gender = gender;

  if (typeof obj.Emotion === "string") attrs.emotion = obj.Emotion;
  if (typeof obj.Express === "number") attrs.emotion_intensity = obj.Express;

  // Acessórios / oclusão
  const glasses = dahuaBoolean(obj.Glass);
  if (glasses !== undefined) attrs.glasses = glasses;
  const mask = dahuaBoolean(obj.Mask);
  if (mask !== undefined) attrs.mask = mask;
  const beard = dahuaBoolean(obj.Beard);
  if (beard !== undefined) attrs.beard = beard;
  const mouthOpen = dahuaBoolean(obj.Mouth);
  if (mouthOpen !== undefined) attrs.mouth_open = mouthOpen;
  const eyesOpen = dahuaBoolean(obj.Eye);
  if (eyesOpen !== undefined) attrs.eyes_open = eyesOpen;

  // Qualidade
  if (typeof obj.Confidence === "number") attrs.confidence = obj.Confidence;
  if (typeof obj.FaceQuality === "number") attrs.face_quality = obj.FaceQuality;

  // Geometria
  if (Array.isArray(obj.Angle) && obj.Angle.length === 3) {
    const [pitch, yaw, roll] = (obj.Angle as unknown[]).map(Number);
    if (pitch !== undefined && Number.isFinite(pitch)) attrs.pitch_deg = pitch;
    if (yaw !== undefined && Number.isFinite(yaw)) attrs.yaw_deg = yaw;
    if (roll !== undefined && Number.isFinite(roll)) attrs.roll_deg = roll;
  }

  return attrs;
}

export function normalize(raw: CapturedEvent, cameraId: string): CanonicalEvent | null {
  const code = raw.parsed?.code;
  const action = raw.parsed?.action;
  const data = raw.parsed?.data;
  if (!code || !FACE_DETECTION_CODES.has(code)) return null;
  if (action !== "Start" && action !== "Stop") return null;
  if (!data || typeof data !== "object") return null;
  const dataObj = data as Record<string, unknown>;

  // Atributos vêm de data.Object (singular). data.Faces[] e data.Objects[] são
  // arrays com a mesma info, mas Object é onde Dahua coloca o detalhamento completo.
  const objectField = dataObj.Object;
  if (!objectField || typeof objectField !== "object") return null;
  const obj = objectField as Record<string, unknown>;

  const trackId = obj.ObjectID !== undefined ? String(obj.ObjectID) : undefined;
  const bbox = parseBbox(obj.BoundingBox);
  const attrs = extractAttrs(obj);

  // Timestamp: prefere RealUTC do payload (relógio confiável da câmera) sobre received_at
  let detectedAt = raw.received_at;
  const realUtc = dataObj.RealUTC;
  if (typeof realUtc === "number" && realUtc > 0) {
    detectedAt = new Date(realUtc * 1000).toISOString();
  }

  const event: CanonicalEvent = {
    type: action === "Start" ? "face.detected.start" : "face.detected.stop",
    camera_id: cameraId,
    detected_at: detectedAt,
    raw_event: dataObj,
  };
  if (trackId !== undefined) event.track_id = trackId;
  if (bbox !== undefined) event.bbox = bbox;
  // face_attrs sempre presente em FaceDetection
  event.face_attrs = attrs;
  return event;
}
