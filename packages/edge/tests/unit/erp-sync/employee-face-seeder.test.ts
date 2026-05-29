import { describe, expect, test } from "bun:test";
import {
  type SeederDeps,
  isPlaceholder,
  sanitizeToken,
  seedEmployeeFace,
} from "../../../src/erp-sync/employee-face-seeder.js";
import type { Person } from "../../../src/persistence/schema/persons.js";

describe("isPlaceholder", () => {
  test("true para padrao.png / padrao_masc.jpg / padrao_fem.jpg", () => {
    expect(isPlaceholder("padrao.png")).toBe(true);
    expect(isPlaceholder("padrao_masc.jpg")).toBe(true);
    expect(isPlaceholder("padrao_fem.jpg")).toBe(true);
  });

  test("false para foto real (avatar_<id>.jpg?<token>)", () => {
    expect(isPlaceholder("avatar_1966.jpg?p8yr")).toBe(false);
    expect(isPlaceholder("avatar_2587.jpg?PtZD")).toBe(false);
  });

  test("false para empty / undefined-like fallbacks", () => {
    // Defensive — ERP nunca devolve '' (default 'padrao.png'), mas se vier
    // achamos que NÃO é placeholder; fetch vai falhar e seeder loga warn.
    expect(isPlaceholder("")).toBe(false);
  });
});

