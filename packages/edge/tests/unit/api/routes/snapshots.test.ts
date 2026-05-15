import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { type SnapshotsDeps, createSnapshotsRoutes } from "../../../../src/api/routes/snapshots.js";

function mountWith(deps: SnapshotsDeps): Hono {
  const app = new Hono();
  app.route("/snapshots", createSnapshotsRoutes(deps));
  return app;
}

describe("GET /snapshots/:filename", () => {
  test("retorna 200 com bytes + content-type quando file existe", async () => {
    const fakeBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic
    const app = mountWith({
      readSnapshot: async (filename) => {
        expect(filename).toBe("abc123.jpg");
        return fakeBytes;
      },
    });
    const res = await app.request("/snapshots/abc123.jpg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toContain("max-age=86400");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes[0]).toBe(0xff);
  });

  test("retorna 404 quando readSnapshot devolve null (file não existe)", async () => {
    const app = mountWith({ readSnapshot: async () => null });
    const res = await app.request("/snapshots/missing.jpg");
    expect(res.status).toBe(404);
  });

  // C1 (review 2026-05-15): fs.readFile retorna Buffer; pra files <8KB o
  // Buffer é uma VIEW num pool interno compartilhado do Node. `bytes.buffer`
  // = pool inteiro, não só este arquivo → Response serviria bytes errados +
  // vazaria memória adjacente num endpoint sem auth. Simula o pool com uma
  // Uint8Array que é view (offset>0, length<backing) de um ArrayBuffer maior.
  test("serve EXATAMENTE os bytes do arquivo quando bytes é view de buffer maior (pool)", async () => {
    const pool = new Uint8Array(64);
    pool.fill(0xaa); // "lixo" do pool / outros arquivos
    const fileBytes = [0xff, 0xd8, 0xff, 0xe0, 0x12, 0x34]; // JPEG-ish, 6 bytes
    pool.set(fileBytes, 20); // arquivo vive em offset 20
    const view = new Uint8Array(pool.buffer, 20, fileBytes.length); // o que fs.readFile daria

    const app = mountWith({ readSnapshot: async () => view });
    const res = await app.request("/snapshots/x.jpg");
    expect(res.status).toBe(200);
    const out = new Uint8Array(await res.arrayBuffer());
    expect(out.length).toBe(fileBytes.length); // NÃO 64 (pool inteiro)
    expect([...out]).toEqual(fileBytes); // exatamente os bytes do arquivo
  });

  test("rejeita filename com path traversal (`..`)", async () => {
    let called = false;
    const app = mountWith({
      readSnapshot: async () => {
        called = true;
        return null;
      },
    });
    const res = await app.request("/snapshots/..%2F..%2Fetc%2Fpasswd");
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });

  test("rejeita filename sem extensão .jpg", async () => {
    const app = mountWith({ readSnapshot: async () => null });
    const res = await app.request("/snapshots/file.png");
    expect(res.status).toBe(400);
  });
});
