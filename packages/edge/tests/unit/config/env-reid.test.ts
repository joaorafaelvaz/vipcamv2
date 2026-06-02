import { describe, expect, test } from "bun:test";
import { parseEnv } from "../../../src/config/env.js";

const BASE = {
  API_KEY: "test-key",
};

describe("env Onda 7 vars", () => {
  test("REID_ENABLED defaults to true", () => {
    expect(parseEnv(BASE).REID_ENABLED).toBe(true);
  });

  test("REID_ENABLED accepts 'false'", () => {
    expect(parseEnv({ ...BASE, REID_ENABLED: "false" }).REID_ENABLED).toBe(false);
  });

  test("REID_ENABLED accepts 'true'", () => {
    expect(parseEnv({ ...BASE, REID_ENABLED: "true" }).REID_ENABLED).toBe(true);
  });

  // Onda 9-D: relaxado de 0.35 → 0.40 (consolidação no ingest — vide spec 9-D §4 Part A).
  test("REID_DIST_STRICT defaults to 0.40", () => {
    expect(parseEnv(BASE).REID_DIST_STRICT).toBe(0.4);
  });

  test("REID_DIST_LOOSE defaults to 0.55", () => {
    expect(parseEnv(BASE).REID_DIST_LOOSE).toBe(0.55);
  });

  test("REID_DIST_STRICT rejects > REID_DIST_LOOSE (refine)", () => {
    expect(() => parseEnv({ ...BASE, REID_DIST_STRICT: "0.6", REID_DIST_LOOSE: "0.5" })).toThrow(
      /REID_DIST_STRICT.*REID_DIST_LOOSE/,
    );
  });

  test("REID_BASE_URL defaults to http://127.0.0.1:5005", () => {
    expect(parseEnv(BASE).REID_BASE_URL).toBe("http://127.0.0.1:5005");
  });

  test("SNAPSHOTS_DIR defaults to /var/lib/vipcam/snapshots", () => {
    expect(parseEnv(BASE).SNAPSHOTS_DIR).toBe("/var/lib/vipcam/snapshots");
  });

  test("CAMERA_FRAME_WIDTH defaults to 2688", () => {
    expect(parseEnv(BASE).CAMERA_FRAME_WIDTH).toBe(2688);
  });

  test("CAMERA_FRAME_HEIGHT defaults to 1520", () => {
    expect(parseEnv(BASE).CAMERA_FRAME_HEIGHT).toBe(1520);
  });
});
