import { describe, expect, test } from "bun:test";
import { isPlaceholder, sanitizeToken } from "../../../src/erp-sync/employee-face-seeder.js";

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
