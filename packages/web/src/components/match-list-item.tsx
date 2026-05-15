"use client";

import { formatDistanceToNow } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { MatchPendingEnriched } from "@vipcam/shared";

export function MatchListItem({
  match,
  active,
  onClick,
}: {
  match: MatchPendingEnriched;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full text-left p-2 border-b hover:bg-slate-100 transition",
        active && "bg-blue-50 border-l-4 border-l-slate-900",
      )}
    >
      <div className="font-semibold text-sm">{match.checkin.client_name ?? "?"}</div>
      <div className="text-xs text-slate-600">
        {match.candidates.length} candidata{match.candidates.length === 1 ? "" : "s"} ·{" "}
        {formatDistanceToNow(match.decided_at)}
      </div>
    </button>
  );
}
