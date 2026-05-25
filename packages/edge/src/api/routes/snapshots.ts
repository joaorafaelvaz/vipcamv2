import { Hono } from "hono";

export interface SnapshotsDeps {
  /** Lê bytes do filesystem. `relativePath` é o valor armazenado em
   * detections.snapshot_path: 'YYYY-MM-DD/<detection-uuid>.jpg'. */
  readSnapshot: (relativePath: string) => Promise<Uint8Array | null>;
}

// Anti path traversal: dois segmentos validados separadamente.
const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_FILENAME = /^[a-zA-Z0-9-]+\.jpg$/;

/**
 * Endpoint público (sem auth — nginx restringe LAN) que serve snapshots
 * JPEG sob layout `snapshots/YYYY-MM-DD/<detection-uuid>.jpg`.
 *
 * Onda 7 §2.3: substitui rota flat `/snapshots/:filename` que existia desde
 * Onda 3. Pré-Onda-7 nenhuma detection tinha snapshot_path populado, então
 * remover a rota antiga não-quebra URLs reais.
 *
 * Validação anti-traversal: regex em CADA segmento. Hono decodifica %2F
 * em / antes de matchar params, então qualquer ../../etc/passwd cai aqui.
 */
export function createSnapshotsRoutes(deps: SnapshotsDeps): Hono {
  const r = new Hono();

  r.get("/:date/:filename", async (c) => {
    const date = c.req.param("date");
    const filename = c.req.param("filename");
    if (
      !VALID_DATE.test(date) ||
      !VALID_FILENAME.test(filename) ||
      filename.includes("..") ||
      date.includes("..")
    ) {
      return c.json({ error: "invalid_path" }, 400);
    }
    const relativePath = `${date}/${filename}`;
    const bytes = await deps.readSnapshot(relativePath);
    if (!bytes) return c.json({ error: "not_found" }, 404);
    // C1: bytes pode ser uma VIEW num buffer maior (fs.readFile retorna
    // Buffer do pool interno do Node pra files <8KB). Slice exato copia
    // só este arquivo (evita leak de memória adjacente num endpoint sem auth).
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "public, max-age=86400, immutable",
      },
    });
  });

  return r;
}
