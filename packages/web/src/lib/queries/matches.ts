import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MatchPendingEnriched } from "@vipcam/shared";
import { toast } from "sonner";
import { ApiError, apiFetch } from "../api-client";

export function useMatchesPending() {
  return useQuery<MatchPendingEnriched[]>({
    queryKey: ["matches", "pending"],
    queryFn: async ({ signal }) => {
      const r = await apiFetch<{ items: MatchPendingEnriched[] }>("/api/matches/pending", {
        signal,
      });
      return r.items;
    },
    refetchInterval: 30 * 1000,
  });
}

export function useResolveMatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      id: string;
      chosen_detection_id: string;
      chosen_person_id: string;
    }) => {
      await apiFetch<{ ok: true }>(`/api/matches/${params.id}/resolve`, {
        method: "POST",
        body: {
          chosen_detection_id: params.chosen_detection_id,
          chosen_person_id: params.chosen_person_id,
        },
      });
    },
    onSuccess: () => {
      toast.success("Match resolvido");
      void qc.invalidateQueries({ queryKey: ["matches"] });
      void qc.invalidateQueries({ queryKey: ["dashboard", "summary"] });
    },
    onError: (e) => {
      const msg = e instanceof ApiError ? `${e.status} ${e.code}` : String(e);
      toast.error(`Erro ao resolver: ${msg}`);
    },
  });
}

export function useRejectMatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string; reason?: string }) => {
      await apiFetch<{ ok: true }>(`/api/matches/${params.id}/reject`, {
        method: "POST",
        body: params.reason ? { reason: params.reason } : {},
      });
    },
    onSuccess: () => {
      toast.success("Match rejeitado");
      void qc.invalidateQueries({ queryKey: ["matches"] });
      void qc.invalidateQueries({ queryKey: ["dashboard", "summary"] });
    },
    onError: (e) => {
      const msg = e instanceof ApiError ? `${e.status} ${e.code}` : String(e);
      toast.error(`Erro ao rejeitar: ${msg}`);
    },
  });
}
