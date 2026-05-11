import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb } from "../../../src/persistence/db.js";
import { faceRecordsRepo } from "../../../src/persistence/repositories/face-records.repo.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";
import { truncateAll } from "./_helpers.js";

beforeEach(async () => {
  await truncateAll();
});

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
    });
    const primary = await faceRecordsRepo.create({
      person_id: person.id,
      snapshot_path: "/snaps/p1-primary.jpg",
      is_primary: true,
    });

    const found = await faceRecordsRepo.findPrimaryByPersonId(person.id);
    expect(found?.id).toBe(primary.id);
  });
});