describe("sanitizeToken", () => {
  test("substitui ? por _ p/ filesystem-safety", () => {
    expect(sanitizeToken("avatar_1966.jpg?p8yr")).toBe("avatar_1966.jpg_p8yr");
  });

  test("idempotente em string sem ?", () => {
    expect(sanitizeToken("avatar_1966.jpg")).toBe("avatar_1966.jpg");
  });

  test("path traversal defensiva — slashes viram _ (suficiente: sem separadores não há traversal)", () => {
    // `.` não é substituído (não é separador no filesystem); só `/` matters
    // pra escape de dir. Resultado: `..` sobrevive mas sem `/` ao redor é
    // só caractere literal no filename.
    expect(sanitizeToken("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(sanitizeToken("a/b/c.jpg")).toBe("a_b_c.jpg");
  });
});

// Person fixture mínimo — só os campos que o seeder lê
// NOTA: campo `last_embedded_image_token` depende de Chunk 1 ter aplicado
// migration 0009. Type Person é re-exported após Chunk 1 merge.
function makePerson(overrides?: Partial<Person>): Person {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    person_type: "employee",
    display_name: "Test Employee",
    erp_client_id: null,
    erp_employee_id: "999",
    thumbnail_path: null,
    first_seen_at: new Date(),
    last_seen_at: new Date(),
    total_visits: 0,
    avg_satisfaction: null,
    estimated_age: null,
    estimated_gender: null,
    notes: null,
    metadata: {},
    last_embedded_image_token: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as Person;
}

// Deps stubs — cada teste customiza o que importa
function makeDeps(overrides?: Partial<SeederDeps>): SeederDeps {
  return {
    fetchPhoto: async () => ({ ok: true, jpegBuf: Buffer.from("fake-jpeg") }),
    embedFace: async () => ({
      embedding: new Array(512).fill(0.1),
      det_score: 0.95,
      crop_jpeg_b64: Buffer.from("fake-crop").toString("base64"),
      model_name: "buffalo_s",
      model_revision: "insightface-0.7.3",
      source: "frame_fallback",
    }),
    countFaceRecords: async () => 0,
    insertFaceRecord: async () => ({ id: "fr-123" }),
    updatePerson: async () => undefined,
    writeSnapshot: async () => undefined,
    photoUrlPrefix: "https://test/img/",
    snapshotsDir: "/tmp/test-snapshots",
    ...overrides,
  };
}

describe("seedEmployeeFace SeedResult scenarios", () => {
  test("placeholder → {status:'placeholder'}, ZERO side effects", async () => {
    const deps = makeDeps();
    const result = await seedEmployeeFace(makePerson(), "padrao_masc.jpg", deps);
    expect(result).toEqual({ status: "placeholder" });
  });

  test("token unchanged + count>0 → {status:'unchanged'}", async () => {
    const deps = makeDeps({ countFaceRecords: async () => 2 });
    const person = makePerson({ last_embedded_image_token: "avatar_999.jpg?abcd" });
    const result = await seedEmployeeFace(person, "avatar_999.jpg?abcd", deps);
    expect(result).toEqual({ status: "unchanged" });
  });

  test("token unchanged BUT count=0 → re-embed (status:'embedded')", async () => {
    const deps = makeDeps({ countFaceRecords: async () => 0 });
    const person = makePerson({ last_embedded_image_token: "avatar_999.jpg?abcd" });
    const result = await seedEmployeeFace(person, "avatar_999.jpg?abcd", deps);
    expect(result.status).toBe("embedded");
  });

  test("happy path → {status:'embedded', face_record_id}, snapshot saved, person updated", async () => {
    let writtenSnapshot: { path: string; bytes: Buffer } | null = null;
    let updatedPerson: { id: string; patch: Record<string, unknown> } | null = null;
    const deps = makeDeps({
      writeSnapshot: async (absPath, bytes) => {
        writtenSnapshot = { path: absPath, bytes };
      },
      updatePerson: async (id, patch) => {
        updatedPerson = { id, patch };
      },
    });
    const result = await seedEmployeeFace(makePerson(), "avatar_1966.jpg?p8yr", deps);

    expect(result.status).toBe("embedded");
    if (result.status === "embedded") expect(result.face_record_id).toBe("fr-123");

    expect(writtenSnapshot).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    expect(writtenSnapshot!.path).toContain("employee_seed");
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    expect(writtenSnapshot!.path).toContain("999_avatar_1966.jpg_p8yr.jpg");

    expect(updatedPerson).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    expect(updatedPerson!.patch.last_embedded_image_token).toBe("avatar_1966.jpg?p8yr");
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    expect(updatedPerson!.patch.thumbnail_path).toContain(
      "employee_seed/999_avatar_1966.jpg_p8yr.jpg",
    );
  });

  test("fetch 404 → {status:'fetch_failed', reason:'http_4xx'}", async () => {
    const deps = makeDeps({
      fetchPhoto: async () => ({ ok: false, statusCode: 404 }),
    });
    const result = await seedEmployeeFace(makePerson(), "avatar_999.jpg?abcd", deps);
    expect(result).toEqual({ status: "fetch_failed", reason: "http_4xx" });
  });

  test("fetch timeout/dns → {status:'fetch_failed', reason}", async () => {
    const deps = makeDeps({
      fetchPhoto: async () => ({ ok: false, error: "timeout" }),
    });
    const result = await seedEmployeeFace(makePerson(), "avatar_999.jpg?abcd", deps);
    expect(result).toEqual({ status: "fetch_failed", reason: "timeout" });
  });

  test("sidecar 422 (no face) → {status:'no_face'}", async () => {
    const deps = makeDeps({
      embedFace: async () => {
        const err = new Error("reid /embed HTTP 422") as Error & { status?: number };
        err.status = 422;
        throw err;
      },
    });
    const result = await seedEmployeeFace(makePerson(), "avatar_999.jpg?abcd", deps);
    expect(result).toEqual({ status: "no_face" });
  });

  test("sidecar 5xx → {status:'sidecar_error', reason:'5xx'}", async () => {
    const deps = makeDeps({
      embedFace: async () => {
        const err = new Error("reid /embed HTTP 503") as Error & { status?: number };
        err.status = 503;
        throw err;
      },
    });
    const result = await seedEmployeeFace(makePerson(), "avatar_999.jpg?abcd", deps);
    expect(result.status).toBe("sidecar_error");
    if (result.status === "sidecar_error") expect(result.reason).toBe("5xx");
  });

  test("FK violation (Person sumiu) → {status:'sidecar_error', detail:'person_fk_violation'}", async () => {
    const deps = makeDeps({
      insertFaceRecord: async () => {
        const err = new Error(
          'insert or update on table "face_records" violates foreign key',
        ) as Error & { code?: string };
        err.code = "23503";
        throw err;
      },
    });
    const result = await seedEmployeeFace(makePerson(), "avatar_999.jpg?abcd", deps);
    expect(result.status).toBe("sidecar_error");
    if (result.status === "sidecar_error") {
      expect(result.detail).toBe("person_fk_violation");
    }
  });
});
