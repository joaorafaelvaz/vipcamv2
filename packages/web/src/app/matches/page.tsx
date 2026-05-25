"use client";

import { ReidMatchCard } from "@/components/reid-match-card";
import { MatchDetail } from "@/components/match-detail";
import { MatchListItem } from "@/components/match-list-item";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMatchesPending } from "@/lib/queries/matches";
import { useReidPending, useResolveReid } from "@/lib/queries/reid-matches";
import { useState } from "react";

export const dynamic = "force-dynamic";

export default function MatchesPage() {
  // Temporal (existente, Onda 3)
  const { data: temporal, isLoading: tLoading } = useMatchesPending();
  const [selectedTemporalId, setSelectedTemporalId] = useState<string | null>(null);
  const temporalList = temporal ?? [];
  const selectedTemporal =
    temporalList.find((m) => m.match_attempt_id === selectedTemporalId) ?? temporalList[0];

  // Reid borderline (Onda 7)
  const { data: reid, isLoading: rLoading } = useReidPending(50);
  const resolveReid = useResolveReid();
  const reidList = reid ?? [];

  return (
    <div className="container mx-auto p-6">
      <h1 className="text-2xl font-semibold mb-4">Matches pendentes</h1>

      <Tabs defaultValue="temporal" className="w-full">
        <TabsList>
          <TabsTrigger value="temporal">
            Temporal ({tLoading ? "…" : temporalList.length})
          </TabsTrigger>
          <TabsTrigger value="reid">
            Reid borderline ({rLoading ? "…" : reidList.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="temporal">
          <div className="bg-white border rounded-md flex" style={{ minHeight: 500 }}>
            <aside className="w-72 border-r overflow-y-auto" style={{ maxHeight: 600 }}>
              <div className="p-2 font-semibold border-b text-sm">
                {tLoading
                  ? "carregando…"
                  : `${temporalList.length} pendente${temporalList.length === 1 ? "" : "s"}`}
              </div>
              {tLoading ? (
                <div className="p-2"><Skeleton className="h-12" /></div>
              ) : temporalList.length === 0 ? (
                <div className="p-4 text-slate-500 text-sm text-center">
                  Nenhum match pendente — tudo resolvido!
                </div>
              ) : (
                temporalList.map((m) => (
                  <MatchListItem
                    key={m.match_attempt_id}
                    match={m}
                    active={selectedTemporal?.match_attempt_id === m.match_attempt_id}
                    onClick={() => setSelectedTemporalId(m.match_attempt_id)}
                  />
                ))
              )}
            </aside>
            <section className="flex-1">
              {selectedTemporal ? (
                <MatchDetail match={selectedTemporal} />
              ) : (
                <div className="p-8 text-slate-500 italic text-center">
                  Selecione um match na lista
                </div>
              )}
            </section>
          </div>
        </TabsContent>

        <TabsContent value="reid">
          <div className="bg-white border rounded-md" style={{ minHeight: 500 }}>
            {rLoading ? (
              <div className="p-4"><Skeleton className="h-32" /></div>
            ) : reidList.length === 0 ? (
              <div className="p-8 text-slate-500 text-sm text-center italic">
                Nenhum borderline pendente — calibração funcionando!
              </div>
            ) : (
              <div className="divide-y">
                {reidList.map((item) => (
                  <ReidMatchCard
                    key={item.id}
                    item={item}
                    onResolve={(params) => resolveReid.mutate(params)}
                    loading={resolveReid.isPending}
                  />
                ))}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
