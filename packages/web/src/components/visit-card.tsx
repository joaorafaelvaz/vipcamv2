import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { snapshotUrl } from "@/lib/api-client";
import { formatDistanceToNow } from "@/lib/dates";
import type { SessionWithDetections } from "@vipcam/shared";

const EMOTION_EMOJI: Record<string, string> = {
  happy: "😊",
  neutral: "😐",
  sad: "😟",
  angry: "😠",
  surprised: "😮",
  fear: "😨",
};

function durationLabel(start: string, end: string | null): string {
  if (!end) return "em andamento";
  const min = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60_000);
  return `${min} min`;
}

export function VisitCard({ session }: { session: SessionWithDetections }) {
  const visible = session.detections.slice(0, 5);
  const overflow = session.detections.length - visible.length;

  return (
    <Card className="mb-3">
      <CardContent className="p-4">
        <div className="flex justify-between items-start mb-3 pb-2 border-b">
          <div>
            <div className="font-semibold">
              {new Date(session.started_at).toLocaleString("pt-BR")}
            </div>
            <div className="text-xs text-slate-500">{formatDistanceToNow(session.started_at)}</div>
          </div>
          <div className="text-right text-sm text-slate-600">
            {durationLabel(session.started_at, session.ended_at)} · {session.detection_count}{" "}
            detecções
          </div>
        </div>

        {visible.length > 0 && (
          <div className="flex gap-2 mb-3">
            {visible.map((d) => {
              const url = snapshotUrl(d.snapshot_path);
              return (
                <div
                  key={d.id}
                  className="w-12 h-12 rounded bg-slate-200 overflow-hidden flex items-center justify-center text-xs text-slate-400"
                >
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
                    "—"
                  )}
                </div>
              );
            })}
            {overflow > 0 && (
              <div className="w-12 h-12 rounded bg-slate-700 text-white flex items-center justify-center text-xs">
                +{overflow}
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2 text-xs text-slate-600">
          {session.dominant_emotion && (
            <Badge variant="outline">
              {EMOTION_EMOJI[session.dominant_emotion] ?? ""} {session.dominant_emotion}
            </Badge>
          )}
          {session.linked_erp_checkin_id && (
            <Badge variant="outline">checkin: {session.linked_erp_checkin_id}</Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
