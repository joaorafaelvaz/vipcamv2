import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
// NOTA (bun:test mock.module process-wide): este arquivo registra mocks
// de `node-cron` + 4 deps do scheduler. `mock.module` em bun:test é
// PROCESS-WIDE — outros arquivos do suite que mockam os mesmos paths
// podem sobrescrever. Re-registramos no beforeEach (via installMocks) pra
// defender contra ordem de execução. Padrão herdado de
// packages/web/tests/unit/lib/queries-events.test.tsx (Onda 8 — documenta
// limitação conhecida).
//
// CUIDADO: NÃO mockamos `src/api/reid/snapshot-store.js` nem
// `src/config/env.js` — leak process-wide quebraria outros suites
// (snapshot-store.test.ts importa a real pruneOlderThan; env.ts é central).
// Em vez disso: usamos o real `pruneOlderThan` apontando SNAPSHOTS_DIR
// via `process.env` real + `resetEnvCache()` pra rebustar o singleton.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const captured: Array<{
  cronExpr: string;
  cb: () => Promise<void> | void;
  tz: string | undefined;
}> = [];

const installMocks = () => {
  mock.module("node-cron", () => ({
    default: {
      schedule: (
        cronExpr: string,
        cb: () => Promise<void> | void,
        opts?: { timezone?: string },
      ) => {
        captured.push({ cronExpr, cb, tz: opts?.timezone });
        return { stop: () => {} };
      },
    },
  }));
  mock.module("../../../src/erp-sync/checkins.js", () => ({ pollCheckins: async () => {} }));
  mock.module("../../../src/erp-sync/clients.js", () => ({ syncClients: async () => {} }));
  mock.module("../../../src/erp-sync/employees.js", () => ({ syncEmployees: async () => {} }));
  mock.module("../../../src/match-temp/orchestrator.js", () => ({
    processAllPendingCheckins: async () => {},
  }));
};
installMocks();

import { resetEnvCache } from "../../../src/config/env.js";
import { _resetHealth, getJobHealth } from "../../../src/erp-sync/scheduler-health.js";
import { startScheduler } from "../../../src/erp-sync/scheduler.js";

let tmpSnapsDir = "";
let originalEnv: Record<string, string | undefined>;

beforeEach(async () => {
  captured.length = 0;
  tmpSnapsDir = await fs.mkdtemp(path.join(os.tmpdir(), "snap-retention-test-"));
  originalEnv = {
    SNAPSHOTS_DIR: process.env.SNAPSHOTS_DIR,
    API_KEY: process.env.API_KEY,
  };
  process.env.SNAPSHOTS_DIR = tmpSnapsDir;
  // API_KEY é required pelo schema — set mínimo pra parseEnv não throw.
  if (!process.env.API_KEY) process.env.API_KEY = "test-key";
  resetEnvCache();
  _resetHealth();
  installMocks();
});
afterEach(async () => {
  if (tmpSnapsDir) await fs.rm(tmpSnapsDir, { recursive: true, force: true });
  // Restaura env real pra não vazar pra outros suites.
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
});

describe("snapshot_retention job (Onda 7)", () => {
  test("startScheduler registers snapshot_retention diário às 03:00 BRT", () => {
    const h = startScheduler();
    h.stop();
    const j = captured.find((c) => c.cronExpr === "0 3 * * *");
    expect(j).toBeDefined();
    expect(j!.tz).toBe("America/Sao_Paulo");
  });

  test("snapshot_retention job runs pruneOlderThan against SNAPSHOTS_DIR and marks success", async () => {
    // Sanity: cria um dir antigo (>30d) que DEVE ser pruned e um recente que NÃO deve.
    const old = path.join(tmpSnapsDir, "2020-01-01");
    const recent = path.join(tmpSnapsDir, new Date().toISOString().slice(0, 10));
    await fs.mkdir(old, { recursive: true });
    await fs.mkdir(recent, { recursive: true });
    const past = new Date(Date.now() - 60 * 86400_000);
    await fs.utimes(old, past, past);

    const h = startScheduler();
    const j = captured.find((c) => c.cronExpr === "0 3 * * *");
    expect(j).toBeDefined();
    await j!.cb();
    h.stop();

    // Old dir (60d > 30d retention) deletado; recent preservado.
    const remaining = await fs.readdir(tmpSnapsDir);
    expect(remaining).not.toContain("2020-01-01");
    expect(remaining.length).toBe(1);

    const health = getJobHealth();
    const snap = health.find((x) => x.name === "snapshot_retention");
    expect(snap?.healthy).toBe(true);
    expect(snap?.last_success_at).toBeInstanceOf(Date);
  });
});
