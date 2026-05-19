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

  test("2-call accumulation re-anchors boundary across adversarial mid-token split", () => {
    // Binary body that ALSO contains a boundary-like substring → split must
    // not corrupt it and substring must not be mistaken for a delimiter.
    const imageBody = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.from("--myboundary-but-not-anchored"),
      Buffer.from([0x00, 0x0d, 0x0a, 0x80, 0xfe, 0xff, 0xd9]),
    ]);
    const stream = Buffer.concat([
      part("Content-Type: text/plain", Buffer.from("Code=FaceDetection;action=Start")),
      part("Content-Type: image/jpeg", imageBody),
      Buffer.from(`${B}`), // trailing closing boundary
    ]);

    // The trailing closing boundary is the terminator for the image part.
    // Split in the MIDDLE of that boundary token: right after "\r\n--myb",
    // so call 1 has a complete 2nd boundary (→ emits text part) but only a
    // partial closing boundary (→ image part NOT emitted, remainder kept).
    const closingTokenStart = stream.lastIndexOf(Buffer.from(B));
    const splitAt = closingTokenStart + "--myb".length; // mid closing boundary
    const chunk1 = stream.subarray(0, splitAt);
    const chunk2 = stream.subarray(splitAt);

    const r1 = parseMultipartPartsRaw(chunk1, B);
    expect(r1.parts).toHaveLength(1);
    expect(r1.parts[0]!.headers["content-type"]).toBe("text/plain");
    expect(r1.parts[0]!.body.toString("utf8")).toBe("Code=FaceDetection;action=Start");
    expect(r1.remainder.length).toBeGreaterThan(0);
    // remainder still carries the start of the (truncated) closing boundary
    expect(r1.remainder.indexOf(Buffer.from("--myb"))).toBeGreaterThanOrEqual(0);

    const r2 = parseMultipartPartsRaw(Buffer.concat([r1.remainder, chunk2]), B);
    expect(r2.parts).toHaveLength(1);
    expect(r2.parts[0]!.headers["content-type"]).toBe("image/jpeg");
    expect(Buffer.compare(r2.parts[0]!.body, imageBody)).toBe(0);

    // No part duplicated across calls: text only in r1, image only in r2.
    const r1Types = r1.parts.map((p) => p.headers["content-type"]);
    const r2Types = r2.parts.map((p) => p.headers["content-type"]);
    expect(r1Types).toEqual(["text/plain"]);
    expect(r2Types).toEqual(["image/jpeg"]);
  });
});
