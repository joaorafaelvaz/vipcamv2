import type { ImageSourceConclusion, ImageSourceProbeReport, SourceMetrics } from "@vipcam/shared";

export type Thresholds = ImageSourceProbeReport["thresholds"];

export const DEFAULT_THRESHOLDS: Thresholds = {
  min_event_image_rate: 0.7,
  min_face_rate: 0.8,
  min_det_score: 0.5,
  min_bbox_px: 80,
  min_snapshot_image_rate: 0.95,
  max_snapshot_delta_ms: 2000,
  min_samples: 30,
};

export interface DecideArgs {
  faceEvents: number;
  metrics: SourceMetrics[];
  thresholds: Thresholds;
}
export interface Decision {
  conclusion: ImageSourceConclusion;
  evidence: string[];
  failover_b_recommendation: string;
}

const rate = (num: number, den: number) => (den > 0 ? num / den : 0);

export function decide(a: DecideArgs): Decision {
  const t = a.thresholds;
  const ev = a.metrics.find((m) => m.source === "event");
  const sn = a.metrics.find((m) => m.source === "snapshot");
  const evidence: string[] = [];

  if (a.faceEvents < t.min_samples) {
    return {
      conclusion: "inconclusive",
      evidence: [
        `Apenas ${a.faceEvents} eventos de face (< ${t.min_samples}). Repetir em horário de movimento.`,
      ],
      failover_b_recommendation:
        "Inconclusivo — re-rodar o probe com janela maior / horário de pico antes de decidir.",
    };
  }

  const evImgRate = ev ? rate(ev.with_image, ev.samples) : 0;
  const evFaceRate = ev ? rate(ev.usable_face, ev.with_image) : 0;
  evidence.push(
    `event: img_rate=${evImgRate.toFixed(2)} face_rate=${evFaceRate.toFixed(2)} bbox=${ev?.median_bbox_px ?? "—"}px`,
  );
  const aOk = evImgRate >= t.min_event_image_rate && evFaceRate >= t.min_face_rate;

  const snImgRate = sn ? rate(sn.with_image, sn.samples) : 0;
  const snFaceRate = sn ? rate(sn.usable_face, sn.with_image) : 0;
  const snAligned = sn?.median_delta_ms != null && sn.median_delta_ms <= t.max_snapshot_delta_ms;
  evidence.push(
    `snapshot: img_rate=${snImgRate.toFixed(2)} face_rate=${snFaceRate.toFixed(2)} Δ=${sn?.median_delta_ms ?? "—"}ms`,
  );
  const bOk =
    snImgRate >= t.min_snapshot_image_rate && snFaceRate >= t.min_face_rate && !!snAligned;

  if (aOk) {
    return {
      conclusion: "a_event_embedded",
      evidence,
      failover_b_recommendation:
        "Failover B: extrair a parte image/* do evento eventManager.cgi por detecção (fonte síncrona, sem round-trip extra).",
    };
  }
  if (bOk) {
    return {
      conclusion: "b_snapshot_cgi",
      evidence,
      failover_b_recommendation:
        "Failover B: disparar snapshot.cgi no evento de face (alinhamento temporal aceitável); embutir no pipeline pós-detecção.",
    };
  }

  const anyImages = (ev?.with_image ?? 0) > 0 || (sn?.with_image ?? 0) > 0;
  if (anyImages) {
    return {
      conclusion: "d_infeasible",
      evidence,
      failover_b_recommendation:
        "Failover B INVIÁVEL neste hardware: a câmera entrega imagens mas sem rosto utilizável (score/resolução). Reavaliar estratégia (câmera diferente / ângulo / outra abordagem de re-id).",
    };
  }
  return {
    conclusion: "c_recommend_rtsp_followup",
    evidence,
    failover_b_recommendation:
      "Nenhuma imagem via evento ou snapshot.cgi. Onda follow-up: probe de RTSP frame-grab no instante da detecção (não construída aqui).",
  };
}
