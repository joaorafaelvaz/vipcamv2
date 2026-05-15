import { describe, expect, test } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";

// Mock EventSource global ANTES do import do hook
class MockEventSource {
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    setTimeout(() => this.onopen?.(), 5);
  }
  close() {
    this.closed = true;
  }
}
(globalThis as unknown as { EventSource: typeof MockEventSource }).EventSource = MockEventSource;

describe("useSse", () => {
  test("conecta e atualiza state pra 'open'", async () => {
    const { useSse } = await import("../../../src/hooks/use-sse");
    const { result, unmount } = renderHook(() =>
      useSse({ url: "http://x/api/events/stream", onMessage: () => {} }),
    );
    await waitFor(() => expect(result.current.state).toBe("open"));
    unmount();
  });
});
