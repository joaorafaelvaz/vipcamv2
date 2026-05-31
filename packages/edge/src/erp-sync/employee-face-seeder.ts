/**
 * Onda 9-B — employee face seeder.
 *
 * Após syncEmployees criar/atualizar Person(employee), este módulo baixa
 * a foto do ERP, manda pro sidecar reid /embed (via bbox oversize trick →
 * frame_fallback path do sidecar), e persiste em face_records.
 *
 * Idempotente via persons.last_embedded_image_token: se imagem do ERP
 * não mudou desde o último seed, skip.
 *
 * HACK explícito: chamamos /embed com bbox (0,0,99999,99999) pra forçar
 * o sidecar a cair no `_embed_pil(full_frame)` (path documentado no
 * packages/reid/src/main.py:137 como "frame_fallback"). Sidecar v2+ pode
 * endurecer o guard "bbox deve caber no frame" — neste caso integration
 * test §6.3 cenário 2 falha como early-warning. Mitigação documentada em
 * spec §10 item #9: switch para opção B (/embed_image novo endpoint).
 */

import path from "node:path";
import { logger } from "../obs/logger.js";
import type { Person } from "../persistence/schema/persons.js";

const PLACEHOLDER_IMAGES: ReadonlySet<string> = new Set([
  "padrao.png",
  "padrao_masc.jpg",
  // ERP usa "padrao_femi.jpg" (com "i") em produção — confirmado via
  // /api/v2/agendas/getUnidade probe 2026-05-31. "padrao_fem.jpg" mantido
  // como alias defensivo caso unidades antigas usem o nome curto.
  "padrao_femi.jpg",
  "padrao_fem.jpg",
]);

/** True quando o valor de `usuarios.imagem` é um placeholder do ERP
 * (não foto real). Set conhecido via probe 2026-05-28 (vide spec §2). */
export function isPlaceholder(photoUrl: string): boolean {
  return PLACEHOLDER_IMAGES.has(photoUrl);
}

/** Sanitiza o token do ERP pra filename safe — substitui `?` (query
 * string separator do cache-buster) e `/` (defensive path traversal)
 * por `_`. Tokens típicos do ERP: "avatar_1966.jpg?p8yr" → "avatar_1966.jpg_p8yr". */
export function sanitizeToken(token: string): string {
  return token.replace(/[?/]/g, "_");
}

/** Saída discriminada do seeder — define test matrix e log aggregation. */
export type SeedResult =
  | { status: "placeholder" }
  | { status: "unchanged" }
  | { status: "embedded"; face_record_id: string }
  | {
      status: "fetch_failed";
      reason: "http_4xx" | "http_5xx" | "timeout" | "dns" | "network";
      detail?: string;
    }
  | { status: "no_face" }
  | {
      status: "sidecar_error";
      reason: "timeout" | "5xx" | "network";
      detail?: string;
    };

/** Resultado do fetch da foto — abstrai HTTP pra permitir mock + classificação de erro. */
export type FetchResult =
  | { ok: true; jpegBuf: Buffer }
  | { ok: false; statusCode: number }
  | { ok: false; error: "timeout" | "dns" | "network"; detail?: string };

/** Saída do sidecar /embed conforme `EmbedResult` de @vipcam/shared, mas
 * restrito ao que o seeder lê (não acoplado ao tipo full do shared). */
export interface EmbedFaceResult {
  embedding: number[];
  det_score: number;
  crop_jpeg_b64: string;
  model_name: string;
  model_revision: string;
  source?: "bbox" | "frame_fallback";
}

/** Dependências injetadas — todas substituíveis em tests. */
export interface SeederDeps {
  fetchPhoto(absoluteUrl: string): Promise<FetchResult>;
  embedFace(jpegBuf: Buffer): Promise<EmbedFaceResult>;
  countFaceRecords(personId: string): Promise<number>;
  insertFaceRecord(input: {
    person_id: string;
    embedding: number[];
    snapshot_path: string;
    det_score: number;
    is_primary: boolean;
    source: "erp_seed";
    model_name: string;
    model_revision: string;
  }): Promise<{ id: string }>;
  updatePerson(
    id: string,
    patch: { last_embedded_image_token: string; thumbnail_path: string },
  ): Promise<void>;
  writeSnapshot(absPath: string, jpegBuf: Buffer): Promise<void>;
  photoUrlPrefix: string;
  snapshotsDir: string;
}

