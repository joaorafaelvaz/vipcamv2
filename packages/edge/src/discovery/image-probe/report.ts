import type { ImageSourceProbeReport, SourceMetrics } from "@vipcam/shared";
import { type Thresholds, decide } from "./decision.js";

export interface BuildReportArgs {
  runId: string;
  faceEvents: number;
  metrics: SourceMetrics[];
  thresholds: Thresholds;
}

export function buildImageSourceReport(a: BuildReportArgs): ImageSourceProbeReport {
  const d = decide({ faceEvents: a.faceEvents, metrics: a.metrics, thresholds: a.thresholds });
  return {
    generated_at: new Date().toISOString(),
    run_id: a.runId,
    thresholds: a.thresholds,
    face_events_captured: a.faceEvents,
    metrics: a.metrics,
    conclusion: d.conclusion,
    evidence: d.evidence,
    failover_b_recommendation: d.failover_b_recommendation,
  };
}

const CONCLUSION_LABEL: Record<ImageSourceProbeReport["conclusion"], string> = {
  a_event_embedded: "(a) imagem embutida no evento eventManager.cgi",
  b_snapshot_cgi: "(b) snapshot.cgi alinhado ao evento",
  c_recommend_rtsp_followup: "(c) recomenda follow-up RTSP frame-grab",
  d_infeasible: "(d) INVIÁVEL neste hardware",
  inconclusive: "inconclusivo (amostra insuficiente)",
};

export function renderDecisionMarkdown(r: ImageSourceProbeReport): string {
  const L: string[] = [];
  L.push("# Camera Image-Source Probe — Decisão (gate Failover B)");
  L.push("");
  L.push(`**Gerado em:** ${r.generated_at}`);
  L.push(`**Run:** ${r.run_id}`);
  L.push(`**Eventos de face capturados:** ${r.face_events_captured}`);
  L.push("");
  L.push(`## Conclusão: ${CONCLUSION_LABEL[r.conclusion]}`);
  L.push("");
  L.push(`> ${r.failover_b_recommendation}`);
  L.push("");
  L.push("## Thresholds usados");
  L.push("");
  L.push("| Parâmetro | Valor |");
  L.push("|---|---|");
  for (const [k, v] of Object.entries(r.thresholds)) L.push(`| ${k} | ${v} |`);
  L.push("");
  L.push("## Métricas por fonte");
  L.push("");
  L.push(
    "| Fonte | Amostras | Com imagem | Rosto utilizável | bbox mediano px | infer mediano ms | Δ mediano ms |",
  );
  L.push("|---|---|---|---|---|---|---|");
  for (const m of r.metrics) {
    L.push(
      `| ${m.source} | ${m.samples} | ${m.with_image} | ${m.usable_face} | ${m.median_bbox_px ?? "—"} | ${m.median_infer_ms ?? "—"} | ${m.median_delta_ms ?? "—"} |`,
    );
  }
  L.push("");
  L.push("## Evidência");
  L.push("");
  for (const e of r.evidence) L.push(`- ${e}`);
  L.push("");
  L.push("## Limpeza (operacional/disco)");
  L.push("");
  L.push(
    "- Após registrar a decisão, apague as amostras capturadas (imagens de clientes reais; sem propósito pós-decisão — LGPD é débito separado).",
  );
  L.push("");
  return L.join("\n");
}
