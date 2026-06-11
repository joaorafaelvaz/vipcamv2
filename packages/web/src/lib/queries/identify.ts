import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IdentifyQueueItem } from "@vipcam/shared";
import { toast } from "sonner";
import { ApiError, apiFetch } from "../api-client";

export function useIdentifyQueue(limit = 20) {
  return useQuery<IdentifyQueueItem[]>({
    queryKey: ["identify", "queue", limit],
    queryFn: async ({ signal }) => {
      const r = await apiFetch<{ items: IdentifyQueueItem[] }>(
        `/api/persons/identify/queue?limit=${limit}`,
        { signal },
      );
      return r.items;
    },
  });
}

export function useIdentifyAsEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (p: { anonId: string; employeePersonId: string }) => {
      await apiFetch<{ ok: true }>(`/api/persons/${p.anonId}/identify`, {
        method: "POST",
        body: { employee_person_id: p.employeePersonId },
      });
    },
    onSuccess: () => {
      toast.success("Funcionário identificado — a câmera passa a reconhecê-lo");
      // O merge muda persons (anon some, employee ganha histórico) e tira o
      // funcionário das janelas do /matches — invalida as três áreas.
      void qc.invalidateQueries({ queryKey: ["identify"] });
      void qc.invalidateQueries({ queryKey: ["persons"] });
      void qc.invalidateQueries({ queryKey: ["matches"] });
    },
    onError: (e) => {
      const msg = e instanceof ApiError ? `${e.status} ${e.code}` : String(e);
      toast.error(`Erro ao identificar: ${msg}`);
    },
  });
}

export function useDismissIdentify() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (anonId: string) => {
      await apiFetch<{ ok: true }>(`/api/persons/${anonId}/identify/dismiss`, {
        method: "POST",
        body: {},
      });
    },
    onSuccess: () => {
      toast.success("Removido da fila");
      void qc.invalidateQueries({ queryKey: ["identify"] });
    },
    onError: (e) => {
      const msg = e instanceof ApiError ? `${e.status} ${e.code}` : String(e);
      toast.error(`Erro: ${msg}`);
    },
  });
}
