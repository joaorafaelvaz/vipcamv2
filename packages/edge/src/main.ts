import { createServer } from "./api/server.js";
import { env } from "./config/env.js";
import { logger } from "./obs/logger.js";

const app = createServer();

const server = Bun.serve({
  port: env.EDGE_PORT,
  fetch: app.fetch,
});

logger.info(
  { port: server.port, env: env.NODE_ENV },
  `vipcam-edge listening on http://localhost:${server.port}`,
);

// Graceful shutdown
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutting down");
    server.stop();
    process.exit(0);
  });
}
