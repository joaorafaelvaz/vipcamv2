import type { DetectResult, EmbedResult, ReidBBox } from "@vipcam/shared";

export class ReidError extends Error {}

/** POST a imagem como multipart pro reid /detect. timeout generoso por
 *  default: a 1ª chamada dispara o InsightFace prepare() (cold start). */
export async function detect(
  reidBaseUrl: string,
  imageBytes: Buffer,
  contentType: string,
  filename: string,
  timeoutMs = 60_000,
): Promise<DetectResult> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(imageBytes)], { type: contentType || "application/octet-stream" }),
    filename,
  );
  let r: Response;
  try {
    r = await fetch(`${reidBaseUrl}/detect`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ReidError(`reid /detect request failed: ${(err as Error).message}`);
  }
  if (!r.ok) throw new ReidError(`reid /detect HTTP ${r.status}`);
  return (await r.json()) as DetectResult;
}

/**
 * POST /embed: envia frame inteiro + bbox em multipart.
 * Sidecar cropa em PIL e retorna embedding 512-d (Onda 7 §3.1).
 *
 * Timeout default 3s assumindo sidecar warm (pre-warm via ExecStartPost).
 * Cold start (~5,5s) só ocorre se reid restartou e o warmup falhou — nesse
 * caso pipeline cai em graceful degrade (Onda 7 §3.5).
 */
export async function embed(
  reidBaseUrl: string,
  frameBytes: Buffer,
  bbox: ReidBBox,
  timeoutMs = 3_000,
): Promise<EmbedResult> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(frameBytes)], { type: "image/jpeg" }), "frame.jpg");
  form.append("x", String(bbox.x));
  form.append("y", String(bbox.y));
  form.append("w", String(bbox.w));
  form.append("h", String(bbox.h));
  let r: Response;
  try {
    r = await fetch(`${reidBaseUrl}/embed`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ReidError(`reid /embed request failed: ${(err as Error).message}`);
  }
  if (!r.ok) throw new ReidError(`reid /embed HTTP ${r.status}`);
  return (await r.json()) as EmbedResult;
}
