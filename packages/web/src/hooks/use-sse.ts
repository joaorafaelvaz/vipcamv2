"use client";

import { useEffect, useRef, useState } from "react";

type ConnState = "connecting" | "open" | "error" | "closed";

export interface UseSseOptions<T> {
  url: string;
  onMessage: (data: T) => void;
  onError?: (err: Event) => void;
  /** Backoff inicial em ms. Default 3000. */
  initialBackoffMs?: number;
  /** Backoff máximo em ms. Default 30000. */
  maxBackoffMs?: number;
}

/**
 * Hook SSE com auto-reconnect (exponential backoff). Cancela on unmount.
 * EventSource nativo do browser — auth via ?api_key= no url (header não
 * suportado pelo EventSource; edge aceita query param só em /events/stream).
 */
export function useSse<T>({
  url,
  onMessage,
  onError,
  initialBackoffMs = 3000,
  maxBackoffMs = 30_000,
}: UseSseOptions<T>) {
  const [state, setState] = useState<ConnState>("connecting");
  const onMsgRef = useRef(onMessage);
  onMsgRef.current = onMessage;
  // I1 (review 2026-05-15): onError fora das deps do effect. Se um consumer
  // passar onError inline (não-memoizado), tê-lo nas deps recriaria o
  // EventSource a cada render (reconnect storm). Ref evita isso.
  const onErrRef = useRef(onError);
  onErrRef.current = onError;

  useEffect(() => {
    let backoff = initialBackoffMs;
    let cancelled = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      setState("connecting");
      es = new EventSource(url);
      es.onopen = () => {
        if (cancelled) return;
        setState("open");
        backoff = initialBackoffMs;
      };
      es.onmessage = (ev: MessageEvent) => {
        try {
          const parsed = JSON.parse(ev.data) as T;
          onMsgRef.current(parsed);
        } catch (err) {
          console.warn("SSE parse error", err);
        }
      };
      es.onerror = (err: Event) => {
        if (cancelled) return;
        setState("error");
        onErrRef.current?.(err);
        es?.close();
        reconnectTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, maxBackoffMs);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
      setState("closed");
    };
  }, [url, initialBackoffMs, maxBackoffMs]);

  return { state };
}
