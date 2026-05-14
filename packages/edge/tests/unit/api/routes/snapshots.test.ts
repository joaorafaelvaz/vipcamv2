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
