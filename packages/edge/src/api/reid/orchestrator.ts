import type { EmbedResult, ReidBBox, ReidStatus } from "@vipcam/shared";
import { getEnv } from "../../config/env.js";
import { embed } from "../../discovery/image-probe/reid-client.js";
import { logger } from "../../obs/logger.js";
import { decideMatch } from "./match-policy.js";

export interface ReidInput {
  cameraId: string;
  detectionId: string;
  detectedAt: Date;
  sessionId: string;
  bbox: ReidBBox;
  frameBytes: Buffer;
  sessionInheritedPersonId: string | null;
}

export interface ReidOutput {
  personId: string | null;
  status: ReidStatus;
  reidDistance?: number;
  reidError?: string;
  embedding?: EmbedResult;
  borderlineCandidate?: { face_record_id: string; person_id: string; distance: number };
}

/**
 * Orquestra reid para uma detection: embed + match + decide.
 * NÃO escreve no DB (caller é o pipeline). NÃO escreve em disco.
 *
 * Política de falha (Onda 7 §3.5):
 * 1. REID_ENABLED=false → status='disabled', skip embed.
 * 2. embed() throws → status='unavailable'. Se sessionInheritedPersonId
 *    presente, herda esse personId + status='inherited_session'.
 * 3. embed() ok + decideMatch → strict / borderline / new_person.
 */
export async function resolvePersonIdViaReid(input: ReidInput): Promise<ReidOutput> {
  const env = getEnv();
  if (!env.REID_ENABLED) {
    return { personId: null, status: "disabled" };
  }
  let emb: EmbedResult;
  try {
    emb = await embed(env.REID_BASE_URL, input.frameBytes, input.bbox);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg, detectionId: input.detectionId }, "reid embed failed");
    if (input.sessionInheritedPersonId) {
      return {
        personId: input.sessionInheritedPersonId,
        status: "inherited_session",
        reidError: msg,
      };
    }
    return { personId: null, status: "unavailable", reidError: msg };
  }

  const match = await decideMatch({
    embedding: emb.embedding,
    modelName: emb.model_name,
    modelRevision: emb.model_revision,
    strictMax: env.REID_DIST_STRICT,
    looseMax: env.REID_DIST_LOOSE,
  });

  if (match.decision === "strict") {
    return {
      personId: match.candidate!.person_id,
      status: "matched_strict",
      reidDistance: match.candidate!.distance,
      embedding: emb,
    };
  }
  if (match.decision === "borderline") {
    return {
      personId: null,
      status: "borderline",
      reidDistance: match.candidate!.distance,
      embedding: emb,
      borderlineCandidate: match.candidate!,
    };
  }
  return { personId: null, status: "new_person", embedding: emb };
}
