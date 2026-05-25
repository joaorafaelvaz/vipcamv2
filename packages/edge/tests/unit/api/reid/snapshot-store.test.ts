import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pruneOlderThan, saveCrop } from "../../../../src/api/reid/snapshot-store.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "snap-store-test-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("saveCrop", () => {
  test("writes file to YYYY-MM-DD/<id>.jpg and returns relative path", async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const relPath = await saveCrop({
      baseDir: tmpDir,
      detectionId: "abc-123",
      detectedAt: new Date("2026-05-20T14:30:00Z"),
      jpegBytes: buf,
    });
    expect(relPath).toBe("2026-05-20/abc-123.jpg");
    const written = await fs.readFile(path.join(tmpDir, relPath));
    expect(Buffer.compare(written, buf)).toBe(0);
  });

  test("creates date directory on demand (mkdir -p)", async () => {
    await saveCrop({
      baseDir: tmpDir,
      detectionId: "x",
      detectedAt: new Date("2026-06-01T00:00:00Z"),
      jpegBytes: Buffer.from([0]),
    });
    const stat = await fs.stat(path.join(tmpDir, "2026-06-01"));
    expect(stat.isDirectory()).toBe(true);
  });

  test("uses UTC for date segment (not local TZ)", async () => {
    const relPath = await saveCrop({
      baseDir: tmpDir,
      detectionId: "edge",
      detectedAt: new Date("2026-05-21T02:30:00Z"),
      jpegBytes: Buffer.from([0]),
    });
    expect(relPath.startsWith("2026-05-21/")).toBe(true);
  });
});

describe("pruneOlderThan", () => {
  test("deletes date-prefixed dirs older than N days", async () => {
    const today = new Date();
    const mkOldDir = async (daysAgo: number) => {
      const d = new Date(today.getTime() - daysAgo * 86400_000);
      const name = d.toISOString().slice(0, 10);
      const full = path.join(tmpDir, name);
      await fs.mkdir(full, { recursive: true });
      await fs.writeFile(path.join(full, "fake.jpg"), Buffer.from([0]));
      await fs.utimes(full, d, d);
    };
    await mkOldDir(40);
    await mkOldDir(20);
    await mkOldDir(0);

    const deleted = await pruneOlderThan({ baseDir: tmpDir, days: 30 });
    expect(deleted).toBe(1);

    const remaining = await fs.readdir(tmpDir);
    expect(remaining.length).toBe(2);
  });

  test("ignores non-date dirs (defense-in-depth)", async () => {
    const odd = path.join(tmpDir, "lost+found");
    await fs.mkdir(odd, { recursive: true });
    const past = new Date(Date.now() - 60 * 86400_000);
    await fs.utimes(odd, past, past);

    const deleted = await pruneOlderThan({ baseDir: tmpDir, days: 30 });
    expect(deleted).toBe(0);
    const remaining = await fs.readdir(tmpDir);
    expect(remaining).toContain("lost+found");
  });

  test("baseDir não existe → retorna 0 sem throw (graceful)", async () => {
    const deleted = await pruneOlderThan({
      baseDir: path.join(tmpDir, "doesnt-exist"),
      days: 30,
    });
    expect(deleted).toBe(0);
  });
});
