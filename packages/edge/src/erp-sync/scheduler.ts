import cron from "node-cron";
import { pruneOlderThan } from "../api/reid/snapshot-store.js";
import { getEnv } from "../config/env.js";
import { processAllPendingCheckins } from "../match-temp/orchestrator.js";
import { logger } from "../obs/logger.js";
import { pollCheckins } from "./checkins.js";
import { syncClients } from "./clients.js";
import { syncEmployees } from "./employees.js";
import { recordJobFailure, recordJobSuccess } from "./scheduler-health.js";

export interface SchedulerHandle {
  stop: () => void;
}

/**
 * Guard contra invocações concorrentes do mesmo job + tracking de health.
 *
 * node-cron NÃO previne overlap: se um sync demora mais que o intervalo
 * (ex: poll de 30s mas a query do ERP travou por 1min), o cron dispara
 * uma 2ª invocação enquanto a 1ª ainda está rodando — pode causar
 * pollCheckins() em paralelo bagunçando o cursor in-memory + corromper
 * sync employees/clients.
 *
 * Skip silencioso (warn log) é a estratégia: a próxima invocação cron
 * naturalmente continua de onde parou.
 *
 * **I4 (review 2026-05-13):** após cada execução, registra success/failure
 * no scheduler-health registry pra /api/health refletir degradação se job
 * falhar consistentemente (ex: schema do ERP mudou em runtime).
 */
function withRunningGuard(name: string, fn: () => Promise<void>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) {
      logger.warn({ job: name }, "scheduler: skipping — previous run still in progress");
      // Skip não conta como failure (job anterior ainda rodando ≠ erro do job atual)
      return;
    }
    running = true;
    try {
      await fn();
      recordJobSuccess(name);
    } catch (err) {
      logger.error({ err, job: name }, "scheduled job failed");
      recordJobFailure(name, err);
    } finally {
      running = false;
    }
  };
}

/**
 * Inicia 3 cron jobs ERP-related:
 * - employees: hourly (mudanças raras — funcionário não vira cliente do dia pra noite)
 * - clients: a cada 15min (cadastros + atualizações de phone/nome)
 * - checkins + match temporal: a cada 30s (near-real-time pra vincular detecções
 *   anônimas aos clientes que acabaram de fazer checkin)
 *
 * Retorna handle pra parar tudo (graceful shutdown).
 */
export function startScheduler(): SchedulerHandle {
  const empJob = cron.schedule(
    "0 * * * *",
    withRunningGuard("employees", async () => {
      await syncEmployees();
    }),
  );

  const cliJob = cron.schedule(
    "*/15 * * * *",
    withRunningGuard("clients", async () => {
      await syncClients();
    }),
  );

  const chkJob = cron.schedule(
    "*/30 * * * * *",
    withRunningGuard("checkins", async () => {
      await pollCheckins();
      await processAllPendingCheckins();
    }),
  );

  // 03:00 BRT — timezone explícito porque VPS systemd roda em UTC e nesse caso
  // "0 3 * * *" puro fire-aria às 00:00 BRT (3h cedo). Pattern espelha
  // METRICS_TZ pra consistência (Onda 7 §2.4 + plan-reviewer round 2).
  const snapJob = cron.schedule(
    "0 3 * * *",
    withRunningGuard("snapshot_retention", async () => {
      const env = getEnv();
      const deleted = await pruneOlderThan({ baseDir: env.SNAPSHOTS_DIR, days: 30 });
      logger.info({ deleted }, "snapshot retention job — pruned old date dirs");
    }),
    { timezone: "America/Sao_Paulo" },
  );

  logger.info(
    "ERP sync scheduler started (employees=hourly, clients=15min, checkins=30s, snapshot_retention=daily-03:00)",
  );

  return {
    stop() {
      empJob.stop();
      cliJob.stop();
      chkJob.stop();
      snapJob.stop();
      logger.info("ERP sync scheduler stopped");
    },
  };
}
