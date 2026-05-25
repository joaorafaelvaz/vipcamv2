// NOTA (bun:test mock.module process-wide leakage, herdado da Onda 8):
// re-registra api-client mock no beforeEach. Em isolado passa; no full
// suite pode haver flicker — documentado.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReidMatchPendingEnriched } from "@vipcam/shared";
import * as React from "react";

let returnRows: ReidMatchPendingEnriched[] = [];
let postCalls: Array<{ url: string; body: unknown }> = [];

const installMocks = () =>
  mock.module("../../../src/lib/api-client", () => ({
    apiFetch: async (url: string, opts?: { method?: string; body?: unknown }) => {
      if (opts?.method === "POST") {
        postCalls.push({ url, body: opts.body });
        return undefined;
      }
      return returnRows;
    },
    snapshotUrl: (p: string | null) => (p ? `/snapshots/${p}` : null),
    ApiError: class extends Error {},
  }));
installMocks();

import { useReidPending, useResolveReid } from "../../../src/lib/queries/reid-matches";

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

function PendingProbe() {
  const q = useReidPending(50);
  return <div data-testid="count">{q.data?.length ?? 0}</div>;
}

beforeEach(() => {
  returnRows = [];
  postCalls = [];
  installMocks();
});
afterEach(() => {});

describe("useReidPending", () => {
  test("fetches /api/matches/reid/pending?limit=50", async () => {
    returnRows = [
      {
        id: "rma-1",
        distance: 0.45,
        decided_at: "2026-05-20T14:00:00Z",
        detection: { id: "d1", detected_at: "x", snapshot_path: null, camera_id: "c1" },
        candidate: {
          face_record_id: "fr1",
          person_id: "p1",
          snapshot_path: "x.jpg",
          person_display_name: "João",
          person_type: "client",
        },
      },
    ];
    const qc = makeClient();
    render(
      <QueryClientProvider client={qc}>
        <PendingProbe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("1"));
  });
});

describe("useResolveReid", () => {
  test("POST /api/matches/reid/:id/resolve com decision", async () => {
    const qc = makeClient();
    let resolveFn: ((d: { id: string; decision: string }) => void) | null = null;
    function Probe() {
      const m = useResolveReid();
      React.useEffect(() => {
        resolveFn = (d) =>
          m.mutate(d as { id: string; decision: "matched_to_candidate" | "rejected_new_person" });
      }, [m]);
      return null;
    }
    render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(resolveFn).not.toBeNull());
    resolveFn!({ id: "rma-1", decision: "matched_to_candidate" });
    await waitFor(() => expect(postCalls.length).toBe(1));
    expect(postCalls[0].url).toBe("/api/matches/reid/rma-1/resolve");
    expect(postCalls[0].body).toEqual({ decision: "matched_to_candidate" });
  });
});
