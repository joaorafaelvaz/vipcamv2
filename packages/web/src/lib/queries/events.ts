import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { LiveDetectionEvent } from "@vipcam/shared";
import { apiFetch } from "../api-client";

export interface UseRecentDetectionsOpts {
  /** Max events returned per request (1..200). Default 50. */
  limit?: number;
  /** Polling interval in ms. Default 3000. */
  intervalMs?: number;
  /** When false, polling is paused (no fetch). Default true. */
  enabled?: boolean;
}

/**
 * Polling-based live feed source (Onda 8). Substitui o EventSource antigo
 * (`useSse`) — provado inconsertável sob nginx HTTP/2 deste setup. Pausa
 * automaticamente quando a aba está oculta (Page Visibility via React
 * Query `refetchIntervalInBackground:false`).
 */
export function useRecentDetections(opts: UseRecentDetectionsOpts = {}) {
  const limit = opts.limit ?? 50;
  const intervalMs = opts.intervalMs ?? 3000;
  const enabled = opts.enabled ?? true;

  return useQuery<LiveDetectionEvent[]>({
    queryKey: ["events", "recent", limit],
    queryFn: ({ signal }) =>
      apiFetch<LiveDetectionEvent[]>(`/api/events/recent?limit=${limit}`, { signal }),
    enabled,
    refetchInterval: enabled ? intervalMs : false,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}
