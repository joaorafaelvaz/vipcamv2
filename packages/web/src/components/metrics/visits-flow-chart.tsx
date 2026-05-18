import type { VisitsFlowPoint } from "@vipcam/shared";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export function VisitsFlowChart({
  points,
  trend,
}: {
  points: VisitsFlowPoint[];
  trend: { slope: number; direction: "up" | "down" | "flat" };
}) {
  if (points.length === 0) {
    return <div className="text-slate-500 italic p-8 text-center">Sem dados no período</div>;
  }
  const arrow = trend.direction === "up" ? "▲" : trend.direction === "down" ? "▼" : "—";
  return (
    <div className="rounded-md border bg-white p-3">
      <div className="flex justify-between mb-2">
        <h3 className="font-semibold text-slate-700">Fluxo de visitas</h3>
        <span className="text-sm text-slate-500">tendência {arrow}</span>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={points}>
          <XAxis dataKey="date" fontSize={11} />
          <YAxis allowDecimals={false} fontSize={11} />
          <Tooltip />
          <Area type="monotone" dataKey="count" stroke="#0f172a" fill="#cbd5e1" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
