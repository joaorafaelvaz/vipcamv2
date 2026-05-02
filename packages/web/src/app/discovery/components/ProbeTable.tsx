import type { ProbeResult } from "@vipcam/shared";

const STATUS_COLOR: Record<ProbeResult["status"], string> = {
  ok: "text-green-700 bg-green-50",
  not_found: "text-red-700 bg-red-50",
  auth_failed: "text-yellow-800 bg-yellow-50",
  timeout: "text-orange-700 bg-orange-50",
  error: "text-red-800 bg-red-100",
  skipped: "text-neutral-500 bg-neutral-100",
};

export function ProbeTable({ probes }: { probes: ProbeResult[] }) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-neutral-100">
        <tr>
          <th className="p-2 text-left">Status</th>
          <th className="p-2 text-left">Probe</th>
          <th className="p-2 text-left">Endpoint</th>
          <th className="p-2 text-right">HTTP</th>
          <th className="p-2 text-right">ms</th>
        </tr>
      </thead>
      <tbody>
        {probes.map((p) => (
          <tr key={`${p.name}-${p.endpoint}`} className="border-b border-neutral-200">
            <td className={`p-2 font-mono ${STATUS_COLOR[p.status]}`}>{p.status}</td>
            <td className="p-2 font-mono">{p.name}</td>
            <td className="p-2 font-mono text-xs text-neutral-600">{p.endpoint}</td>
            <td className="p-2 text-right font-mono">{p.http_status ?? "—"}</td>
            <td className="p-2 text-right font-mono">{p.duration_ms}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
