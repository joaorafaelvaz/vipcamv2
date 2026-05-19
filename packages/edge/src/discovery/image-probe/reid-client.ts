import type { DetectResult } from "@vipcam/shared";

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
