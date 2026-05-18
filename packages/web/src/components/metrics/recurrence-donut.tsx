import type { RecurrenceBreakdown } from "@vipcam/shared";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

export function RecurrenceDonut({ data }: { data: RecurrenceBreakdown }) {
  if (data.identified_visits === 0) {
    return (
      <div className="rounded-md border bg-white p-3">
        <h3 className="font-semibold text-slate-700 mb-2">Recorrência</h3>
        <div className="text-slate-500 italic p-6 text-center">
          Sem clientes identificados no período
        </div>
      </div>
    );
  }
  const pie = [
    { name: "Novos", value: data.new_count },
    { name: "Recorrentes", value: data.returning_count },
  ];
  const colors = ["#94a3b8", "#0f172a"];
  const pct = Math.round((data.identified_visits / Math.max(data.total_visits, 1)) * 100);
  return (
    <div className="rounded-md border bg-white p-3">
      <h3 className="font-semibold text-slate-700 mb-1">Recorrência</h3>
      <ResponsiveContainer width="100%" height={160}>
        <PieChart>
          <Pie data={pie} dataKey="value" innerRadius={40} outerRadius={60}>
            {pie.map((slice, i) => (
              <Cell key={slice.name} fill={colors[i]} />
            ))}
          </Pie>
          <Tooltip />
        </PieChart>
      </ResponsiveContainer>
      <div className="text-xs text-slate-500 text-center">
        base: {data.identified_visits} de {data.total_visits} visitas identificadas ({pct}%)
      </div>
    </div>
  );
}
