import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { HealthCheck, HealthResponse } from "@vipcam/shared";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { getEnv } from "../config/env.js";
import { getLatestReport, runDiscovery } from "../discovery/runner.js";
import { pollCheckins } from "../erp-sync/checkins.js";
import { syncClients } from "../erp-sync/clients.js";
import { syncEmployees } from "../erp-sync/employees.js";
import { getJobHealth } from "../erp-sync/scheduler-health.js";
import { resolveAmbiguous } from "../match-temp/review.js";
import { logger as appLogger } from "../obs/logger.js";
import { getDb } from "../persistence/db.js";
import {
  detectionsRepo,
  matchAttemptsRepo,
  personsRepo,
  sessionsRepo,
} from "../persistence/repositories/index.js";
import { erpCheckins, erpClients, erpEmployees } from "../persistence/schema/erp-cache.js";
import { fetchDashboardSummary } from "./dashboard.queries.js";
import { eventBus } from "./events/event-bus.js";
import { listPendingEnriched } from "./match-pending.js";
import { overviewMetrics } from "./metrics.queries.js";
import { apiKeyMiddleware } from "./middleware/api-key.js";
import { DEFAULT_THRESHOLDS } from "../discovery/image-probe/decision.js";
import {
  buildImageSourceReport,
  renderDecisionMarkdown,
} from "../discovery/image-probe/report.js";
import {
  imageProbeStatus,
  startImageProbe,
  stopImageProbe,
} from "../discovery/image-probe/state.js";
import { validateSamples } from "../discovery/image-probe/validate.js";
import { createDashboardRoutes } from "./routes/dashboard.js";
import { createDiscoveryRoutes } from "./routes/discovery.js";
import { createImageProbeRoutes } from "./routes/image-probe.js";
import { createErpRoutes } from "./routes/erp.js";
import { createEventsRoutes } from "./routes/events.js";
import { createMatchRoutes } from "./routes/matches.js";
import { createMetricsRoutes } from "./routes/metrics.js";
import { createPersonsRoutes } from "./routes/persons.js";
import { createSessionsRoutes } from "./routes/sessions.js";
import { createSnapshotsRoutes } from "./routes/snapshots.js";

