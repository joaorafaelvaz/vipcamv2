import type { PeakHourCell } from "@vipcam/shared";

const DOW = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

export function PeakHoursHeatmap({ cells }: { cells: PeakHourCell[] }) {
  if (cells.length === 0) {
    return <div className="text-slate-500 italic p-8 text-center">Sem dados no período</div>;
  }
  const max = Math.max(...cells.map((c) => c.count), 1);
  const at = (w: number, h: number) => cells.find((c) => c.weekday === w && c.hour === h)?.count ?? 0;
  const hours = Array.from({ length: 24 }, (_, h) => h);
  return (
    <div className="rounded-md border bg-white p-3 overflow-x-auto">
      <h3 className="font-semibold text-slate-700 mb-2">Horários de pico</h3>
      <table className="text-[10px] border-collapse">
        <tbody>
          {DOW.map((label, w) => (
            <tr key={label}>
              <td className="pr-1 text-slate-500">{label}</td>
              {hours.map((h) => {
                const v = at(w, h);
                const alpha = v / max;
                return (
                  <td
                    key={h}
                    title={`${label} ${h}h: ${v}`}
                    style={{ background: `rgba(15,23,42,${alpha})`, width: 14, height: 14 }}
                  />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
