"use client";

import { MatchDetail } from "@/components/match-detail";
import { MatchListItem } from "@/components/match-list-item";
import { Skeleton } from "@/components/ui/skeleton";
import { useMatchesPending } from "@/lib/queries/matches";
import { useState } from "react";

export default function MatchesPage() {
  const { data: matches, isLoading } = useMatchesPending();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = matches ?? [];
  const selected = list.find((m) => m.match_attempt_id === selectedId) ?? list[0];

  return (
    <div className="container mx-auto p-6">
      <h1 className="text-2xl font-semibold mb-4">Matches pendentes</h1>

      <div className="bg-white border rounded-md flex" style={{ minHeight: 500 }}>
        <aside className="w-72 border-r overflow-y-auto" style={{ maxHeight: 600 }}>
          <div className="p-2 font-semibold border-b text-sm">
            {isLoading ? "carregando…" : `${list.length} pendente${list.length === 1 ? "" : "s"}`}
          </div>
          {isLoading ? (
            <div className="p-2">
              <Skeleton className="h-12" />
            </div>
          ) : list.length === 0 ? (
            <div className="p-4 text-slate-500 text-sm text-center">
              Nenhum match pendente — tudo resolvido!
            </div>
          ) : (
            list.map((m) => (
              <MatchListItem
                key={m.match_attempt_id}
                match={m}
                active={selected?.match_attempt_id === m.match_attempt_id}
                onClick={() => setSelectedId(m.match_attempt_id)}
              />
            ))
          )}
        </aside>

        <section className="flex-1">
          {selected ? (
            <MatchDetail match={selected} />
          ) : (
            <div className="p-8 text-slate-500 italic text-center">Selecione um match na lista</div>
          )}
        </section>
      </div>
    </div>
  );
}
