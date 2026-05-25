import { sql } from "drizzle-orm";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../persistence/db.js";
import { faceRecords } from "../../persistence/schema/face-records.js";

/** Tipo do resultado de decideMatch (Onda 7 §4.3 decision tree). */
export type MatchDecision = "strict" | "borderline" | "new_person";

/** Pura — classifica distance. Boundaries inclusivas em ambos limiares. */
export function classifyDistance(
  distance: number,
  strictMax: number,
  looseMax: number,
): MatchDecision {
  if (distance <= strictMax) return "strict";
  if (distance <= looseMax) return "borderline";
  return "new_person";
}

export interface DecideMatchInput {
  embedding: number[];
  modelName: string;
  modelRevision: string;
  strictMax: number;
  looseMax: number;
}

export interface DecideMatchResult {
  decision: MatchDecision;
  /** Apenas presente em 'strict' ou 'borderline'. */
  candidate?: {
    face_record_id: string;
    person_id: string;
    distance: number;
  };
}

/**
 * Query ANN top-1 + dual threshold (Onda 7 §4.3).
 *
 * Filtra por (model_name, model_revision) atuais — embeddings de modelos
 * antigos viram órfãos automaticamente (zero matching post-troca).
 *
 * Zero rows resultantes (DB vazio OU todos os face_records são de outro
 * modelo) → decisão `new_person` sem candidate.
 */
export async function decideMatch(input: DecideMatchInput): Promise<DecideMatchResult> {
  const db = getDb();
  const embStr = `[${input.embedding.join(",")}]`;
  const rows = await db
    .select({
      face_record_id: faceRecords.id,
      person_id: faceRecords.person_id,
      distance: sql<number>`embedding <=> ${embStr}::vector`,
    })
    .from(faceRecords)
    .where(
      and(
        eq(faceRecords.model_name, input.modelName),
        eq(faceRecords.model_revision, input.modelRevision),
      ),
    )
    .orderBy(sql`embedding <=> ${embStr}::vector`)
    .limit(1);

  if (rows.length === 0) {
    return { decision: "new_person" };
  }
  const top = rows[0];
  if (!top) return { decision: "new_person" };
  const decision = classifyDistance(top.distance, input.strictMax, input.looseMax);
  if (decision === "new_person") {
    return { decision: "new_person" };
  }
  return {
    decision,
    candidate: {
      face_record_id: top.face_record_id,
      person_id: top.person_id,
      distance: top.distance,
    },
  };
}