/**
 * Orquestra o seed da face de 1 employee. Idempotente via
 * person.last_embedded_image_token + countFaceRecords(person.id) > 0 check.
 *
 * Retorna SeedResult discriminado — caller (syncEmployees) faz aggregate
 * + log estruturado. Erros esperados (placeholder, fetch failure, sidecar
 * 422/5xx, FK violation 23503) viram variantes do union; erros inesperados
 * (ex: insert error não-23503, bug interno) propagam pra caller catch.
 */
export async function seedEmployeeFace(
  person: Person,
  photoUrl: string,
  deps: SeederDeps,
): Promise<SeedResult> {
  if (isPlaceholder(photoUrl)) {
    return { status: "placeholder" };
  }

  const existingCount = await deps.countFaceRecords(person.id);
  if (person.last_embedded_image_token === photoUrl && existingCount > 0) {
    return { status: "unchanged" };
  }

  const absoluteUrl = `${deps.photoUrlPrefix}${photoUrl}`;
  const fetchRes = await deps.fetchPhoto(absoluteUrl);

  if (!fetchRes.ok) {
    if ("statusCode" in fetchRes) {
      const reason = fetchRes.statusCode >= 500 ? "http_5xx" : "http_4xx";
      logger.warn(
        { erp_employee_id: person.erp_employee_id, statusCode: fetchRes.statusCode, reason },
        "employee photo fetch failed (HTTP)",
      );
      return { status: "fetch_failed", reason };
    }
    logger.warn(
      { erp_employee_id: person.erp_employee_id, error: fetchRes.error, detail: fetchRes.detail },
      "employee photo fetch failed (network)",
    );
    const result: SeedResult =
      fetchRes.detail !== undefined
        ? { status: "fetch_failed", reason: fetchRes.error, detail: fetchRes.detail }
        : { status: "fetch_failed", reason: fetchRes.error };
    return result;
  }

  let embedResult: EmbedFaceResult;
  try {
    embedResult = await deps.embedFace(fetchRes.jpegBuf);
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 422) {
      logger.warn({ erp_employee_id: person.erp_employee_id }, "sidecar /embed: no face detected");
      return { status: "no_face" };
    }
    const reason: "5xx" | "timeout" | "network" =
      e.status !== undefined && e.status >= 500
        ? "5xx"
        : /timeout/i.test(e.message)
          ? "timeout"
          : "network";
    logger.error(
      { erp_employee_id: person.erp_employee_id, message: e.message, status: e.status, reason },
      "sidecar /embed call failed",
    );
    return { status: "sidecar_error", reason, detail: e.message };
  }

  // Defensive: crop_jpeg_b64 sempre presente em sidecar Onda 7+, mas
  // protege contra sidecar v0 (sem o campo).
  if (!embedResult.crop_jpeg_b64) {
    logger.error(
      { erp_employee_id: person.erp_employee_id },
      "sidecar /embed response missing crop_jpeg_b64 — sidecar version mismatch?",
    );
    return { status: "sidecar_error", reason: "network", detail: "missing_crop_jpeg_b64" };
  }

  // Snapshot persistence
  const snapshotRelPath = `employee_seed/${person.erp_employee_id}_${sanitizeToken(photoUrl)}.jpg`;
  const absSnapshotPath = path.join(deps.snapshotsDir, snapshotRelPath);
  await deps.writeSnapshot(absSnapshotPath, Buffer.from(embedResult.crop_jpeg_b64, "base64"));

  // Face record + FK violation defensive catch
  let fr: { id: string };
  try {
    fr = await deps.insertFaceRecord({
      person_id: person.id,
      embedding: embedResult.embedding,
      snapshot_path: snapshotRelPath,
      det_score: embedResult.det_score,
      is_primary: existingCount === 0,
      source: "erp_seed",
      model_name: embedResult.model_name,
      model_revision: embedResult.model_revision,
    });
  } catch (err) {
    const e = err as Error & { code?: string };
    if (e.code === "23503") {
      logger.warn(
        { erp_employee_id: person.erp_employee_id, person_id: person.id },
        "face_record FK violation — Person disappeared during seed (race c/ mergeInto?)",
      );
      return { status: "sidecar_error", reason: "network", detail: "person_fk_violation" };
    }
    throw err;
  }

  // Person update — token + thumbnail
  await deps.updatePerson(person.id, {
    last_embedded_image_token: photoUrl,
    thumbnail_path: snapshotRelPath,
  });

  return { status: "embedded", face_record_id: fr.id };
}
