import { Hono } from "hono";

export interface SnapshotsDeps {
  /** Lê bytes do filesystem. Retorna null se file não existe. */
  readSnapshot: (filename: string) => Promise<Uint8Array | null>;
}

// Anti path traversal: aceita SÓ filenames simples [a-z0-9_.-]+.jpg, sem barras.
const VALID_FILENAME = /^[a-zA-Z0-9_.-]+\.jpg$/;

/**
 * Endpoint público (sem auth) que serve snapshots .jpg do filesystem.
 * Onda 3 — frontend usa via `<img src="/snapshots/abc.jpg">`.
 *
 * Segurança: nginx restringe IPs da LAN (kiosk fechado). Validação de
 * filename via regex previne path traversal mesmo se nginx falhar.
 */
export function createSnapshotsRoutes(deps: SnapshotsDeps): Hono {
  const r = new Hono();

  r.get("/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (!VALID_FILENAME.test(filename) || filename.includes("..")) {
      return c.json({ error: "invalid_filename" }, 400);
    }
    const bytes = await deps.readSnapshot(filename);
    if (!bytes) return c.json({ error: "not_found" }, 404);
    // Cast pra ArrayBuffer (Uint8Array tem .buffer compatible com BodyInit DOM)
    return new Response(bytes.buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "public, max-age=86400, immutable",
      },
    });
  });

  return r;
}
