import type { CanonicalEvent, LiveDetectionEvent } from "@vipcam/shared";
import { eventBus } from "../api/events/event-bus.js";
import {
  type ReidInput,
  type ReidOutput,
  resolvePersonIdViaReid,
} from "../api/reid/orchestrator.js";
import { saveCrop } from "../api/reid/snapshot-store.js";
import { getEnv } from "../config/env.js";
import type { CapturedEvent } from "../discovery/capture.js";
import { logger } from "../obs/logger.js";
import {
  detectionsRepo,
  faceRecordsRepo,
  personsRepo,
  reidMatchAttemptsRepo,
  sessionsRepo,
} from "../persistence/repositories/index.js";
import { normalize } from "./normalizer.js";
import { shouldStartNewSession } from "./session-tracker.js";

const SESSION_GAP_MS = 30_000;

export interface ProcessEventDeps {
  /** Closure que captura frame inteiro via snapshot.cgi. Injetada pelo
   * listener (que tem o DahuaHttpClient). Quando undefined (ex: testes
   * sem câmera), reid é skipado e detection vai sem snapshot. */
  captureSnapshot?: () => Promise<Buffer>;
  /** Override do orchestrator — útil em testes pra evitar mockar
   * `src/api/reid/orchestrator.js` (mock.module em bun:test é
   * process-wide e vaza pra orchestrator.test.ts). Default: real impl. */
  resolveReid?: (input: ReidInput) => Promise<ReidOutput>;
}

/**
 * Processa um evento bruto da câmera: normaliza, captura snapshot, roda
 * reid orchestrator, persiste detection + face_record + reid_match_attempt
 * conforme a decisão. Falhas em uma etapa NÃO derrubam o pipeline
 * (try/catch envolve tudo — listener faz fire-and-forget).
 *
 * Onda 7 §2.5 (sync sequencial), §3.5 (reid_status), §5.5 (REID_ENABLED).
 */
