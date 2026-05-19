import { makeCaptureTap } from "../discovery/image-probe/capture-tap.js";
import { makeSnapshotSampler } from "../discovery/image-probe/snapshot-sampler.js";
import { isProbeActive } from "../discovery/image-probe/state.js";
import { logger } from "../obs/logger.js";
import type { Camera } from "../persistence/schema/cameras.js";
import type { DahuaHttpClient } from "./dahua-http-client.js";
import { consumeStream } from "./listener-stream.js";
import { processEvent } from "./pipeline.js";

// Onda 6: tap de captura compartilhado (criado uma vez; no-op quando probe inativo).
const captureTap = makeCaptureTap();

const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export interface ListenerHandle {
  stop: () => Promise<void>;
}

/**
 * Mantém um long-poll persistente contra eventManager.cgi attach.
 * Reconecta automaticamente em erro com backoff exponencial.
 * Cada chunk multipart vira um CapturedEvent que vai pra processEvent().
 */
export function startListener(camera: Camera, client: DahuaHttpClient): ListenerHandle {
  let stopped = false;
  let abortCtrl: AbortController | null = null;

  async function loop() {
    let backoffIdx = 0;
    while (!stopped) {
      abortCtrl = new AbortController();
      try {
        await runOnce(camera, client, abortCtrl);
        // Conexão fechou normalmente — backoff curto antes de reconectar
        backoffIdx = 0;
        await sleep(1_000);
      } catch (err) {
        if (stopped) break;
        const wait =
          RECONNECT_BACKOFF_MS[Math.min(backoffIdx, RECONNECT_BACKOFF_MS.length - 1)] ?? 30_000;
        logger.warn({ err, wait, cameraId: camera.id }, "listener error, will reconnect");
        await sleep(wait);
        backoffIdx += 1;
      }
    }
    logger.info({ cameraId: camera.id }, "listener stopped");
  }

  // Fire-and-forget: caller controla via handle.stop()
  void loop();

  return {
    async stop() {
      stopped = true;
      abortCtrl?.abort();
    },
  };
}

async function runOnce(
  camera: Camera,
  client: DahuaHttpClient,
  abortCtrl: AbortController,
): Promise<void> {
  const path = "/cgi-bin/eventManager.cgi?action=attach&codes=[All]";
  logger.info({ cameraId: camera.id, path }, "listener connecting");

  const response = await client.getStream(path, { signal: abortCtrl.signal });
  if (!response.body) throw new Error("no body in stream response");

  const ct = response.headers.get("content-type") ?? "";
  const boundaryMatch = ct.match(/boundary=([^;]+)/i);
  const boundary = boundaryMatch?.[1] ? `--${boundaryMatch[1]}` : "--myboundary";

  const snapshotSampler = makeSnapshotSampler(client);

  await consumeStream({
    reader: response.body.getReader(),
    boundary,
    signal: abortCtrl.signal,
    // probeTap resolvido uma vez por conexão (toggle aplica em segundos via reconnect).
    ...(isProbeActive() ? { probeTap: captureTap } : {}),
    // Fire-and-forget — pipeline não pode bloquear leitura do socket
    onEvent: (captured) => {
      void processEvent(captured, camera.id);
      if (isProbeActive() && captured.parsed) {
        const parsed = captured.parsed;
        void snapshotSampler({
          idx: captured.index,
          ...(parsed.code !== undefined ? { code: parsed.code } : {}),
          ...(parsed.data !== undefined ? { data: parsed.data } : {}),
          received_at: captured.received_at,
        });
      }
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
