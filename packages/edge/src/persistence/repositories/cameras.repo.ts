import { asc, eq } from "drizzle-orm";
import { getDb } from "../db.js";
import { type Camera, cameras, type NewCamera } from "../schema/cameras.js";

export const camerasRepo = {
  async create(data: Omit<NewCamera, "id">): Promise<Camera> {
    const [c] = await getDb().insert(cameras).values(data).returning();
    if (!c) throw new Error("insert returned no row");
    return c;
  },

  async findById(id: string): Promise<Camera | null> {
    const rows = await getDb().select().from(cameras).where(eq(cameras.id, id)).limit(1);
    return rows[0] ?? null;
  },

  async findByName(name: string): Promise<Camera | null> {
    const rows = await getDb().select().from(cameras).where(eq(cameras.name, name)).limit(1);
    return rows[0] ?? null;
  },

  async listActive(): Promise<Camera[]> {
    return getDb()
      .select()
      .from(cameras)
      .where(eq(cameras.is_active, true))
      .orderBy(asc(cameras.created_at));
  },

  /**
   * Retorna a primeira câmera ativa (por created_at ascending).
   * Usado pelo ingest single-camera setup; em multi-camera usa findByName/findById.
   */
  async getDefault(): Promise<Camera | null> {
    const rows = await getDb()
      .select()
      .from(cameras)
      .where(eq(cameras.is_active, true))
      .orderBy(asc(cameras.created_at))
      .limit(1);
    return rows[0] ?? null;
  },
};
