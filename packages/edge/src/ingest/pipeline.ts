import type { CanonicalEvent, LiveDetectionEvent } from "@vipcam/shared";
import { eventBus } from "../api/events/event-bus.js";
import type { CapturedEvent } from "../discovery/capture.js";
import { logger } from "../obs/logger.js";
import { detectionsRepo, sessionsRepo } from "../persistence/repositories/index.js";
import { normalize } from "./normalizer.js";
import { shouldStartNewSession } from "./session-tracker.js";

const SESSION_GAP_MS = 30_000;

/**
 * Resolve person_id automático via reconhecimento facial.
 *
 * ⚠ Pós-Discovery 2026-05-11: SEMPRE retorna null nesta Onda 2.
 * - Estratégia A (Face DB câmera): refutada — câmera DH-IPC-HFW5442T-ASE
 *   não tem Face DB embarcado via CGI.
 * - Estratégia B (InsightFace local): adiada para Onda 3.
 *
 * Vínculo cliente↔detecção acontece via match temporal contra checkin do ERP
 * (Chunk 4). Funcionários ficam sem reconhecimento facial nesta Onda 2.
 */
async function resolvePersonId(_event: CanonicalEvent): Promise<string | null> {
  return null;
}

/**
 * Resolve session_id: reusa sessão aberta se gap < 30s para o mesmo (camera, track),
 * senão abre nova.
 */
async function resolveSessionId(
  event: CanonicalEvent,
  personId: string | null,
  detectedAt: Date,
): Promise<string> {
  const existing = event.track_id
    ? await sessionsRepo.findOpenForTrack(
        event.camera_id,
        event.track_id,
        detectedAt,
        SESSION_GAP_MS,
      )
    : null;

  if (existing && !shouldStartNewSession(existing.last_seen_at, detectedAt, SESSION_GAP_MS)) {
    await sessionsRepo.appendDetection(existing.id, detectedAt);
    return existing.id;
  }

  const newSession: Parameters<typeof sessionsRepo.create>[0] = {
    camera_id: event.camera_id,
    person_id: personId,
    started_at: detectedAt,
    last_seen_at: detectedAt,
    detection_count: 1,
  };
  if (event.track_id !== undefined) newSession.current_track_id = event.track_id;
  const created = await sessionsRepo.create(newSession);
  return created.id;
}

/**
 * Processa um evento bruto da câmera: normaliza, resolve identidade, persiste.
 * Falhas em uma etapa NÃO derrubam o pipeline (try/catch granular).
 */
export async function processEvent(raw: CapturedEvent, cameraId: string): Promise<void> {
  // Try/catch envolvendo TUDO — listener faz fire-and-forget (`void processEvent`),
  // qualquer throw aqui viraria unhandled rejection. Spec §8.2.1: falha localizada
  // nunca derruba o sistema.
  try {
    const event = normalize(raw, cameraId);
    if (!event) return;

    // face.detected.stop é sinal pro tracker (caller pode usar pra fechar sessões),
    // mas não cria nova detection — só Start cria registro.
    // TODO(onda-3): wire face.detected.stop a sessionsRepo.close() para o
    // (camera_id, track_id) correspondente — atualmente sessões abertas não
    // fecham (mitigação: gap-based auto-expiration via findOpenForTrack cutoff).
    if (event.type === "face.detected.stop") {
      logger.debug({ track_id: event.track_id }, "face.detected.stop — no detection persisted");
      return;
    }

    const detectedAt = new Date(event.detected_at);
    const personId = await resolvePersonId(event);
    const sessionId = await resolveSessionId(event, personId, detectedAt);

    // face_attrs guarda atributos PARSED (age, gender, emotion, etc.).
    // raw_event guarda payload bruto Dahua para auditoria.
    // NÃO duplicar — face_attrs.raw é descartado aqui.
    const parsedAttrs: Record<string, unknown> = {};
    if (event.face_attrs) {
      const { raw: _raw, ...rest } = event.face_attrs;
      Object.assign(parsedAttrs, rest);
    }

    const detection: Parameters<typeof detectionsRepo.create>[0] = {
      camera_id: event.camera_id,
      person_id: personId,
      session_id: sessionId,
      face_attrs: parsedAttrs,
      detected_at: detectedAt,
      raw_event: event.raw_event,
    };
    if (event.track_id !== undefined) detection.track_id = event.track_id;
    if (event.bbox !== undefined) detection.bbox = event.bbox;
    if (event.face_attrs?.emotion !== undefined) {
      detection.dominant_emotion = event.face_attrs.emotion;
    }
    // emotion_confidence: Dahua entrega Express (intensidade 0-100), não probabilidade.
    // Mapeamos como proxy: emotion_confidence = Express / 100 para ficar em 0-1.
    if (event.face_attrs?.emotion_intensity !== undefined) {
      detection.emotion_confidence = event.face_attrs.emotion_intensity / 100;
    }
    if (event.snapshot_path !== undefined) detection.snapshot_path = event.snapshot_path;

    const created = await detectionsRepo.create(detection);
    // Atualiza rollup dominant_emotion da sessão APÓS o insert da detection
    // (subquery em sessions.recalcDominantEmotion precisa ver a nova linha).
    // Skip se a detection nem teve emoção populada — evita query desnecessária.
    if (detection.dominant_emotion) {
      await sessionsRepo.recalcDominantEmotion(sessionId);
    }

    // Onda 3 Task 3.2.5: publica detection no event bus pro live feed (SSE).
    // Não-bloqueante: try/catch isolado evita que falha de subscriber derrube
    // o pipeline. person identification em Onda 4 (failover B InsightFace).
    try {
      const liveEvent: LiveDetectionEvent = {
        type: "detection",
        detection: {
          id: created.id,
          detected_at: created.detected_at.toISOString(),
          snapshot_path: created.snapshot_path,
          face_attrs: created.face_attrs as Record<string, unknown>,
          dominant_emotion: created.dominant_emotion,
          emotion_confidence: created.emotion_confidence,
          session_id: created.session_id,
          camera_id: created.camera_id,
        },
        person: null,
      };
      eventBus.publish(liveEvent);
    } catch (err) {
      logger.warn({ err }, "event bus publish failed — ingest continues");
    }

    logger.debug({ event: event.type, personId, sessionId }, "ingest persisted");
  } catch (err) {
    logger.error({ err, raw }, "ingest pipeline failed for event");
    // Não relançar: pipeline continua para próximos eventos
  }
}
