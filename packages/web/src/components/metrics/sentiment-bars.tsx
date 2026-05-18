import type { SentimentBucket } from "@vipcam/shared";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export function SentimentBars({ buckets }: { buckets: SentimentBucket[] }) {
  if (buckets.length === 0) {
    return <div className="text-slate-500 italic p-8 text-center">Sem dados no período</div>;
  }
  return (
    <div className="rounded-md border bg-white p-3">
      <h3 className="font-semibold text-slate-700 mb-2">Sentimento</h3>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={buckets} layout="vertical">
          <XAxis type="number" allowDecimals={false} fontSize={11} />
          <YAxis type="category" dataKey="emotion" fontSize={11} width={60} />
          <Tooltip />
          <Bar dataKey="count" fill="#0f172a" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
