import cron from "node-cron";
import { processAllPendingCheckins } from "../match-temp/orchestrator.js";
import { logger } from "../obs/logger.js";
import { pollCheckins } from "./checkins.js";
import { syncClients } from "./clients.js";
import { syncEmployees } from "./employees.js";

export interface SchedulerHandle {
  stop: () => void;
}

/**
 * Guard contra invocações concorrentes do mesmo job.
 *
 * node-cron NÃO previne overlap: se um sync demora mais que o intervalo
 * (ex: poll de 30s mas a query do ERP travou por 1min), o cron dispara
 * uma 2ª invocação enquanto a 1ª ainda está rodando — pode causar
 * pollCheckins() em paralelo bagunçando o cursor in-memory + corromper
 * sync employees/clients.
 *
 * Skip silencioso (warn log) é a estratégia: a próxima invocação cron
 * naturalmente continua de onde parou.
 */
function withRunningGuard(name: string, fn: () => Promise<void>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) {
      logger.warn({ job: name }, "scheduler: skipping — previous run still in progress");
      return;
    }
    running = true;
    try {
      await fn();
    } catch (err) {
      logger.error({ err, job: name }, "scheduled job failed");
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

  logger.info("ERP sync scheduler started (employees=hourly, clients=15min, checkins=30s)");

  return {
    stop() {
      empJob.stop();
      cliJob.stop();
      chkJob.stop();
      logger.info("ERP sync scheduler stopped");
    },
  };
}
