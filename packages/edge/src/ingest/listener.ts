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

// Onda 6: sampler de snapshot — singleton lazy (criado uma vez no 1º runOnce).
// Mesma lifetime do captureTap: `seq` monotônico sobrevive a reconexões,
// senão snap-0.* de uma reconexão sobrescreveria amostras da conexão anterior
// dentro da mesma run do probe.
let snapshotSampler: ReturnType<typeof makeSnapshotSampler> | null = null;

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

  if (snapshotSampler === null) snapshotSampler = makeSnapshotSampler(client);
  const sampler = snapshotSampler;

  await consumeStream({
    reader: response.body.getReader(),
    boundary,
    signal: abortCtrl.signal,
    // probeTap resolvido uma vez por conexão (toggle aplica em segundos via reconnect).
    ...(isProbeActive() ? { probeTap: captureTap } : {}),
    // Fire-and-forget — pipeline não pode bloquear leitura do socket
    onEvent: (captured) => {
      // Closure que captura frame inteiro via snapshot.cgi — injetada no
      // pipeline pra reid orchestrator (Onda 7 §2.1). Lazy: só executa
      // quando o pipeline decide rodar reid (evita snapshot pra eventos
      // não-Face / face.stop / sem bbox).
      const captureSnapshot = () =>
        client
          .get("/cgi-bin/snapshot.cgi?channel=1")
          .then((r) => r.arrayBuffer())
          .then((b) => Buffer.from(b));
      void processEvent(captured, camera.id, { captureSnapshot });
      if (isProbeActive() && captured.parsed) {
        const parsed = captured.parsed;
        void sampler({
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
