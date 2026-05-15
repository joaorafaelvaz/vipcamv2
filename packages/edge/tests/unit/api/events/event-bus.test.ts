import { afterEach, describe, expect, test } from "bun:test";
import type { LiveDetectionEvent } from "@vipcam/shared";
import { _resetEventBus, eventBus } from "../../../../src/api/events/event-bus.js";

afterEach(() => _resetEventBus());

const sampleEvent: LiveDetectionEvent = {
  type: "detection",
  detection: {
    id: "11111111-1111-1111-1111-111111111111",
    detected_at: "2026-05-14T13:00:00Z",
    snapshot_path: null,
    face_attrs: {},
    dominant_emotion: null,
    emotion_confidence: null,
    session_id: null,
    camera_id: "22222222-2222-2222-2222-222222222222",
  },
  person: null,
};

describe("eventBus", () => {
  test("subscribers recebem events publicados", () => {
    const received: LiveDetectionEvent[] = [];
    eventBus.subscribe((e) => received.push(e));
    eventBus.publish(sampleEvent);
    expect(received).toHaveLength(1);
    expect(received[0]?.detection.id).toBe(sampleEvent.detection.id);
  });

  test("multiple subscribers todos recebem", () => {
    const a: LiveDetectionEvent[] = [];
    const b: LiveDetectionEvent[] = [];
    eventBus.subscribe((e) => a.push(e));
    eventBus.subscribe((e) => b.push(e));
    eventBus.publish(sampleEvent);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  test("unsubscribe remove o handler", () => {
    const received: LiveDetectionEvent[] = [];
    const unsub = eventBus.subscribe((e) => received.push(e));
    eventBus.publish(sampleEvent);
    unsub();
    eventBus.publish(sampleEvent);
    expect(received).toHaveLength(1);
  });

  test("publish sem subscribers não throwa (tolera zero listeners)", () => {
    expect(() => eventBus.publish(sampleEvent)).not.toThrow();
  });

  test("subscriberCount reflete listeners ativos", () => {
    expect(eventBus.subscriberCount()).toBe(0);
    const unsub = eventBus.subscribe(() => {});
    expect(eventBus.subscriberCount()).toBe(1);
    unsub();
    expect(eventBus.subscriberCount()).toBe(0);
  });
});
