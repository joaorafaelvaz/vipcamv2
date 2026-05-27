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

  const prevName =
    match.previous_person?.display_name ??
    (match.previous_person ? `Anônima ${match.previous_person.id.slice(0, 10)}` : null);
  const candidateName = match.checkin.client_name ?? "Cliente sem nome";
  const isDivergent = match.previous_person != null;
  const isStaleSame = match.previous_person?.id === match.checkin.person_id;

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

      {match.previous_person && (
        <div
          role="alert"
          className="bg-yellow-50 border border-yellow-300 rounded-md p-3 flex items-center gap-3"
        >
          <div className="flex-shrink-0">
            {match.previous_person.thumbnail_path ? (
              <img
                src={snapshotUrl(match.previous_person.thumbnail_path) ?? ""}
                alt={`Foto de ${prevName ?? "pessoa anterior"}`}
                className="w-12 h-12 rounded-full object-cover"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            ) : (
              <div className="w-12 h-12 rounded-full bg-slate-200 flex items-center justify-center text-slate-500 text-sm">
                ?
              </div>
            )}
          </div>
          <div className="text-sm">
            <div className="font-semibold">
              <span className="sr-only">Atenção: </span>
              <span aria-hidden="true">⚠</span> Esta detection já está ligada a:
            </div>
            <div>
              <span className="font-bold">{prevName}</span>
              <span className="text-xs text-slate-500 ml-1">
                ({match.previous_person.person_type}) — auto-matched pelo reid
              </span>
            </div>
            {isStaleSame && (
              <div className="text-xs text-amber-700 italic mt-1">
                Já é o mesmo cliente — aguardando dedup automática
              </div>
            )}
          </div>
        </div>
      )}

      {match.candidates.length === 0 ? (
        <div className="text-slate-500 italic py-4">
          Nenhuma candidata visível na janela. Apenas rejeite.
        </div>
      ) : (
        !isStaleSame && (
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
                    title={
                      isDivergent
                        ? `Ação irreversível: face_records de ${prevName} passam pra ${candidateName}, e ${prevName} é deletada`
                        : undefined
                    }
                    onClick={() => handleResolve(det)}
                  >
                    {isDivergent
                      ? `É ${candidateName} — merge ${prevName} → ${candidateName}`
                      : "É essa pessoa"}
                  </Button>
                </div>
              );
            })}
          </div>
        )
      )}

      {!isStaleSame && (
        <div className="flex justify-end gap-2 pt-2 border-t">
          <Button
            variant="outline"
            size="sm"
            disabled={reject.isPending}
            onClick={() =>
              reject.mutate({ id: match.match_attempt_id, reason: "operator rejection" })
            }
          >
            {isDivergent ? `Não é ${candidateName} — manter ${prevName}` : "Rejeitar"}
          </Button>
        </div>
      )}
    </div>
  );
}
