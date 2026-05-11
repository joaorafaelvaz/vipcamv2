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
const listenerHandles: ListenerHandle[] = [];
if (env.DATABASE_URL && env.CAMERA_IP && env.CAMERA_USER && env.CAMERA_PASS) {
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
  } catch (err) {
    logger.error({ err }, "failed to start listeners — continuing without ingest");
  }
} else {
  logger.warn(
    {
      hasDb: !!env.DATABASE_URL,
      hasCamera: !!(env.CAMERA_IP && env.CAMERA_USER && env.CAMERA_PASS),
    },
    "listeners NOT started — DATABASE_URL or CAMERA_* missing",
  );
}

// Graceful shutdown
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, "shutting down");
    await Promise.all(listenerHandles.map((h) => h.stop()));
    server.stop();
    process.exit(0);
  });
}
