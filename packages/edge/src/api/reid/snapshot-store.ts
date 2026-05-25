import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Path relativo a SNAPSHOTS_DIR. Forma: 'YYYY-MM-DD/<detection-id>.jpg'. */
export type RelativeSnapshotPath = string;

export interface SaveCropParams {
  baseDir: string;
  detectionId: string;
  detectedAt: Date;
  jpegBytes: Buffer;
}

/** Regex que casa nomes de pasta no formato ISO date (UTC) — usado pelo prune
 * pra ignorar lixo (`lost+found`, manual debug dirs etc.). */
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Escreve crop JPEG em `<baseDir>/YYYY-MM-DD/<detection-id>.jpg`.
 * mkdir -p garante dir existe. Retorna o path relativo (formato armazenado
 * em `detections.snapshot_path` e usado na URL `/snapshots/:date/:filename`).
 *
 * Data deriva de `detectedAt` UTC — NÃO TZ local — pra evitar split-day em
 * boundary (eg 23:30 BRT em 20 vira 02:30 UTC em 21 → pasta 21, consistente
 * com `detected_at` armazenado no DB também UTC).
 */
export async function saveCrop(params: SaveCropParams): Promise<RelativeSnapshotPath> {
  const { baseDir, detectionId, detectedAt, jpegBytes } = params;
  const dateSeg = detectedAt.toISOString().slice(0, 10);
  const dirFull = path.join(baseDir, dateSeg);
  await fs.mkdir(dirFull, { recursive: true });
  const fileFull = path.join(dirFull, `${detectionId}.jpg`);
  await fs.writeFile(fileFull, jpegBytes);
  return `${dateSeg}/${detectionId}.jpg`;
}

export interface PruneParams {
  baseDir: string;
  days: number;
}

/**
 * Retention: apaga pastas YYYY-MM-DD com mtime mais velho que `days`.
 *
 * Filtra por regex pra não tocar em dirs alheios (`lost+found`, snapshots de
 * outro release de design, etc.). Se baseDir não existe (cold start em VPS),
 * retorna 0 silently — scheduler-health pega via no-throw success.
 */
export async function pruneOlderThan(params: PruneParams): Promise<number> {
  const { baseDir, days } = params;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  const cutoff = Date.now() - days * 86400_000;
  let deleted = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!DATE_DIR_RE.test(e.name)) continue;
    const full = path.join(baseDir, e.name);
    const stat = await fs.stat(full);
    if (stat.mtimeMs < cutoff) {
      await fs.rm(full, { recursive: true, force: true });
      deleted += 1;
    }
  }
  return deleted;
}
