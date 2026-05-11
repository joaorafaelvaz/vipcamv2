import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb } from "../../../src/persistence/db.js";
import { camerasRepo } from "../../../src/persistence/repositories/cameras.repo.js";
import { detectionsRepo } from "../../../src/persistence/repositories/detections.repo.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";
import { truncateAll } from "./_helpers.js";

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
});

describe("detectionsRepo", () => {
  test("findAnonymousInWindow filtra por janela e exclui não-anônimas", async () => {
    const cam = await camerasRepo.create({ name: "C", ip_address: "1.1.1.1" });
    const person = await personsRepo.create({ display_name: "Known" });

    const t0 = new Date("2026-05-11T10:00:00Z");
    const tInside = new Date("2026-05-11T10:00:30Z");
    const tInsideNamed = new Date("2026-05-11T10:00:40Z");
    const tOutside = new Date("2026-05-11T10:05:00Z");

    // Anônima dentro da janela — deve aparecer
    const expected = await detectionsRepo.create({
      camera_id: cam.id,
      detected_at: tInside,
      raw_event: { kind: "test" },
    });
    // Anônima FORA da janela — não deve aparecer
    await detectionsRepo.create({
      camera_id: cam.id,
      detected_at: tOutside,
      raw_event: { kind: "test" },
    });
    // Dentro da janela mas COM person_id — não deve aparecer (não é anônima)
    await detectionsRepo.create({
      camera_id: cam.id,
      person_id: person.id,
      detected_at: tInsideNamed,
      raw_event: { kind: "test" },
    });

    const windowEnd = new Date("2026-05-11T10:01:00Z");
    const result = await detectionsRepo.findAnonymousInWindow(t0, windowEnd);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(expected.id);
    expect(result[0]?.person_id).toBeNull();
  });

  test("linkToPerson atualiza person_id", async () => {
    const cam = await camerasRepo.create({ name: "C2", ip_address: "1.1.1.2" });
    const person = await personsRepo.create({ display_name: "Linked" });
    const det = await detectionsRepo.create({
      camera_id: cam.id,
      detected_at: new Date(),
      raw_event: {},
    });

    await detectionsRepo.linkToPerson(det.id, person.id);
    const refetched = await detectionsRepo.findById(det.id);
    expect(refetched?.person_id).toBe(person.id);
  });
});