export function createServer() {
  const app = new Hono();
  const startedAt = Date.now();
  const env = getEnv();

  // I3: protege rotas mutativas/sensíveis. /api/health fica anônimo
  // (usado por nginx/uptime monitoring).
  // Onda 3 Task 3.2.6: allowQueryOn permite ?api_key= em /api/events/stream
  // (EventSource browser não suporta headers customizados).
  const requireKey = apiKeyMiddleware(env.API_KEY, {
    allowQueryOn: "/api/events/stream",
  });
  app.use("/api/discovery/*", requireKey);
  app.use("/api/erp/*", requireKey);
  app.use("/api/matches/*", requireKey);
  // Onda 3: protege endpoints novos do dashboard + SSE
  app.use("/api/persons/*", requireKey);
  app.use("/api/sessions/*", requireKey);
  app.use("/api/dashboard/*", requireKey);
  app.use("/api/metrics/*", requireKey);
  app.use("/api/events/*", requireKey);

  app.get("/api/health", async (c) => {
    const checks: Record<string, HealthCheck> = { edge: { ok: true } };

    if (env.DATABASE_URL) {
      const t0 = Date.now();
      try {
        await getDb().execute(sql`SELECT 1`);
        checks.db = { ok: true, latency_ms: Date.now() - t0 };
      } catch (err) {
        checks.db = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // I4 (review 2026-05-13): expõe estado de cada job do scheduler. Após
    // N failures consecutivas, o check fica ok=false e degrada o overall
    // status pra que monitoring/uptime alerte (ex: schema do ERP mudou em
    // runtime e queries começam a throw a cada 30s).
    for (const job of getJobHealth()) {
      const check: HealthCheck = { ok: job.healthy };
      if (!job.healthy && job.last_error) check.error = job.last_error;
      checks[`scheduler_${job.name}`] = check;
    }

    const allOk = Object.values(checks).every((ck) => ck.ok);
    const status: HealthResponse["status"] = allOk ? "healthy" : "degraded";
    const body: HealthResponse = {
      status,
      uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
      checks,
    };
    return c.json(body, allOk ? 200 : 503);
  });
  // Onda 6 — camera image-source probe control surface.
  // Montado ANTES de /api/discovery (defensivo: discovery.ts só define
  // /probe + /last-report, sem wildcard, então não há shadow). Herda o
  // requireKey de /api/discovery/* (app.use acima).
  const PROBE_SAMPLES_DIR =
    process.env.PROBE_SAMPLES_DIR ?? "/var/lib/vipcam/probe-samples";
  const REID_BASE_URL = process.env.REID_BASE_URL ?? "http://127.0.0.1:5005";
  app.route(
    "/api/discovery/image-probe",
    createImageProbeRoutes({
      start: (cfg) => startImageProbe({ ...cfg, sampleDir: PROBE_SAMPLES_DIR }),
      stop: stopImageProbe,
      status: imageProbeStatus,
      defaultThresholds: DEFAULT_THRESHOLDS,
      runValidation: async (thresholds) => {
        const v = await validateSamples({
          sampleDir: PROBE_SAMPLES_DIR,
          reidBaseUrl: REID_BASE_URL,
          thresholds,
        });
        const report = buildImageSourceReport({
          runId: imageProbeStatus().run_id ?? "run-adhoc",
          faceEvents: v.faceEvents,
          metrics: v.metrics,
          thresholds,
        });
        await fs.mkdir(PROBE_SAMPLES_DIR, { recursive: true });
        await fs.writeFile(
          path.join(PROBE_SAMPLES_DIR, "report.json"),
          JSON.stringify(report, null, 2),
          "utf8",
        );
        await fs.writeFile(
          path.join(PROBE_SAMPLES_DIR, "decision.md"),
          renderDecisionMarkdown(report),
          "utf8",
        );
        return report;
      },
    }),
  );

  app.route(
    "/api/discovery",
    createDiscoveryRoutes({
      env: {
        CAMERA_IP: env.CAMERA_IP,
        CAMERA_USER: env.CAMERA_USER,
        CAMERA_PASS: env.CAMERA_PASS,
      },
      runDiscovery,
      getLatestReport,
    }),
  );

  // ERP sync — botões manuais (cron já roda em background via scheduler).
  // Útil pra forçar re-sync após editar query no .env ou debugar feed.
  app.route(
    "/api/erp",
    createErpRoutes({
      syncEmployees,
      syncClients,
      pollCheckins,
      status: async () => {
        const db = getDb();
        const [emp] = await db.select({ c: sql<number>`count(*)::int` }).from(erpEmployees);
        const [cli] = await db.select({ c: sql<number>`count(*)::int` }).from(erpClients);
        const [chk] = await db
          .select({ max: sql<Date | null>`max(${erpCheckins.occurred_at})` })
          .from(erpCheckins);
        return {
          employees_count: emp?.c ?? 0,
          clients_count: cli?.c ?? 0,
          last_checkin_at: chk?.max ? new Date(chk.max).toISOString() : null,
        };
      },
    }),
  );

  // Revisão manual de match_attempts ambíguos.
  // resolveAmbiguous (match-temp/review.ts) wrappa as writes em db.transaction
  // (C2 fix) e valida semanticamente que detection ∈ window do checkin e que
  // person.erp_client_id (se setado) bate com checkin.erp_client_id.
  // Errors tipados (ResolveError) viram HTTP code apropriado no route handler.
  //
  // Onda 3 Task 3.1.8 (BREAKING): listPending agora retorna MatchPendingEnriched[]
  // (com checkin info + candidates detections) em vez de MatchAttempt[] cru.
  // person_id resolvido via JOIN persons.erp_client_id pra UI poder chamar
  // POST /resolve direto sem lookup adicional.
  app.route(
    "/api/matches",
    createMatchRoutes({
      listPending: (limit) => listPendingEnriched(limit),
      resolve: resolveAmbiguous,
      reject: (id, reason) => matchAttemptsRepo.rejectAmbiguous(id, reason).then(() => undefined),
    }),
  );

  // Onda 3 — endpoints novos pro dashboard frontend
  app.route(
    "/api/persons",
    createPersonsRoutes({
      list: (params) => personsRepo.listWithFilters(params),
      getById: (id) => personsRepo.findByIdWithStats(id),
      listSessions: (id, limit) => sessionsRepo.listByPerson(id, limit),
    }),
  );

  app.route(
    "/api/sessions",
    createSessionsRoutes({
      listDetections: async (sessionId) => {
        const dets = await detectionsRepo.listBySession(sessionId);
        return dets.map((d) => ({
          id: d.id,
          detected_at: d.detected_at.toISOString(),
          snapshot_path: d.snapshot_path,
          face_attrs: d.face_attrs as Record<string, unknown>,
          dominant_emotion: d.dominant_emotion,
          emotion_confidence: d.emotion_confidence,
          session_id: d.session_id,
          camera_id: d.camera_id,
        }));
      },
    }),
  );

  app.route("/api/dashboard", createDashboardRoutes({ summary: fetchDashboardSummary }));
  app.route(
    "/api/metrics",
    createMetricsRoutes({
      overview: (days) => overviewMetrics(days),
    }),
  );

  // Onda 3 Task 3.2.6: SSE pro live feed
  app.route(
    "/api/events",
    createEventsRoutes({
      subscribe: (handler) => eventBus.subscribe(handler),
    }),
  );

  // Onda 3 Task 3.2.6: snapshots públicos (nginx restringe LAN).
  // Filename já é validado pela rota (regex anti-traversal); path.join é seguro.
  const SNAPSHOTS_DIR = process.env.SNAPSHOTS_DIR ?? "/var/lib/vipcam/snapshots";
  app.route(
    "/snapshots",
    createSnapshotsRoutes({
      readSnapshot: async (filename) => {
        const fullPath = path.join(SNAPSHOTS_DIR, filename);
        try {
          return await fs.readFile(fullPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw err;
        }
      },
    }),
  );

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.onError((err, c) => {
    appLogger.error({ err }, "unhandled error");
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
