/** Item retornado por GET /api/matches/reid/pending — junta detection nova
 * com candidate face_record + person, pra UI mostrar side-by-side. */
export interface ReidMatchPendingEnriched {
  id: string; // reid_match_attempt.id
  distance: number;
  decided_at: string; // ISO
  detection: {
    id: string;
    detected_at: string;
    snapshot_path: string | null;
    camera_id: string;
  };
  candidate: {
    face_record_id: string;
    person_id: string;
    snapshot_path: string;
    person_display_name: string | null;
    person_type: "client" | "employee" | "anonymous";
  };
}

/** Decision de POST /api/matches/reid/:id/resolve */
export type ReidResolveDecision = "matched_to_candidate" | "rejected_new_person";