export async function processEvent(
  raw: CapturedEvent,
  cameraId: string,
  deps: ProcessEventDeps = {},
): Promise<void> {
  // Try/catch envolvendo TUDO — listener faz fire-and-forget (`void processEvent`),
  // qualquer throw aqui viraria unhandled rejection. Spec §8.2.1: falha localizada
  // nunca derruba o sistema.
  try {
    const event = normalize(raw, cameraId);
    if (!event) return;

    // face.detected.stop é sinal pro tracker (caller pode usar pra fechar sessões),
    // mas não cria nova detection — só Start cria registro.
    if (event.type === "face.detected.stop") {
      logger.debug({ track_id: event.track_id }, "face.detected.stop — no detection persisted");
      return;
    }

    const detectedAt = new Date(event.detected_at);
    // SINGLE call — retorna sessionId E inheritedPersonId (sessão prévia ABERTA).
    // Anti redundant query: o caller do reid orchestrator precisa do
    // sessionInheritedPersonId pro fallback de session-inheritance (Onda 7 §3.5).
    const { sessionId, inheritedPersonId } = await resolveSessionIdWithAnchor(event, detectedAt);

    // Snapshot capture + reid orchestration — apenas se temos bbox E captureSnapshot.
    // Sem captureSnapshot (testes / config sem câmera), reid é skipado mas o
    // pipeline continua e persiste detection vanilla.
    let snapshotPath: string | null = null;
    let reidOut: ReidOutput | null = null;
    const detectionId = crypto.randomUUID();
    if (event.bbox && deps.captureSnapshot) {
      try {
        const frameBytes = await deps.captureSnapshot();
        const resolve = deps.resolveReid ?? resolvePersonIdViaReid;
        // Onda 7 §3.1: event.bbox vem normalizado 0..1 (normalizer divide
        // pelo BBOX_FIXED_POINT_SCALE). Sidecar /embed espera pixel ints
        // (FastAPI Form(int) rejeita "0.234"). Denormaliza via env (default
        // 2688x1520 conforme Onda 6 probe — DH-IPC-HFW5442T-ASE).
        const env = getEnv();
        const pxBbox = {
          x: Math.floor(event.bbox.x * env.CAMERA_FRAME_WIDTH),
          y: Math.floor(event.bbox.y * env.CAMERA_FRAME_HEIGHT),
          w: Math.floor(event.bbox.w * env.CAMERA_FRAME_WIDTH),
          h: Math.floor(event.bbox.h * env.CAMERA_FRAME_HEIGHT),
        };
        reidOut = await resolve({
          cameraId: event.camera_id,
          detectionId,
          detectedAt,
          sessionId,
          bbox: pxBbox,
          frameBytes,
          sessionInheritedPersonId: inheritedPersonId,
        });
        // Onda 7 §2.1: escreve o CROP devolvido pelo sidecar (não frame inteiro).
        // Sem embedding (reid disabled/falhou) → skip write — UI mostra placeholder.
        if (reidOut.embedding?.crop_jpeg_b64) {
          const cropBytes = Buffer.from(reidOut.embedding.crop_jpeg_b64, "base64");
          snapshotPath = await saveCrop({
            baseDir: getEnv().SNAPSHOTS_DIR,
            detectionId,
            detectedAt,
            jpegBytes: cropBytes,
          });
        }
      } catch (err) {
        logger.warn({ err, detectionId }, "snapshot/reid pipeline error — degrading");
      }
    }

    // Decide person_id final + side-effects de person:
    // - new_person: cria anonymous, usa o id retornado.
    // - matched_strict: registra avistamento (visita nova só se gap > VISIT_GAP_HOURS — Onda 11).
    // - inherited_session / borderline / disabled / unavailable: nada a fazer.
    let personId: string | null = reidOut?.personId ?? null;
    if (reidOut?.status === "new_person") {
      const created = await personsRepo.create({
        person_type: "anonymous",
        first_seen_at: detectedAt,
        last_seen_at: detectedAt,
      });
      personId = created.id;
    } else if (reidOut?.status === "matched_strict" && personId) {
      await personsRepo.recordSighting(personId, detectedAt, getEnv().VISIT_GAP_HOURS);
    }

    // face_attrs guarda atributos PARSED (age, gender, emotion, etc.) +
    // reid metadata (status, distance, error). raw_event guarda payload
    // bruto Dahua para auditoria. NÃO duplicar — face_attrs.raw é descartado.
    const parsedAttrs: Record<string, unknown> = {};
    if (event.face_attrs) {
      const { raw: _raw, ...rest } = event.face_attrs;
      Object.assign(parsedAttrs, rest);
    }
    if (reidOut) {
      parsedAttrs.reid_status = reidOut.status;
      if (reidOut.reidDistance !== undefined) parsedAttrs.reid_distance = reidOut.reidDistance;
      if (reidOut.reidError) parsedAttrs.reid_error = reidOut.reidError;
      // Onda 7.1: rastreia se reid veio do crop bbox ou fallback frame inteiro.
      if (reidOut.embedding?.source) parsedAttrs.reid_source = reidOut.embedding.source;
    }

    const detection: Parameters<typeof detectionsRepo.create>[0] = {
      id: detectionId,
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
    if (snapshotPath) detection.snapshot_path = snapshotPath;

    const created = await detectionsRepo.create(detection);

    // face_record só com strict ou new_person — borderline NÃO escreve face_record
    // (espera decisão humana). E só com snapshot persistido — embedding sem imagem
    // visualizável é débito (Onda 7 §2.1: orphan embeddings proibidos).
    if (
      reidOut?.embedding &&
      (reidOut.status === "matched_strict" || reidOut.status === "new_person") &&
      personId &&
      snapshotPath
    ) {
      await faceRecordsRepo.insertAndEvict({
        person_id: personId,
        embedding: reidOut.embedding.embedding,
        snapshot_path: snapshotPath,
        det_score: reidOut.embedding.det_score,
        model_name: reidOut.embedding.model_name,
        model_revision: reidOut.embedding.model_revision,
        is_primary: reidOut.status === "new_person",
        source: "live_detection",
      });
    }

    // reid_match_attempt(ambiguous) só em borderline — fila pra revisão humana
    // via UI /matches (Onda 7 §5.5).
    if (reidOut?.status === "borderline" && reidOut.borderlineCandidate) {
      await reidMatchAttemptsRepo.createAmbiguous({
        detection_id: created.id,
        candidate_face_record_id: reidOut.borderlineCandidate.face_record_id,
        candidate_person_id: reidOut.borderlineCandidate.person_id,
        distance: reidOut.borderlineCandidate.distance,
      });
    }

    // Atualiza rollup dominant_emotion da sessão APÓS o insert da detection
    // (subquery em sessions.recalcDominantEmotion precisa ver a nova linha).
    // Skip se a detection nem teve emoção populada — evita query desnecessária.
    if (detection.dominant_emotion) {
      await sessionsRepo.recalcDominantEmotion(sessionId);
    }

    // event-bus dormente (Onda 8: SSE removido, publish ainda existe sem consumer)
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

/**
 * Helper privado — UMA query a findOpenForTrack devolvendo TANTO o sessionId
 * que vamos usar quanto o personId herdável (de detection prévia da MESMA
 * sessão aberta) pro session-inheritance fallback do reid (Onda 7 §3.5).
 *
 * Limitação documentada: se a sessão é nova (não existe sessão aberta pro
 * track), inheritedPersonId = null — não há previous-detection pra herdar.
 */
async function resolveSessionIdWithAnchor(
  event: CanonicalEvent,
  detectedAt: Date,
): Promise<{ sessionId: string; inheritedPersonId: string | null }> {
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
    return { sessionId: existing.id, inheritedPersonId: existing.person_id ?? null };
  }
  const newSession: Parameters<typeof sessionsRepo.create>[0] = {
    camera_id: event.camera_id,
    person_id: null,
    started_at: detectedAt,
    last_seen_at: detectedAt,
    detection_count: 1,
  };
  if (event.track_id !== undefined) newSession.current_track_id = event.track_id;
  const created = await sessionsRepo.create(newSession);
  return { sessionId: created.id, inheritedPersonId: null };
}
