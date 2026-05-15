import { EventEmitter } from "node:events";
import type { LiveDetectionEvent } from "@vipcam/shared";

/**
 * Event bus interno do edge — produtor único (pipeline.ts) e múltiplos
 * subscribers (SSE clients). Singleton de módulo (Onda 3 Task 3.2.3).
 *
 * Tolera zero subscribers (pipeline.publish nunca bloqueia ingest). Não há
 * buffer histórico — clientes que conectam só veem events futuros.
 *
 * Limite implícito: MaxListeners default do EventEmitter é 10. Subimos pra
 * 50 pra suportar múltiplos dashboards abertos simultaneamente sem warning.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(50);
const EVENT_NAME = "detection";

export const eventBus = {
  publish(event: LiveDetectionEvent): void {
    emitter.emit(EVENT_NAME, event);
  },
  subscribe(handler: (event: LiveDetectionEvent) => void): () => void {
    emitter.on(EVENT_NAME, handler);
    return () => emitter.off(EVENT_NAME, handler);
  },
  subscriberCount(): number {
    return emitter.listenerCount(EVENT_NAME);
  },
};

/** Reset interno só para testes — usar em afterEach. */
export function _resetEventBus(): void {
  emitter.removeAllListeners(EVENT_NAME);
}
