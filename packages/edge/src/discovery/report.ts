import type { DiscoveryReport, ProbeResult } from "@vipcam/shared";
import type { CapturedEvent } from "./capture.js";

interface BuildArgs {
  cameraIp: string;
  probes: ProbeResult[];
  capturedEvents: CapturedEvent[];
  captureDurationSeconds: number;
}

const EMOTION_KEYS = ["Emotion", "Expression", "Mood", "FaceExpression"];
const AGE_KEYS = ["Age", "AgeRange", "AgeGroup"];
const GENDER_KEYS = ["Gender", "Sex"];

function findInData(events: CapturedEvent[], keys: string[]): string[] {
  const found = new Set<string>();
  for (const e of events) {
    const data = e.parsed?.data;
    if (data && typeof data === "object" && data !== null) {
      const keysInData = Object.keys(data as Record<string, unknown>);
      for (const k of keysInData) {
        if (keys.some((target) => k.toLowerCase() === target.toLowerCase())) found.add(k);
      }
    }
  }
  return [...found];
}

function collectAttributeKeys(events: CapturedEvent[]): string[] {
  const set = new Set<string>();
  for (const e of events) {
    const data = e.parsed?.data;
    if (data && typeof data === "object" && data !== null) {
      for (const k of Object.keys(data as Record<string, unknown>)) set.add(k);
    }
  }
  return [...set].sort();
}

export function buildReport(args: BuildArgs): DiscoveryReport {
  const eventTypes: Record<string, number> = {};
  for (const e of args.capturedEvents) {
    const code = e.parsed?.code ?? "Unknown";
    eventTypes[code] = (eventTypes[code] ?? 0) + 1;
  }

  // Agrega dados de identificação dos probes magicBox.* dedicados.
  // Cada endpoint retorna um único par chave=valor mais confiável que parsear o getSystemInfo.
  const probeParsed = (name: string): Record<string, string> | undefined =>
    args.probes.find((p) => p.name === name)?.parsed as Record<string, string> | undefined;

  const sysInfo = probeParsed("magicBox.getSystemInfo") ?? {};
  const serialInfo = probeParsed("magicBox.getSerialNo") ?? {};
  const versionInfo = probeParsed("magicBox.getSoftwareVersion") ?? {};
  const deviceTypeInfo = probeParsed("magicBox.getDeviceType") ?? {};

  const cameraModel = deviceTypeInfo.type ?? deviceTypeInfo.deviceType ?? sysInfo.deviceType;
  const cameraSerial = serialInfo.sn ?? serialInfo.serialNumber ?? sysInfo.serialNumber;
  const firmware =
    versionInfo.version ??
    versionInfo.softwareVersion ??
    sysInfo.softwareVersion ??
    sysInfo.hardwareVersion;

  const ageMatches = findInData(args.capturedEvents, AGE_KEYS);
  const genderMatches = findInData(args.capturedEvents, GENDER_KEYS);
  const emotionMatches = findInData(args.capturedEvents, EMOTION_KEYS);

  const fork: string[] = [];
  if (emotionMatches.length === 0 && args.capturedEvents.length > 0) {
    fork.push(
      "Câmera não entregou atributo de emoção em payloads observados. Decidir entre 10.2(a) seguir só com idade/gênero ou 10.2(b) inferir emoção via sidecar (HSEmotion ONNX).",
    );
  }
  if (args.capturedEvents.length === 0) {
    fork.push(
      "Nenhum evento capturado durante o período. Verificar conectividade da câmera, eventos habilitados, ou aumentar duração da captura.",
    );
  }

  const report: DiscoveryReport = {
    generated_at: new Date().toISOString(),
    camera_ip: args.cameraIp,
    probes: args.probes,
    events_captured: args.capturedEvents.length,
    capture_duration_seconds: args.captureDurationSeconds,
    event_types_seen: eventTypes,
    attribute_keys_seen: collectAttributeKeys(args.capturedEvents),
    has_emotion_attribute: emotionMatches.length > 0,
    has_age_attribute: ageMatches.length > 0,
    has_gender_attribute: genderMatches.length > 0,
    recommended_ingest_channel: args.capturedEvents.length > 0 ? "http_attach_sse" : "unknown",
    fork_decision_required: fork,
  };
  if (cameraModel !== undefined) report.camera_model = cameraModel;
  if (cameraSerial !== undefined) report.camera_serial = cameraSerial;
  if (firmware !== undefined) report.firmware = firmware;
  return report;
}

const STATUS_ICON: Record<ProbeResult["status"], string> = {
  ok: "✅",
  not_found: "❌",
  auth_failed: "🔒",
  timeout: "⏱",
  error: "💥",
  skipped: "⏭",
};

export function renderMarkdown(r: DiscoveryReport): string {
  const lines: string[] = [];
  lines.push("# Discovery Report — DH-IPC-HFW5442T-ASE");
  lines.push("");
  lines.push(`**Gerado em:** ${r.generated_at}`);
  lines.push(`**Câmera IP:** ${r.camera_ip}`);
  if (r.camera_model) lines.push(`**Modelo:** ${r.camera_model}`);
  if (r.camera_serial) lines.push(`**Serial:** ${r.camera_serial}`);
  if (r.firmware) lines.push(`**Firmware:** ${r.firmware}`);
  lines.push("");

  lines.push("## Probes");
  lines.push("");
  lines.push("| Status | Probe | Endpoint | HTTP | Duração |");
  lines.push("|---|---|---|---|---|");
  for (const p of r.probes) {
    lines.push(
      `| ${STATUS_ICON[p.status]} ${p.status} | ${p.name} | \`${p.endpoint}\` | ${p.http_status ?? "—"} | ${p.duration_ms}ms |`,
    );
  }
  lines.push("");

  lines.push("## Captura de eventos");
  lines.push("");
  lines.push(`- **Duração:** ${r.capture_duration_seconds}s`);
  lines.push(`- **Eventos capturados:** ${r.events_captured}`);
  lines.push("- **Tipos de evento:**");
  for (const [code, count] of Object.entries(r.event_types_seen)) {
    lines.push(`  - \`${code}\`: ${count}`);
  }
  lines.push("");
  lines.push("- **Chaves de atributo vistas em payloads:**");
  for (const k of r.attribute_keys_seen) lines.push(`  - \`${k}\``);
  lines.push("");
  lines.push(`- **Idade:** ${r.has_age_attribute ? "✅ presente" : "❌ ausente"}`);
  lines.push(`- **Gênero:** ${r.has_gender_attribute ? "✅ presente" : "❌ ausente"}`);
  lines.push(`- **Emoção:** ${r.has_emotion_attribute ? "✅ presente" : "❌ ausente"}`);
  lines.push("");

  lines.push("## Recomendação de canal de ingest");
  lines.push("");
  lines.push(`**${r.recommended_ingest_channel}**`);
  lines.push("");

  if (r.fork_decision_required.length > 0) {
    lines.push("## Decisões pendentes");
    lines.push("");
    for (const d of r.fork_decision_required) lines.push(`- ⚠ ${d}`);
    lines.push("");
  }

  return lines.join("\n");
}
