import { describe, expect, test } from "bun:test";
import { parseMultipartPartsRaw } from "../../../../src/discovery/image-probe/raw-multipart.js";

const B = "--myboundary";

function part(headers: string, body: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${B}\r\n${headers}\r\n\r\n`),
    body,
    Buffer.from("\r\n"),
  ]);
}

describe("parseMultipartPartsRaw", () => {
  test("text part: headers parsed, body preserved", () => {
    const buf = Buffer.concat([
      part("Content-Type: text/plain", Buffer.from("Code=FaceDetection;action=Start")),
      Buffer.from(`${B}`),
    ]);
    const { parts } = parseMultipartPartsRaw(buf, B);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.headers["content-type"]).toBe("text/plain");
    expect(parts[0]!.body.toString("utf8")).toBe("Code=FaceDetection;action=Start");
  });

  test("binary image part with boundary-like bytes is NOT corrupted", () => {
    const evil = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from("--myboundaryISH-not-real"),
      Buffer.from([0x00, 0x80, 0xfe, 0xff]),
    ]);
    const buf = Buffer.concat([
      part("Content-Type: image/jpeg", evil),
      Buffer.from(`${B}`),
    ]);
    const { parts } = parseMultipartPartsRaw(buf, B);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.headers["content-type"]).toBe("image/jpeg");
    expect(Buffer.compare(parts[0]!.body, evil)).toBe(0);
  });

  test("incomplete trailing part → remainder kept from last complete boundary", () => {
    const complete = part("Content-Type: text/plain", Buffer.from("a"));
    const partial = Buffer.from(`${B}\r\nContent-Type: image/jpeg\r\n\r\n\xff\xd8`);
    const buf = Buffer.concat([complete, partial]);
    const { parts, remainder } = parseMultipartPartsRaw(buf, B);
    expect(parts).toHaveLength(1);
    expect(remainder.indexOf(Buffer.from(B))).toBeGreaterThanOrEqual(0);
  });

  test("multiple parts in one buffer", () => {
    const buf = Buffer.concat([
      part("Content-Type: text/plain", Buffer.from("x")),
      part("Content-Type: image/jpeg", Buffer.from([0x01, 0x02])),
      Buffer.from(`${B}`),
    ]);
    const { parts } = parseMultipartPartsRaw(buf, B);
    expect(parts.map((p) => p.headers["content-type"])).toEqual(["text/plain", "image/jpeg"]);
  });

  test("no boundary yet → no parts, whole buffer is remainder", () => {
    const buf = Buffer.from("partial bytes no boundary");
    const { parts, remainder } = parseMultipartPartsRaw(buf, B);
    expect(parts).toHaveLength(0);
    expect(remainder.length).toBe(buf.length);
  });
});
