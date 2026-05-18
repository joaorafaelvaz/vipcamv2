"use client";

import { MetricKpis } from "@/components/metrics/metric-kpis";
import { PeakHoursHeatmap } from "@/components/metrics/peak-hours-heatmap";
import { RecurrenceDonut } from "@/components/metrics/recurrence-donut";
import { SentimentBars } from "@/components/metrics/sentiment-bars";
import { VisitsFlowChart } from "@/components/metrics/visits-flow-chart";
import { Skeleton } from "@/components/ui/skeleton";
import { useMetricsOverview } from "@/lib/queries/metrics";
import { useState } from "react";

export const dynamic = "force-dynamic";

export default function MetricsPage() {
  const [days, setDays] = useState<7 | 30>(7);
  const { data, isLoading, error, refetch } = useMetricsOverview(days);

  return (
    <div className="container mx-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Métricas</h1>
        <div className="flex gap-1">
          {([7, 30] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`px-3 py-1 text-sm rounded ${days === d ? "bg-slate-900 text-white" : "bg-slate-100"}`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="text-red-600">
          Erro ao carregar métricas.{" "}
          <button type="button" className="underline" onClick={() => refetch()}>
            tentar de novo
          </button>
        </div>
      ) : isLoading || !data ? (
        <Skeleton className="h-96" />
      ) : (
        <div className="space-y-4">
          <MetricKpis data={data} />
          <VisitsFlowChart points={data.visits.points} trend={data.visits.trend} />
          <div className="grid grid-cols-3 gap-4">
            <PeakHoursHeatmap cells={data.peak.cells} />
            <RecurrenceDonut data={data.recurrence} />
            <SentimentBars buckets={data.sentiment.buckets} />
          </div>
        </div>
      )}
    </div>
  );
}
