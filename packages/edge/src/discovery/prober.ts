import type { ProbeResult } from "@vipcam/shared";
import { logger } from "../obs/logger.js";
import type { ProbeFn } from "./types.js";
import type { DahuaHttpClient } from "../ingest/dahua-http-client.js";

export async function runProbes(
  probes: ProbeFn[],
  client?: DahuaHttpClient,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const probe of probes) {
    try {
      const r = await probe(client);
      results.push(r);
      logger.debug({ probe: r.name, status: r.status }, "probe completed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        name: probe.name || "anonymous-probe",
        endpoint: "(unknown)",
        status: "error",
        duration_ms: 0,
        error: message,
      });
      logger.warn({ err }, "probe threw");
    }
  }
  return results;
}
