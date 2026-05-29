/**
 * Onda 9-B integration tests — DB-deferred, require:
 * - DATABASE_URL apontando p/ vipcam_test (ou VIPCAM_TEST_DB_OK opt-in)
 * - Sidecar reid reachable em REID_BASE_URL
 * - Fixture JPEG em tests/fixtures/employee-photos/test-face.jpg
 *   (vide README.md no diretório — skipa gracioso se ausente)
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { getEnv } from "../../../src/config/env.js";
import { makeProductionDeps } from "../../../src/erp-sync/employee-face-seeder-deps.js";
import { seedEmployeeFace } from "../../../src/erp-sync/employee-face-seeder.js";
import { getDb } from "../../../src/persistence/db.js";
import { faceRecordsRepo, personsRepo } from "../../../src/persistence/repositories/index.js";

const FIXTURE_PATH = join(import.meta.dir, "../../fixtures/employee-photos/test-face.jpg");
const FIXTURE_AVAILABLE = existsSync(FIXTURE_PATH);

let fixtureBytes: Buffer;
let server: ReturnType<typeof Bun.serve> | null = null;
let fixtureUrl: string;
let personId: string;

beforeAll(async () => {
  if (!FIXTURE_AVAILABLE) {
    console.warn(
      `[onda-9b] integration tests skipped — fixture missing: ${FIXTURE_PATH}\n         vide tests/fixtures/employee-photos/README.md`,
    );
    return;
  }
  fixtureBytes = await readFile(FIXTURE_PATH);
  server = Bun.serve({
    port: 0, // random
    fetch(req) {
      if (new URL(req.url).pathname === "/test-face.jpg") {
        // Bun's Response constructor é mais permissivo que web standard,
        // mas TS usa o tipo standard — cast pra Uint8Array satisfaz.
        return new Response(new Uint8Array(fixtureBytes), {
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  fixtureUrl = `http://127.0.0.1:${server.port}/`;
});

afterAll(() => {
  if (server) server.stop(true);
});

beforeEach(async () => {
  if (!FIXTURE_AVAILABLE) return;
  const p = await personsRepo.create({
    display_name: "Test Employee Seed",
    person_type: "employee",
    erp_employee_id: `test-9b-${Date.now()}`,
  });
  personId = p.id;
});

afterEach(async () => {
  if (!FIXTURE_AVAILABLE || !personId) return;
  const db = getDb();
  await db.execute(sql`DELETE FROM face_records WHERE person_id = ${personId}`);
  await db.execute(sql`DELETE FROM persons WHERE id = ${personId}`);
});

describe.skipIf(!FIXTURE_AVAILABLE)("seedEmployeeFace end-to-end (DB + sidecar real)", () => {
  test("happy path: foto válida → face_record source='erp_seed' + Person.last_embedded_image_token", async () => {
    const env = getEnv();
    const deps = makeProductionDeps({
      ERP_PHOTO_URL_PREFIX: fixtureUrl,
      SNAPSHOTS_DIR: env.SNAPSHOTS_DIR,
      REID_BASE_URL: env.REID_BASE_URL,
    });

    const person = await personsRepo.findById(personId);
    if (!person) throw new Error("person fixture missing");
    const result = await seedEmployeeFace(person, "test-face.jpg", deps);

    expect(result.status).toBe("embedded");

    // Assert face_record created with source='erp_seed'
    const rows = await getDb().execute<{ source: string; det_score: number | null }>(sql`
      SELECT source, det_score FROM face_records WHERE person_id = ${personId}
    `);
    const fr = rows[0];
    expect(fr?.source).toBe("erp_seed");
    expect(fr?.det_score ?? 0).toBeGreaterThan(0);

    // Assert Person updated
    const updated = await personsRepo.findById(personId);
    expect(updated?.last_embedded_image_token).toBe("test-face.jpg");
    expect(updated?.thumbnail_path).toContain("employee_seed");
  });

  test("frame_fallback contract — sidecar aceita bbox oversize (signals breakage se v2+ endurecer)", async () => {
    const env = getEnv();
    const deps = makeProductionDeps({
      ERP_PHOTO_URL_PREFIX: fixtureUrl,
      SNAPSHOTS_DIR: env.SNAPSHOTS_DIR,
      REID_BASE_URL: env.REID_BASE_URL,
    });

    const person = await personsRepo.findById(personId);
    if (!person) throw new Error("person fixture missing");
    const result = await seedEmployeeFace(person, "test-face.jpg", deps);

    // Indireto: embed sucede SE o hack do bbox oversize funcionar.
    // status !== 'sidecar_error' E !== 'no_face' (rosto válido na fixture).
    // Se este test falhar c/ sidecar_error/no_face, signal de breakage do
    // frame_fallback path — vide spec §10 item #9.
    expect(result.status).toBe("embedded");

    // Faceiro: EmbedResult.source é opcional em shared/types/reid.ts — verifica
    // só se presente. Sidecar v0.2.0 não tinha; v0.3.0+ sim.
    // Não temos acesso direto ao EmbedResult aqui (encapsulado em seedEmployeeFace),
    // então o sucesso do embed é a única assertion cross-version safe.
  });
});
