/**
 * Onda 9-B — production wiring do employee-face-seeder.
 *
 * Separa "logic" (employee-face-seeder.ts, deps-injected pure-ish) de
 * "wiring" (este arquivo: real HTTP + repo calls + fs). Permite testar
 * a logic sem mockar `fetch` global ou `mkdir`/`writeFile`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { embed as reidEmbed } from "../discovery/image-probe/reid-client.js";
import { faceRecordsRepo, personsRepo } from "../persistence/repositories/index.js";
import type {
  EmbedFaceResult,
  FetchResult,
  SeederDeps,
} from "./employee-face-seeder.js";

/** Classifica erro do fetch global pra mapear no FetchResult.error.
 * Exportada pra unit-testabilidade. */
export function classifyFetchError(err: Error & { name?: string; code?: string }): {
  kind: "timeout" | "dns" | "network";
  detail?: string;
} {
  if (err.name === "TimeoutError" || err.name === "AbortError") {
    return { kind: "timeout" };
  }
  if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") {
    return { kind: "dns" };
  }
  return { kind: "network", detail: err.message };
}

/**
 * Fetch real da foto via global fetch + AbortSignal.timeout. Defensive
 * timeout (10s default) — ERP web app geralmente responde <500ms.
 */
export async function fetchPhotoLive(absoluteUrl: string, timeoutMs = 10_000): Promise<FetchResult> {
  let response: Response;
  try {
    response = await fetch(absoluteUrl, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const { kind, detail } = classifyFetchError(err as Error & { name?: string; code?: string });
    return detail !== undefined
      ? { ok: false, error: kind, detail }
      : { ok: false, error: kind };
  }
  if (!response.ok) {
    return { ok: false, statusCode: response.status };
  }
  const jpegBuf = Buffer.from(await response.arrayBuffer());
  return { ok: true, jpegBuf };
}

/**
 * Chama sidecar reid /embed com bbox oversize (HACK §5.1 spec) pra triggerar
 * frame_fallback path. Sidecar detecta + embeda no frame inteiro.
 *
 * Repassa ReidError lançada pelo reid-client — caller (seedEmployeeFace) trata
 * mapping 422 → no_face / 5xx → sidecar_error.
 */
export async function embedFaceLive(
  reidBaseUrl: string,
  jpegBuf: Buffer,
  timeoutMs = 5_000,
): Promise<EmbedFaceResult> {
  // HACK: bbox oversize força o sidecar a cair em `_embed_pil(full_frame)` —
  // path "frame_fallback" documentado em packages/reid/src/main.py:137.
  // Validado pelo integration test §6.3 cenário 2 (early-warning se sidecar
  // v2+ endurecer guard).
  const result = await reidEmbed(reidBaseUrl, jpegBuf, { x: 0, y: 0, w: 99_999, h: 99_999 }, timeoutMs);
  return result;
}

/**
 * Factory: monta o objeto SeederDeps c/ implementações produção.
 * Usado pelo syncEmployees (Task 7).
 */
export function makeProductionDeps(env: {
  ERP_PHOTO_URL_PREFIX: string;
  SNAPSHOTS_DIR: string;
  REID_BASE_URL: string;
}): SeederDeps {
  return {
    fetchPhoto: (absUrl) => fetchPhotoLive(absUrl),
    embedFace: (jpegBuf) => embedFaceLive(env.REID_BASE_URL, jpegBuf),
    countFaceRecords: (personId) => faceRecordsRepo.countByPerson(personId),
    insertFaceRecord: (input) => faceRecordsRepo.insertAndEvict(input),
    updatePerson: async (id, patch) => {
      await personsRepo.update(id, patch);
    },
    writeSnapshot: async (absPath, bytes) => {
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, bytes);
    },
    photoUrlPrefix: env.ERP_PHOTO_URL_PREFIX,
    snapshotsDir: env.SNAPSHOTS_DIR,
  };
}
