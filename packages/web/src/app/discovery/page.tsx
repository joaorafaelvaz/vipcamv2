"use client";

import { getLastDiscoveryReport, runDiscovery } from "@/lib/api-client";
import type { DiscoveryReport } from "@vipcam/shared";
import { useEffect, useState } from "react";
import { ProbeTable } from "./components/ProbeTable";

export default function DiscoveryPage() {
  const [report, setReport] = useState<DiscoveryReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captureSeconds, setCaptureSeconds] = useState(600);

  useEffect(() => {
    getLastDiscoveryReport()
      .then(setReport)
      .catch(() => setReport(null));
  }, []);

  async function handleRun() {
    setLoading(true);
    setError(null);
    try {
      const r = await runDiscovery(captureSeconds);
      setReport(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-semibold">Discovery — DH-IPC-HFW5442T-ASE</h1>
      <p className="mt-2 text-neutral-600">
        Roda probes contra a câmera e captura eventos por N segundos. Resultado fica salvo em{" "}
        <code>discovery-output/</code>.
      </p>

      <div className="mt-6 flex items-center gap-3">
        <label className="text-sm">
          Captura (segundos):{" "}
          <input
            type="number"
            value={captureSeconds}
            onChange={(e) => setCaptureSeconds(Number(e.target.value))}
            min={10}
            max={3600}
            className="w-24 rounded border border-neutral-300 p-1"
          />
        </label>
        <button
          type="button"
          onClick={handleRun}
          disabled={loading}
          className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading ? "Rodando..." : "Rodar Discovery"}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          ❌ {error}
        </div>
      )}

      {report && (
        <section className="mt-8 space-y-6">
          <div className="rounded border border-neutral-200 bg-white p-4">
            <h2 className="text-lg font-semibold">Resumo</h2>
            <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
              <dt className="text-neutral-600">IP:</dt>
              <dd>{report.camera_ip}</dd>
              <dt className="text-neutral-600">Modelo:</dt>
              <dd>{report.camera_model ?? "—"}</dd>
              <dt className="text-neutral-600">Serial:</dt>
              <dd>{report.camera_serial ?? "—"}</dd>
              <dt className="text-neutral-600">Firmware:</dt>
              <dd>{report.firmware ?? "—"}</dd>
              <dt className="text-neutral-600">Eventos capturados:</dt>
              <dd>
                {report.events_captured} (em {report.capture_duration_seconds}s)
              </dd>
              <dt className="text-neutral-600">Idade?</dt>
              <dd>{report.has_age_attribute ? "✅" : "❌"}</dd>
              <dt className="text-neutral-600">Gênero?</dt>
              <dd>{report.has_gender_attribute ? "✅" : "❌"}</dd>
              <dt className="text-neutral-600">Emoção?</dt>
              <dd>{report.has_emotion_attribute ? "✅" : "❌"}</dd>
              <dt className="text-neutral-600">Canal recomendado:</dt>
              <dd className="font-mono">{report.recommended_ingest_channel}</dd>
            </dl>
          </div>

          <div className="rounded border border-neutral-200 bg-white p-4">
            <h2 className="text-lg font-semibold">Probes</h2>
            <div className="mt-2">
              <ProbeTable probes={report.probes} />
            </div>
          </div>

          {report.fork_decision_required.length > 0 && (
            <div className="rounded border border-yellow-300 bg-yellow-50 p-4">
              <h2 className="text-lg font-semibold">⚠ Decisões pendentes</h2>
              <ul className="mt-2 list-disc pl-6 text-sm">
                {report.fork_decision_required.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
