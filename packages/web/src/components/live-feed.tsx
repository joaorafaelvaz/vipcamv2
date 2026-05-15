"use client";

import { DetectionCard } from "@/components/detection-card";
import { Button } from "@/components/ui/button";
import { useSse } from "@/hooks/use-sse";
import { getClientEnv } from "@/lib/env";
import type { LiveDetectionEvent } from "@vipcam/shared";
import { useCallback, useRef, useState } from "react";

const MAX_EVENTS = 50;

export function LiveFeed() {
  const env = getClientEnv();
  const url = `${env.NEXT_PUBLIC_API_URL}/api/events/stream?api_key=${encodeURIComponent(
    env.NEXT_PUBLIC_API_KEY,
  )}`;
  const [events, setEvents] = useState<LiveDetectionEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  const onMessage = useCallback((data: LiveDetectionEvent) => {
    if (pausedRef.current) return;
    if (data.type !== "detection") return;
    setEvents((prev) => [data, ...prev].slice(0, MAX_EVENTS));
  }, []);

  const { state } = useSse<LiveDetectionEvent>({ url, onMessage });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 bg-white border rounded-md p-3">
        <div className="text-sm">
          <span className={state === "open" ? "text-green-600" : "text-red-600"}>●</span>{" "}
          {state === "open" ? "conectado" : state}
        </div>
        <div className="text-sm text-slate-500">
          {events.length} detec{events.length === 1 ? "ção" : "ções"} no buffer
        </div>
        <Button
          variant="outline"
          size="sm"
          aria-label="Pausar/Retomar live feed"
          onClick={() => setPaused((p) => !p)}
          className="ml-auto"
        >
          {paused ? "▶ Retomar" : "⏸ Pausar"}
        </Button>
      </div>

      <div>
        {events.length === 0 ? (
          <div className="text-slate-500 italic text-center py-12">
            Aguardando primeira detecção…
          </div>
        ) : (
          events.map((e, i) => (
            // M2: key = detection.id (UUID único por detection). Antes usava
            // index — no ring buffer (prepend) os índices deslocam a cada
            // evento, forçando re-render completo da lista a cada tick.
            <DetectionCard key={e.detection.id} event={e} fresh={i === 0} />
          ))
        )}
      </div>
    </div>
  );
}
