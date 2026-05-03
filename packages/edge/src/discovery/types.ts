import type { ProbeResult } from "@vipcam/shared";
import type { DahuaHttpClient } from "../ingest/dahua-http-client.js";

export type ProbeFn = (client?: DahuaHttpClient) => Promise<ProbeResult>;
