import { useQuery } from "@tanstack/react-query";
import type { DashboardSummary } from "@vipcam/shared";
import { apiFetch } from "../api-client";

export function useDashboardSummary() {
  return useQuery<DashboardSummary>({
    queryKey: ["dashboard", "summary"],
    queryFn: ({ signal }) => apiFetch<DashboardSummary>("/api/dashboard/summary", { signal }),
    refetchInterval: 30 * 1000,
  });
}
