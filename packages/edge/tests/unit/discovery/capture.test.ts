import { describe, expect, test } from "bun:test";
import { parseMultipartChunks } from "../../../src/discovery/capture.js";

describe("parseMultipartChunks", () => {
  test("extrai eventos completos e devolve remainder vazio quando tudo terminou", () => {
    const boundary = "--myboundary";
    const buf = Buffer.from(
      [
        "--myboundary",
        "Content-Type: text/plain",
        "Content-Length: 42",
        "",
        'Code=VideoMotion;action=Start;index=0;data={"foo":"bar"}',
        "--myboundary",
        "Content-Type: text/plain",
        "Content-Length: 30",
        "",
        "Code=AlarmLocal;action=Start;index=1",
        "--myboundary--",
      ].join("\r\n"),
    );
    const { events, remainder } = parseMultipartChunks(buf, boundary);
    expect(events).toHaveLength(2);
    expect(events[0]).toContain("VideoMotion");
    expect(events[1]).toContain("AlarmLocal");
    // remainder começa no boundary final ("--myboundary--"), preservando bytes do
    // marcador de fim para que próximas chamadas concatenadas sigam consistentes.
    expect(remainder.toString("utf8")).toMatch(/^--myboundary/);
  });

  test("preserva chunk parcial quando boundary não fecha", () => {
    const boundary = "--b";
    const buf = Buffer.from(
      [
        "--b",
        "Content-Type: text/plain",
        "",
        "first event",
        "--b",
        "Content-Type: text/plain",
        "",
        "partial event without closing boundary",
      ].join("\r\n"),
    );
    const { events, remainder } = parseMultipartChunks(buf, boundary);
    expect(events).toHaveLength(1);
    expect(events[0]).toBe("first event");
    expect(remainder.toString("utf8")).toContain("partial event");
  });

  test("retorna eventos vazios e remainder original quando nenhum boundary é encontrado", () => {
    const buf = Buffer.from("garbage data without boundary");
    const { events, remainder } = parseMultipartChunks(buf, "--bound");
    expect(events).toEqual([]);
    expect(remainder.length).toBe(buf.length);
  });
});
