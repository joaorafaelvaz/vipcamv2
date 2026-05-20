"use client";

import { DetectionCard } from "@/components/detection-card";
import { Button } from "@/components/ui/button";
import { useRecentDetections } from "@/lib/queries/events";
import { useState } from "react";

const POLL_INTERVAL_MS = 3000;
const LIMIT = 50;

export function LiveFeed() {
  const [paused, setPaused] = useState(false);
  const query = useRecentDetections({
    limit: LIMIT,
    intervalMs: POLL_INTERVAL_MS,
    enabled: !paused,
  });

  const events = query.data ?? [];
  const label = paused
    ? "pausado"
    : query.isError
      ? "erro"
      : query.isFetching
        ? "atualizando"
        : "ao vivo";
  const labelColor = paused ? "text-slate-500" : query.isError ? "text-red-600" : "text-green-600";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 bg-white border rounded-md p-3">
        <div className="text-sm">
          <span className={labelColor}>●</span> {label}
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
          // key = detection.id — único por detection; estável entre polls.
          events.map((e, i) => <DetectionCard key={e.detection.id} event={e} fresh={i === 0} />)
        )}
      </div>
    </div>
  );
}
