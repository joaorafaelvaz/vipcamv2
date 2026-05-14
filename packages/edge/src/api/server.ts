import type { HealthCheck, HealthResponse, MatchPendingEnriched } from "@vipcam/shared";
import { and, asc, between, eq, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getEnv } from "../config/env.js";
import { getLatestReport, runDiscovery } from "../discovery/runner.js";
import { pollCheckins } from "../erp-sync/checkins.js";
import { syncClients } from "../erp-sync/clients.js";
import { syncEmployees } from "../erp-sync/employees.js";
import { getJobHealth } from "../erp-sync/scheduler-health.js";
import { resolveAmbiguous } from "../match-temp/review.js";
import { computeWindow } from "../match-temp/window.js";
import { logger as appLogger } from "../obs/logger.js";
import { getDb } from "../persistence/db.js";
import {
  detectionsRepo,
  matchAttemptsRepo,
  personsRepo,
  sessionsRepo,
} from "../persistence/repositories/index.js";
import { detections } from "../persistence/schema/detections.js";
import { erpCheckins, erpClients, erpEmployees } from "../persistence/schema/erp-cache.js";
import { persons } from "../persistence/schema/persons.js";
import { fetchDashboardSummary } from "./dashboard.queries.js";
import { apiKeyMiddleware } from "./middleware/api-key.js";
import { createDashboardRoutes } from "./routes/dashboard.js";
import { createDiscoveryRoutes } from "./routes/discovery.js";
import { createErpRoutes } from "./routes/erp.js";
import { createMatchRoutes } from "./routes/matches.js";
import { createPersonsRoutes } from "./routes/persons.js";
import { createSessionsRoutes } from "./routes/sessions.js";

export function createServer() {
  const app = new Hono();
  const startedAt = Date.now();
  const env = getEnv();

  // I3: protege rotas mutativas/sensíveis. /api/health fica anônimo
  // (usado por nginx/uptime monitoring).
  const requireKey = apiKeyMiddleware(env.API_KEY);
  app.use("/api/discovery/*", requireKey);
  app.use("/api/erp/*", requireKey);
  app.use("/api/matches/*", requireKey);
  // Onda 3: protege endpoints novos do dashboard
  app.use("/api/persons/*", requireKey);
  app.use("/api/sessions/*", requireKey);
  app.use("/api/dashboard/*", requireKey);

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
      listPending: async (limit) => {
        const db = getDb();
        const attempts = await matchAttemptsRepo.findPending(limit);
        if (attempts.length === 0) return [];

        const checkinIds = attempts
          .map((a) => a.erp_checkin_id)
          .filter((x): x is string => x !== null);
        const checkinRows =
          checkinIds.length > 0
            ? await db
                .select({
                  erp_id: erpCheckins.erp_id,
                  erp_client_id: erpCheckins.erp_client_id,
                  occurred_at: erpCheckins.occurred_at,
                  event_type: erpCheckins.event_type,
                  client_name: erpClients.name,
                  client_phone: erpClients.phone,
                  person_id: persons.id,
                })
                .from(erpCheckins)
                .leftJoin(erpClients, eq(erpCheckins.erp_client_id, erpClients.erp_id))
                .leftJoin(persons, eq(persons.erp_client_id, erpCheckins.erp_client_id))
                .where(inArray(erpCheckins.erp_id, checkinIds))
            : [];
        const checkinsById = new Map(checkinRows.map((c) => [c.erp_id, c]));

        const enriched: MatchPendingEnriched[] = [];
        for (const a of attempts) {
          if (!a.erp_checkin_id) continue;
          const checkin = checkinsById.get(a.erp_checkin_id);
          if (!checkin) continue;
          const window = computeWindow(checkin.occurred_at, env.MATCH_WINDOW_SECONDS);
          const candidatesDet = await db
            .select({
              id: detections.id,
              detected_at: detections.detected_at,
              snapshot_path: detections.snapshot_path,
              face_attrs: detections.face_attrs,
              dominant_emotion: detections.dominant_emotion,
              emotion_confidence: detections.emotion_confidence,
              session_id: detections.session_id,
              camera_id: detections.camera_id,
            })
            .from(detections)
            .where(
              and(
                isNull(detections.person_id),
                between(detections.detected_at, window.start, window.end),
              ),
            )
            .orderBy(asc(detections.detected_at));

          enriched.push({
            match_attempt_id: a.id,
            decided_at: a.decided_at.toISOString(),
            notes: a.notes,
            checkin: {
              erp_id: checkin.erp_id,
              client_name: checkin.client_name,
              client_phone: checkin.client_phone,
              erp_client_id: checkin.erp_client_id,
              person_id: checkin.person_id,
              occurred_at: checkin.occurred_at.toISOString(),
              event_type: checkin.event_type,
            },
            candidates: candidatesDet.map((d) => ({
              id: d.id,
              detected_at: d.detected_at.toISOString(),
              snapshot_path: d.snapshot_path,
              face_attrs: d.face_attrs as Record<string, unknown>,
              dominant_emotion: d.dominant_emotion,
              emotion_confidence: d.emotion_confidence,
              session_id: d.session_id,
              camera_id: d.camera_id,
            })),
          });
        }
        return enriched;
      },
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

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.onError((err, c) => {
    appLogger.error({ err }, "unhandled error");
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
