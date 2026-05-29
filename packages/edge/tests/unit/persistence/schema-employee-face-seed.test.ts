import { describe, expect, test } from "bun:test";
import { faceRecords } from "../../../src/persistence/schema/face-records.js";
import { persons } from "../../../src/persistence/schema/persons.js";

describe("Onda 9-B schema additions", () => {
  test("persons has last_embedded_image_token (nullable text)", () => {
    const col = (persons as unknown as { last_embedded_image_token?: { notNull?: boolean } })
      .last_embedded_image_token;
    expect(col).toBeDefined();
    expect(col?.notNull).not.toBe(true);
  });

  test("face_records has source (NOT NULL, default live_detection)", () => {
    const col = (faceRecords as unknown as {
      source?: { notNull?: boolean; default?: unknown };
    }).source;
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(true);
    expect(col?.default).toBe("live_detection");
  });
});
