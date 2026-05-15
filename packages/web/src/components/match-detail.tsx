"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { snapshotUrl } from "@/lib/api-client";
import { useRejectMatch, useResolveMatch } from "@/lib/queries/matches";
import type { DetectionThumbnail, MatchPendingEnriched } from "@vipcam/shared";
import { toast } from "sonner";

export function MatchDetail({ match }: { match: MatchPendingEnriched }) {
  const resolve = useResolveMatch();
  const reject = useRejectMatch();

  const handleResolve = (det: DetectionThumbnail) => {
    // person_id vem JÁ resolvido pelo backend (Chunk 3.1 Task 3.1.8 faz JOIN
    // persons WHERE erp_client_id = checkin.erp_client_id). Se null, cliente
    // não tem Person registrada — bloquear com toast.
    if (!match.checkin.person_id) {
      toast.error("Cliente sem Person registrada — sync ERP precisa rodar primeiro.");
      return;
    }
    resolve.mutate({
      id: match.match_attempt_id,
      chosen_detection_id: det.id,
      chosen_person_id: match.checkin.person_id,
    });
  };

  return (
    <div className="p-4 space-y-3">
      <div className="border-b pb-2">
        <div className="font-semibold text-lg">
          {match.checkin.client_name ?? "Cliente sem nome"}
        </div>
        <div className="text-sm text-slate-600">
          📞 {match.checkin.client_phone ?? "—"} · checkin {match.checkin.event_type}{" "}
          {new Date(match.checkin.occurred_at).toLocaleTimeString("pt-BR")}
        </div>
        {match.notes && (
          <Badge variant="outline" className="mt-1 text-xs">
            {match.notes}
          </Badge>
        )}
      </div>

      {match.candidates.length === 0 ? (
        <div className="text-slate-500 italic py-4">
          Nenhuma candidata visível na janela. Apenas rejeite.
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {match.candidates.map((det) => {
            const url = snapshotUrl(det.snapshot_path);
            return (
              <div key={det.id} className="border rounded-md p-2 text-center">
                <div className="h-24 bg-slate-200 rounded mb-2 overflow-hidden flex items-center justify-center text-slate-400 text-xs">
                  {url ? (
                    <img
                      src={url}
                      alt=""
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                  ) : (
                    "sem foto"
                  )}
                </div>
                <div className="text-xs text-slate-600 mb-1">
                  {new Date(det.detected_at).toLocaleTimeString("pt-BR")}
                </div>
                <div className="text-[10px] text-slate-500 mb-2">
                  {(det.face_attrs.gender as string) ?? "?"} ·{" "}
                  {(det.face_attrs.age as number) ?? "?"} · {det.dominant_emotion ?? "—"}
                </div>
                <Button
                  size="sm"
                  className="w-full text-xs"
                  disabled={resolve.isPending}
                  onClick={() => handleResolve(det)}
                >
                  É essa pessoa
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2 border-t">
        <Button
          variant="outline"
          size="sm"
          disabled={reject.isPending}
          onClick={() =>
            reject.mutate({ id: match.match_attempt_id, reason: "operator rejection" })
          }
        >
          Rejeitar
        </Button>
      </div>
    </div>
  );
}
