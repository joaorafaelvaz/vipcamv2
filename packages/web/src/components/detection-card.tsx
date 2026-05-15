import { Badge } from "@/components/ui/badge";
import { snapshotUrl } from "@/lib/api-client";
import { formatDistanceToNow } from "@/lib/dates";
import type { LiveDetectionEvent } from "@vipcam/shared";

const EMOJI: Record<string, string> = {
  happy: "😊",
  neutral: "😐",
  sad: "😟",
  angry: "😠",
  surprised: "😮",
};

export function DetectionCard({
  event,
  fresh,
}: {
  event: LiveDetectionEvent;
  fresh?: boolean;
}) {
  const url = snapshotUrl(event.detection.snapshot_path);
  const personLabel = event.person?.display_name ?? "Anônimo";
  const personType = event.person?.person_type;
  return (
    <div
      className={`bg-white border rounded-md p-3 flex gap-3 mb-2 ${
        fresh ? "border-green-500" : ""
      }`}
    >
      <div className="w-16 h-16 rounded bg-slate-200 overflow-hidden flex items-center justify-center text-xs text-slate-400">
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
      <div className="flex-1">
        <div className="flex justify-between">
          <div className="font-semibold text-sm">
            {personLabel}{" "}
            {personType && (
              <Badge
                variant={personType === "client" ? "default" : "secondary"}
                className="text-[10px]"
              >
                {personType}
              </Badge>
            )}
          </div>
          <div className="text-xs text-slate-500">
            {formatDistanceToNow(event.detection.detected_at)}
          </div>
        </div>
        <div className="text-xs text-slate-600 mt-1">
          {(event.detection.face_attrs.gender as string) ?? "?"} ·{" "}
          {(event.detection.face_attrs.age as number) ?? "?"} ·{" "}
          {EMOJI[event.detection.dominant_emotion ?? ""]} {event.detection.dominant_emotion ?? "—"}
        </div>
      </div>
    </div>
  );
}
