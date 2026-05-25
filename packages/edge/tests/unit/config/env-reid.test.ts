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

  test("REID_DIST_STRICT defaults to 0.35", () => {
    expect(parseEnv(BASE).REID_DIST_STRICT).toBe(0.35);
  });

  test("REID_DIST_LOOSE defaults to 0.55", () => {
    expect(parseEnv(BASE).REID_DIST_LOOSE).toBe(0.55);
  });

  test("REID_DIST_STRICT rejects > REID_DIST_LOOSE (refine)", () => {
    expect(() =>
      parseEnv({ ...BASE, REID_DIST_STRICT: "0.6", REID_DIST_LOOSE: "0.5" }),
    ).toThrow(/REID_DIST_STRICT.*REID_DIST_LOOSE/);
  });

  test("REID_BASE_URL defaults to http://127.0.0.1:5005", () => {
    expect(parseEnv(BASE).REID_BASE_URL).toBe("http://127.0.0.1:5005");
  });

  test("SNAPSHOTS_DIR defaults to /var/lib/vipcam/snapshots", () => {
    expect(parseEnv(BASE).SNAPSHOTS_DIR).toBe("/var/lib/vipcam/snapshots");
  });
});
