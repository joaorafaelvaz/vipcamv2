import type { MetricsOverview } from "@vipcam/shared";

export function MetricKpis({ data }: { data: MetricsOverview }) {
  const total = data.recurrence.total_visits;
  const avgPerDay = data.visits.points.length ? Math.round(total / data.visits.points.length) : 0;
  const idv = data.recurrence.identified_visits;
  const pctReturning = idv > 0 ? Math.round((data.recurrence.returning_count / idv) * 100) : 0;
  const topEmotion =
    [...data.sentiment.buckets].sort((a, b) => b.count - a.count)[0]?.emotion ?? "—";
  const Card = ({ label, value }: { label: string; value: string }) => (
    <div className="flex-1 rounded-md border bg-white p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
    </div>
  );
  return (
    <div className="flex gap-3">
      <Card label="Visitas no período" value={String(total)} />
      <Card label="Média/dia" value={String(avgPerDay)} />
      <Card label="Recorrentes" value={`${pctReturning}%`} />
      <Card label="Emoção predominante" value={topEmotion} />
    </div>
  );
}
