"use client";

import { IdentifyEmployeeDialog } from "@/components/identify-employee-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { snapshotUrl } from "@/lib/api-client";
import { formatDistanceToNow } from "@/lib/dates";
import { useDismissIdentify, useIdentifyQueue } from "@/lib/queries/identify";
import type { Route } from "next";
import Link from "next/link";

/**
 * Onda 10 — fila de curadoria: anônimos mais vistos pela câmera (prováveis
 * funcionários, já que staff fica o dia todo). Operador identifica ou ignora.
 */
export function IdentifyQueue() {
  const { data, isLoading } = useIdentifyQueue();
  const dismiss = useDismissIdentify();

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholder
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    );
  }

  const items = data ?? [];
  if (items.length === 0) {
    return (
      <div className="text-slate-500 italic py-8 text-center">
        Nenhum anônimo frequente aguardando identificação. 🎉
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <Card key={item.person_id} className="p-4 flex items-center gap-4">
          <div className="flex gap-2">
            {item.snapshots.length === 0 ? (
              <div className="w-20 h-20 rounded bg-slate-100 flex items-center justify-center text-slate-400 text-xs">
                sem foto
              </div>
            ) : (
              item.snapshots.map((s) => {
                const url = snapshotUrl(s);
                return url ? (
                  <img
                    key={s}
                    src={url}
                    alt="detecção"
                    className="w-20 h-20 object-cover rounded border"
                  />
                ) : null;
              })
            )}
          </div>
          <div className="flex-1">
            <div className="font-medium">{item.detection_count} detecções</div>
            <div className="text-sm text-slate-500">
              {item.last_seen_at
                ? `visto ${formatDistanceToNow(item.last_seen_at)}`
                : "sem registro recente"}
            </div>
            <Link
              href={`/people/${item.person_id}` as Route}
              className="text-sm text-blue-600 hover:underline"
            >
              ver perfil
            </Link>
          </div>
          <div className="flex flex-col gap-2 items-end">
            <IdentifyEmployeeDialog anonId={item.person_id} />
            <Button
              variant="ghost"
              size="sm"
              disabled={dismiss.isPending}
              onClick={() => dismiss.mutate(item.person_id)}
            >
              Ignorar
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
