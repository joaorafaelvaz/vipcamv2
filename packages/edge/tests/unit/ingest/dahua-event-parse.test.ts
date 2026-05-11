import { describe, expect, test } from "bun:test";
import { parseDahuaEventLine } from "../../../src/ingest/dahua-event-parse.js";

describe("parseDahuaEventLine", () => {
  test("extrai code/action/data de uma linha Dahua válida", () => {
    const raw = 'Code=FaceDetection;action=Start;index=0;data={"Object":{"Age":30,"Sex":"Man"}}';
    const parsed = parseDahuaEventLine(raw);
    expect(parsed?.code).toBe("FaceDetection");
    expect(parsed?.action).toBe("Start");
    expect(parsed?.data).toEqual({ Object: { Age: 30, Sex: "Man" } });
  });

  test("aceita data como string quando JSON.parse falha", () => {
    const parsed = parseDahuaEventLine("Code=Test;action=Start;data=not-json{");
    expect(parsed?.data).toBe("not-json{");
  });

  test("retorna undefined para linha sem nenhum segmento útil", () => {
    expect(parseDahuaEventLine("garbage without equals")).toBeUndefined();
    expect(parseDahuaEventLine("")).toBeUndefined();
  });

  test("ignora segmentos sem '=' mas mantém os válidos", () => {
    const parsed = parseDahuaEventLine("Code=X;noequalshere;action=Y");
    expect(parsed?.code).toBe("X");
    expect(parsed?.action).toBe("Y");
  });
});
