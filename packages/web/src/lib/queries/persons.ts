import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type {
  PaginatedResponse,
  PersonDetail,
  PersonSummary,
  SessionWithDetections,
} from "@vipcam/shared";
import { apiFetch } from "../api-client";

export interface UsePeopleParams {
  type?: "client" | "employee";
  search?: string;
  limit?: number;
  offset?: number;
}

export function usePeople(params: UsePeopleParams) {
  const search = new URLSearchParams();
  if (params.type) search.set("type", params.type);
  if (params.search) search.set("search", params.search);
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.offset !== undefined) search.set("offset", String(params.offset));
  const qs = search.toString();

  return useQuery<PaginatedResponse<PersonSummary>>({
    queryKey: ["persons", "list", params],
    queryFn: ({ signal }) =>
      apiFetch<PaginatedResponse<PersonSummary>>(`/api/persons${qs ? `?${qs}` : ""}`, {
        signal,
      }),
    placeholderData: keepPreviousData,
  });
}

export function usePerson(id: string) {
  return useQuery<PersonDetail>({
    queryKey: ["persons", "detail", id],
    queryFn: ({ signal }) => apiFetch<PersonDetail>(`/api/persons/${id}`, { signal }),
    enabled: !!id,
  });
}

export function usePersonSessions(id: string, limit = 20) {
  return useQuery<SessionWithDetections[]>({
    queryKey: ["persons", "sessions", id, limit],
    queryFn: async ({ signal }) => {
      const r = await apiFetch<{ items: SessionWithDetections[] }>(
        `/api/persons/${id}/sessions?limit=${limit}`,
        { signal },
      );
      return r.items;
    },
    enabled: !!id,
  });
}
