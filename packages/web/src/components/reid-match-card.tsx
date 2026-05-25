"use client";
import { Button } from "@/components/ui/button";
import { snapshotUrl } from "@/lib/api-client";
import type { ReidMatchPendingEnriched, ReidResolveDecision } from "@vipcam/shared";

export interface ReidMatchCardProps {
  item: ReidMatchPendingEnriched;
  onResolve: (params: { id: string; decision: ReidResolveDecision }) => void;
  loading: boolean;
}

export function ReidMatchCard({ item, onResolve, loading }: ReidMatchCardProps) {
  const detSrc = snapshotUrl(item.detection.snapshot_path);
  const candSrc = snapshotUrl(item.candidate.snapshot_path);

  return (
    <div className="p-6">
      <div className="grid grid-cols-2 gap-6 mb-4">
        <figure>
          <figcaption className="text-sm font-semibold mb-2">Detecção nova</figcaption>
          {detSrc ? (
            <img src={detSrc} alt="detection" className="w-full rounded border" />
          ) : (
            <div className="aspect-square bg-slate-100 rounded flex items-center justify-center text-slate-400">
              sem snapshot
            </div>
          )}
        </figure>
        <figure>
          <figcaption className="text-sm font-semibold mb-2">
            Candidato:{" "}
            <span className="font-bold">{item.candidate.person_display_name ?? "anônima"}</span>
            <span className="text-xs text-slate-500 ml-2">({item.candidate.person_type})</span>
          </figcaption>
          {candSrc ? (
            <img src={candSrc} alt="candidate" className="w-full rounded border" />
          ) : (
            <div className="aspect-square bg-slate-100 rounded flex items-center justify-center text-slate-400">
              sem snapshot
            </div>
          )}
        </figure>
      </div>

      <div className="text-sm text-slate-600 mb-4">
        Distância cosine: <span className="font-mono">{item.distance.toFixed(3)}</span>
        {" — "}
        revisado pra:{" "}
        <span className="font-mono">{new Date(item.decided_at).toLocaleString()}</span>
      </div>

      <div className="flex gap-2">
        <Button
          onClick={() => onResolve({ id: item.id, decision: "matched_to_candidate" })}
          disabled={loading}
          variant="default"
        >
          Mesma pessoa
        </Button>
        <Button
          onClick={() => onResolve({ id: item.id, decision: "rejected_new_person" })}
          disabled={loading}
          variant="outline"
        >
          Pessoas diferentes
        </Button>
      </div>
    </div>
  );
}
