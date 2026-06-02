import { describe, expect, test } from "bun:test";
import { type WindowDetection, decideCheckinMatch } from "../../../src/match-temp/candidates.js";

const Y = "client-Y";
function det(over: Partial<WindowDetection>): WindowDetection {
  return { id: "d", person_id: null, person_type: null, session_id: null, ...over };
}

describe("decideCheckinMatch", () => {
  test("convergente: existe detection já ligada a Y", () => {
    const r = decideCheckinMatch({
      candidatePersonId: Y,
      detections: [det({ id: "d1", person_id: Y, person_type: "client" })],
      staffPersonIds: new Set(),
    });
    expect(r.kind).toBe("convergent");
  });

  test("rejected: sem candidatos plausíveis (só funcionário)", () => {
    const r = decideCheckinMatch({
      candidatePersonId: Y,
      detections: [det({ id: "e", person_id: "emp", person_type: "employee" })],
      staffPersonIds: new Set(),
    });
    expect(r.kind).toBe("rejected");
  });

  test("auto_merge_anon: exatamente 1 anônimo distinto (várias detecções) e 0 nulls", () => {
    const r = decideCheckinMatch({
      candidatePersonId: Y,
      detections: [
        det({ id: "d1", person_id: "A", person_type: "anonymous" }),
        det({ id: "d2", person_id: "A", person_type: "anonymous" }),
      ],
      staffPersonIds: new Set(),
    });
    expect(r).toEqual({
      kind: "auto_merge_anon",
      anonPersonId: "A",
      representativeDetectionId: "d1",
    });
  });

  test("auto_link_null: exatamente 1 detection NULL e 0 anônimos", () => {
    const r = decideCheckinMatch({
      candidatePersonId: Y,
      detections: [det({ id: "n1", person_id: null, person_type: null, session_id: "s1" })],
      staffPersonIds: new Set(),
    });
    expect(r).toEqual({ kind: "auto_link_null", detectionId: "n1", sessionId: "s1" });
  });

  test("exclui staff: anônimo staff-like é removido; se era o único → rejected", () => {
    const r = decideCheckinMatch({
      candidatePersonId: Y,
      detections: [det({ id: "d1", person_id: "STAFF", person_type: "anonymous" })],
      staffPersonIds: new Set(["STAFF"]),
    });
    expect(r.kind).toBe("rejected");
  });

  test("exclui outro cliente (person_type client != Y)", () => {
    const r = decideCheckinMatch({
      candidatePersonId: Y,
      detections: [det({ id: "d1", person_id: "OUTRO", person_type: "client" })],
      staffPersonIds: new Set(),
    });
    expect(r.kind).toBe("rejected");
  });

  test("ambiguous colapsado: ≥2 anônimos distintos → 1 candidato por pessoa (não por detecção)", () => {
    const r = decideCheckinMatch({
      candidatePersonId: Y,
      detections: [
        det({ id: "a1", person_id: "A", person_type: "anonymous" }),
        det({ id: "a2", person_id: "A", person_type: "anonymous" }),
        det({ id: "b1", person_id: "B", person_type: "anonymous" }),
      ],
      staffPersonIds: new Set(),
    });
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.anonCandidates).toEqual([
        { personId: "A", detectionId: "a1" },
        { personId: "B", detectionId: "b1" },
      ]);
      expect(r.nullDetectionCount).toBe(0);
    }
  });

  test("ambiguous misto: 1 anônimo + 2 nulls → anon candidate + nullDetectionCount", () => {
    const r = decideCheckinMatch({
      candidatePersonId: Y,
      detections: [
        det({ id: "a1", person_id: "A", person_type: "anonymous" }),
        det({ id: "n1", person_id: null }),
        det({ id: "n2", person_id: null }),
      ],
      staffPersonIds: new Set(),
    });
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.anonCandidates).toEqual([{ personId: "A", detectionId: "a1" }]);
      expect(r.nullDetectionCount).toBe(2);
    }
  });

  test("convergente tem prioridade mesmo com anônimos por perto", () => {
    const r = decideCheckinMatch({
      candidatePersonId: Y,
      detections: [
        det({ id: "y1", person_id: Y, person_type: "client" }),
        det({ id: "a1", person_id: "A", person_type: "anonymous" }),
      ],
      staffPersonIds: new Set(),
    });
    expect(r.kind).toBe("convergent");
  });
});
