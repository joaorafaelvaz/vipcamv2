import { describe, expect, test } from "bun:test";
import { createSnapshotsRoutes } from "../../../../src/api/routes/snapshots.js";

function app(read: (rel: string) => Promise<Uint8Array | null>) {
  return createSnapshotsRoutes({ readSnapshot: read });
}

describe("snapshots route /:date/:filename (Onda 7)", () => {
  test("valid date + filename → 200 + image/jpeg", async () => {
    let received = "";
    const r = await app(async (rel) => {
      received = rel;
      return new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    }).request("/2026-05-20/abc-def-123.jpg");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(received).toBe("2026-05-20/abc-def-123.jpg");
  });

  test("404 when readSnapshot returns null", async () => {
    const r = await app(async () => null).request("/2026-05-20/missing.jpg");
    expect(r.status).toBe(404);
  });

  test("400 invalid date segment", async () => {
    const r = await app(async () => null).request("/not-a-date/x.jpg");
    expect(r.status).toBe(400);
  });

  test("400 invalid filename segment (non-UUID-ish)", async () => {
    const r = await app(async () => null).request("/2026-05-20/file..with..dots.jpg");
    expect(r.status).toBe(400);
  });

  test("400 path traversal attempt date segment", async () => {
    const r = await app(async () => null).request("/2026-05-20/..%2F..%2Fetc%2Fpasswd");
    expect(r.status).toBe(400);
  });

  test("400 path traversal attempt date segment v2", async () => {
    const r = await app(async () => null).request("/..%2F..%2F2026-05-20/abc.jpg");
    expect(r.status).toBe(400);
  });

  test("legacy flat route /:filename returns 400 ou 404 (sem date segment, intencionalmente removido)", async () => {
    const r = await app(async () => null).request("/old-flat.jpg");
    expect([400, 404]).toContain(r.status);
  });
});
