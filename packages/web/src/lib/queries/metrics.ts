import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { MetricsOverview } from "@vipcam/shared";
import { apiFetch } from "../api-client";

export function useMetricsOverview(days: 7 | 30) {
  return useQuery<MetricsOverview>({
    queryKey: ["metrics", "overview", days],
    queryFn: ({ signal }) =>
      apiFetch<MetricsOverview>(`/api/metrics/overview?days=${days}`, { signal }),
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
  });
}
