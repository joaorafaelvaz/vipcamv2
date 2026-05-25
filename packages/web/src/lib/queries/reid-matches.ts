import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReidMatchPendingEnriched, ReidResolveDecision } from "@vipcam/shared";
import { apiFetch } from "../api-client";

export function useReidPending(limit = 50) {
  return useQuery<ReidMatchPendingEnriched[]>({
    queryKey: ["reid-matches", "pending", limit],
    queryFn: () => apiFetch<ReidMatchPendingEnriched[]>(`/api/matches/reid/pending?limit=${limit}`),
  });
}

export function useResolveReid() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: ReidResolveDecision }) =>
      apiFetch<void>(`/api/matches/reid/${id}/resolve`, {
        method: "POST",
        body: { decision },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reid-matches", "pending"] });
    },
  });
}
