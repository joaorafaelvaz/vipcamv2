import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiscoveryReport } from "@vipcam/shared";
import { DahuaHttpClient } from "../ingest/dahua-http-client.js";
import { logger } from "../obs/logger.js";
import { captureEvents } from "./capture.js";
import { runProbes } from "./prober.js";
import { makeFaceInfoProbes } from "./probes/face-info.js";
import { makeFaceRecognitionProbes } from "./probes/face-recognition.js";
import { makeMagicBoxProbes } from "./probes/magic-box.js";
import { makeSnapshotProbe } from "./probes/snapshot.js";
import { buildReport, renderMarkdown } from "./report.js";

export interface RunDiscoveryArgs {
  cameraIp: string;
  cameraUser: string;
  cameraPass: string;
  captureSeconds?: number;
  outputDir?: string;
}

export interface RunDiscoveryResult {
  report: DiscoveryReport;
  jsonPath: string;
  markdownPath: string;
  capturesDir: string;
}

const DEFAULT_OUTPUT_DIR = () => join(process.cwd(), "discovery-output");

export async function runDiscovery(args: RunDiscoveryArgs): Promise<RunDiscoveryResult> {
  const captureSeconds = args.captureSeconds ?? 600; // 10 min default
  const outputDir = args.outputDir ?? DEFAULT_OUTPUT_DIR();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(outputDir, `run-${ts}`);
  await mkdir(runDir, { recursive: true });

  const client = new DahuaHttpClient({
    baseUrl: `http://${args.cameraIp}`,
    username: args.cameraUser,
    password: args.cameraPass,
  });

  const probes = [
    ...makeMagicBoxProbes(),
    makeSnapshotProbe(),
    ...makeFaceInfoProbes(),
    ...makeFaceRecognitionProbes(),
  ];

  logger.info({ count: probes.length }, "running probes");
  const probeResults = await runProbes(probes, client);

  logger.info({ captureSeconds }, "starting event capture");
  const capture = await captureEvents(client, captureSeconds, runDir);

  const report = buildReport({
    cameraIp: args.cameraIp,
    probes: probeResults,
    capturedEvents: capture.events,
    captureDurationSeconds: capture.duration_seconds,
  });

  const jsonPath = join(runDir, "report.json");
  const markdownPath = join(runDir, "report.md");
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(markdownPath, renderMarkdown(report), "utf8");

  logger.info({ jsonPath, markdownPath }, "discovery complete");
  return { report, jsonPath, markdownPath, capturesDir: runDir };
}

export async function getLatestReport(outputDir?: string): Promise<DiscoveryReport | null> {
  const dir = outputDir ?? DEFAULT_OUTPUT_DIR();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const runs = entries
    .filter((e) => e.startsWith("run-"))
    .sort()
    .reverse();
  const latest = runs[0];
  if (!latest) return null;
  const reportPath = join(dir, latest, "report.json");
  try {
    const text = await readFile(reportPath, "utf8");
    return JSON.parse(text) as DiscoveryReport;
  } catch {
    return null;
  }
}
