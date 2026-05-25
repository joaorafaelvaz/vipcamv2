import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb } from "../../../src/persistence/db.js";
import { faceRecordsRepo } from "../../../src/persistence/repositories/face-records.repo.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";
import { truncateAll } from "./_helpers.js";

beforeEach(async () => {
  await truncateAll();
});

// Onda 7: embedding agora é NOT NULL. Os testes deste arquivo focam em
// camera_face_id/person_id, não em similaridade vetorial — usamos um vetor
// placeholder zerado só pra satisfazer a constraint do schema.
const ZERO_EMBEDDING: number[] = Array(512).fill(0);

afterAll(async () => {
  await closeDb();
});

describe("faceRecordsRepo", () => {
  /**
   * TESTE CRÍTICO: query do reid-mgr A (failover via Face DB câmera).
   * Garante que findByCameraFaceId resolve o face_id da câmera para o
   * FaceRecord correto, que aponta para a Person correta.
   */
  test("create + findByCameraFaceId — fluxo crítico do reid", async () => {
    const person = await personsRepo.create({ display_name: "P" });

    const fr = await faceRecordsRepo.create({
      person_id: person.id,
      camera_face_id: "cam-face-42",
      snapshot_path: "/snaps/p1.jpg",
      is_primary: true,
      embedding: ZERO_EMBEDDING,
    });

    const found = await faceRecordsRepo.findByCameraFaceId("cam-face-42");
    expect(found?.id).toBe(fr.id);
    expect(found?.person_id).toBe(person.id);
    expect(found?.is_primary).toBe(true);
  });

  test("findByCameraFaceId retorna null quando não encontra", async () => {
    const found = await faceRecordsRepo.findByCameraFaceId("does-not-exist");
    expect(found).toBeNull();
  });

  test("findPrimaryByPersonId só retorna is_primary=true", async () => {
    const person = await personsRepo.create({ display_name: "P" });
    await faceRecordsRepo.create({
      person_id: person.id,
      snapshot_path: "/snaps/p1-secondary.jpg",
      is_primary: false,
      embedding: ZERO_EMBEDDING,
    });
    const primary = await faceRecordsRepo.create({
      person_id: person.id,
      snapshot_path: "/snaps/p1-primary.jpg",
      is_primary: true,
      embedding: ZERO_EMBEDDING,
    });

    const found = await faceRecordsRepo.findPrimaryByPersonId(person.id);
    expect(found?.id).toBe(primary.id);
  });
});
