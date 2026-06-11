import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getDb } from "../../../src/persistence/db.js";
import { detectionsRepo } from "../../../src/persistence/repositories/detections.repo.js";
import { personsRepo } from "../../../src/persistence/repositories/persons.repo.js";

let cameraId: string;
const pids: string[] = [];

beforeEach(async () => {
  const [cam] = await getDb().execute<{ id: string }>(sql`
    INSERT INTO cameras (id, name) VALUES (gen_random_uuid(), 'cam-iq') RETURNING id`);
  if (!cam) throw new Error("camera insert returned no row");
  cameraId = cam.id;
  pids.length = 0;
});

afterEach(async () => {
  await getDb().execute(sql`DELETE FROM detections WHERE camera_id = ${cameraId}`);
  for (const id of pids) {
    await getDb().execute(sql`DELETE FROM persons WHERE id = ${id}`);
  }
  await getDb().execute(sql`DELETE FROM cameras WHERE id = ${cameraId}`);
});

async function anon(nDets: number): Promise<string> {
  const p = await personsRepo.create({ person_type: "anonymous" });
  pids.push(p.id);
  for (let i = 0; i < nDets; i++) {
    await detectionsRepo.create({
      camera_id: cameraId,
      person_id: p.id,
      session_id: null,
      face_attrs: {},
      detected_at: new Date(Date.now() - i * 60_000),
      snapshot_path: `2026-06-03/${p.id}-${i}.jpg`,
      raw_event: {},
    });
  }
  return p.id;
}

describe("personsRepo.listIdentifyQueue", () => {
  test("ordena por detection_count desc; ≤3 snapshots recentes; exclui 0 detecções", async () => {
    const heavy = await anon(5);
    const light = await anon(2);
    await anon(0); // sem detecções — fora da fila (INNER JOIN)

    const q = await personsRepo.listIdentifyQueue(10);
    const ids = q.map((i) => i.person_id);
    expect(ids).toContain(heavy);
    expect(ids).toContain(light);
    expect(ids.indexOf(heavy)).toBeLessThan(ids.indexOf(light));

    const h = q.find((i) => i.person_id === heavy);
    expect(h?.detection_count).toBe(5);
    expect(h?.snapshots.length).toBe(3); // cap 3 fotos
    expect(q.some((i) => i.detection_count === 0)).toBe(false);
  });

  test("exclui dismissed; dismissIdentify não clobra metadata existente", async () => {
    const p = await anon(3);
    await personsRepo.update(p, { metadata: { foo: "bar" } });
    await personsRepo.dismissIdentify(p);

    const q = await personsRepo.listIdentifyQueue(10);
    expect(q.some((i) => i.person_id === p)).toBe(false);

    const reloaded = await personsRepo.findById(p);
    const md = reloaded?.metadata as Record<string, unknown>;
    expect(md.identify_dismissed).toBe(true);
    expect(md.foo).toBe("bar"); // || jsonb preserva chaves existentes
  });

  test("não lista clients/employees", async () => {
    const emp = await personsRepo.create({ person_type: "employee", display_name: "F" });
    pids.push(emp.id);
    await detectionsRepo.create({
      camera_id: cameraId,
      person_id: emp.id,
      session_id: null,
      face_attrs: {},
      detected_at: new Date(),
      raw_event: {},
    });
    const q = await personsRepo.listIdentifyQueue(10);
    expect(q.some((i) => i.person_id === emp.id)).toBe(false);
  });
});
