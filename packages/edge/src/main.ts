import { createServer } from "./api/server.js";
import { getEnv } from "./config/env.js";
import { DahuaHttpClient } from "./ingest/dahua-http-client.js";
import { type ListenerHandle, startListener } from "./ingest/listener.js";
import { logger } from "./obs/logger.js";
import { camerasRepo } from "./persistence/repositories/index.js";

const env = getEnv();
const app = createServer();

const server = Bun.serve({
  port: env.EDGE_PORT,
  fetch: app.fetch,
});

logger.info(
  { port: server.port, env: env.NODE_ENV },
  `vipcam-edge listening on http://localhost:${server.port}`,
);

// Inicia listeners de câmera quando DB + credenciais disponíveis.
// Em modo discovery offline (sem DB ou sem credenciais) o servidor REST
// continua funcional mas não há ingest ativo.
//
// Boot resilience: se Postgres estiver indisponível no boot (ex: docker-compose
// não terminou de subir), tenta de novo a cada 5s por até 60s antes de desistir.
// Sem isso, edge sobe sem listener e fica silenciosamente ocioso até o próximo
// systemctl restart.
const listenerHandles: ListenerHandle[] = [];

async function startListenersWithRetry(): Promise<void> {
  if (!env.DATABASE_URL || !env.CAMERA_IP || !env.CAMERA_USER || !env.CAMERA_PASS) {
    logger.warn(
      {
        hasDb: !!env.DATABASE_URL,
        hasCamera: !!(env.CAMERA_IP && env.CAMERA_USER && env.CAMERA_PASS),
      },
      "listeners NOT started — DATABASE_URL or CAMERA_* missing",
    );
    return;
  }

  const maxAttempts = 12; // 12 × 5s = 60s total
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const cameras = await camerasRepo.listActive();
      for (const camera of cameras) {
        const client = new DahuaHttpClient({
          baseUrl: `http://${camera.ip_address}`,
          username: env.CAMERA_USER,
          password: env.CAMERA_PASS,
        });
        listenerHandles.push(startListener(camera, client));
        logger.info({ cameraId: camera.id, ip: camera.ip_address }, "listener started");
      }
      if (cameras.length === 0) {
        logger.warn("DATABASE_URL configured but no active cameras — seed the cameras table");
      }
      return; // sucesso, sai do loop
    } catch (err) {
      const isLastAttempt = attempt === maxAttempts;
      if (isLastAttempt) {
        logger.error(
          { err, attempt },
          "failed to start listeners after max retries — running without ingest. Manual restart required after fixing DB.",
        );
        return;
      }
      logger.warn({ err, attempt, maxAttempts }, "DB not ready, retrying listener startup in 5s");
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

// Fire-and-forget: não bloqueia HTTP server startup. Logs vão indicar progresso.
void startListenersWithRetry();

// Graceful shutdown
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, "shutting down");
    await Promise.all(listenerHandles.map((h) => h.stop()));
    server.stop();
    process.exit(0);
  });
}
