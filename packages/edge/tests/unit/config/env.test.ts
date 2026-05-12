import { describe, expect, test } from "bun:test";
import { parseEnv } from "../../../src/config/env.js";

describe("parseEnv", () => {
  test("retorna config válida quando vars obrigatórias estão presentes", () => {
    const result = parseEnv({
      EDGE_PORT: "4000",
      LOG_LEVEL: "info",
      NODE_ENV: "development",
      API_KEY: "test-key",
    });
    expect(result.EDGE_PORT).toBe(4000);
    expect(result.API_KEY).toBe("test-key");
  });

  test("aplica defaults quando vars opcionais ausentes", () => {
    const result = parseEnv({ API_KEY: "test-key" });
    expect(result.EDGE_PORT).toBe(4000);
    expect(result.LOG_LEVEL).toBe("info");
    expect(result.NODE_ENV).toBe("development");
  });

  test("lança erro quando API_KEY ausente", () => {
    expect(() => parseEnv({})).toThrow(/API_KEY/);
  });

  test("lança erro quando EDGE_PORT não é numérico", () => {
    expect(() => parseEnv({ API_KEY: "k", EDGE_PORT: "abc" })).toThrow();
  });

  test("aceita config de câmera quando todas as vars presentes", () => {
    const result = parseEnv({
      API_KEY: "k",
      CAMERA_IP: "192.168.1.108",
      CAMERA_USER: "admin",
      CAMERA_PASS: "secret",
    });
    expect(result.CAMERA_IP).toBe("192.168.1.108");
    expect(result.CAMERA_USER).toBe("admin");
  });

  test("permite config de câmera ausente (modo discovery offline)", () => {
    const result = parseEnv({ API_KEY: "k" });
    expect(result.CAMERA_IP).toBeUndefined();
  });

  test("rejeita CAMERA_IP malformado", () => {
    expect(() =>
      parseEnv({ API_KEY: "k", CAMERA_IP: "not-an-ip", CAMERA_USER: "a", CAMERA_PASS: "b" }),
    ).toThrow();
  });

  test("aceita DATABASE_URL válido (postgres://)", () => {
    const result = parseEnv({
      API_KEY: "k",
      DATABASE_URL: "postgres://vipcam:vipcam@localhost:5432/vipcam",
    });
    expect(result.DATABASE_URL).toBe("postgres://vipcam:vipcam@localhost:5432/vipcam");
  });

  test("permite DATABASE_URL ausente (modo sem DB)", () => {
    const result = parseEnv({ API_KEY: "k" });
    expect(result.DATABASE_URL).toBeUndefined();
  });

  test("rejeita DATABASE_URL com schema inválido", () => {
    expect(() => parseEnv({ API_KEY: "k", DATABASE_URL: "sqlite:///vipcam.db" })).toThrow();
  });

  test("aceita ERP_MYSQL_URL válido (mysql://)", () => {
    const result = parseEnv({
      API_KEY: "k",
      ERP_MYSQL_URL: "mysql://erp:senha@127.0.0.1:3306/barbearia_erp",
    });
    expect(result.ERP_MYSQL_URL).toBe("mysql://erp:senha@127.0.0.1:3306/barbearia_erp");
  });
});
