import type { LiveDetectionEvent } from "@vipcam/shared";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

export interface EventsDeps {
  /**
   * Subscribe pro bus de eventos. Retorna função pra unsubscribe.
   * Em produção: `eventBus.subscribe`. Em test: mock.
   */
  subscribe: (handler: (event: LiveDetectionEvent) => void) => () => void;
  /** Intervalo do heartbeat em ms. Default 15s. */
  heartbeatMs?: number;
}

/**
 * Endpoint SSE pra Live feed (Onda 3 Task 3.2.4).
 *
 * GET /stream?api_key=KEY  → text/event-stream
 *
 * Auth via apiKeyMiddleware.allowQueryOn (browser EventSource não passa
 * headers, então aceita key no query param SOMENTE neste path).
 *
 * Heartbeat 15s evita timeout de proxy nginx (default 60s) e detecta
 * clientes mortos via half-close.
 */
export function createEventsRoutes(deps: EventsDeps): Hono {
  const r = new Hono();
  const heartbeatMs = deps.heartbeatMs ?? 15_000;

  r.get("/stream", (c) => {
    return streamSSE(c, async (stream) => {
      // writeSSE retorna Promise mas não awaitamos (lossy mas OK pra
      // ambient feed; rate baixo: 10-30/min em pico).
      const unsubscribe = deps.subscribe((event) => {
        void stream.writeSSE({ data: JSON.stringify(event) });
      });

      // Heartbeat — também detecta cliente desconectado quando writeSSE
      // throw em conexão fechada
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: "" });
      }, heartbeatMs);

      // Cleanup on abort
      stream.onAbort(() => {
        clearInterval(heartbeat);
        unsubscribe();
      });

      // Mantém o handler vivo até o cliente desconectar
      await new Promise<void>(() => {});
    });
  });

  return r;
}
