import { eq, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import { type NewPerson, type Person, persons } from "../schema/persons.js";

export const personsRepo = {
  async create(data: Omit<NewPerson, "id">): Promise<Person> {
    const [p] = await getDb().insert(persons).values(data).returning();
    if (!p) throw new Error("insert returned no row");
    return p;
  },

  async findById(id: string): Promise<Person | null> {
    const rows = await getDb().select().from(persons).where(eq(persons.id, id)).limit(1);
    return rows[0] ?? null;
  },

  async findByErpClientId(erpId: string): Promise<Person | null> {
    const rows = await getDb()
      .select()
      .from(persons)
      .where(eq(persons.erp_client_id, erpId))
      .limit(1);
    return rows[0] ?? null;
  },

  async findByErpEmployeeId(erpId: string): Promise<Person | null> {
    const rows = await getDb()
      .select()
      .from(persons)
      .where(eq(persons.erp_employee_id, erpId))
      .limit(1);
    return rows[0] ?? null;
  },

  async update(id: string, patch: Partial<NewPerson>): Promise<Person | null> {
    const [p] = await getDb()
      .update(persons)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(persons.id, id))
      .returning();
    return p ?? null;
  },

  async incrementVisitCount(id: string, lastSeenAt: Date): Promise<void> {
    await getDb()
      .update(persons)
      .set({
        last_seen_at: lastSeenAt,
        total_visits: sql`${persons.total_visits} + 1`,
        updated_at: sql`now()`,
      })
      .where(eq(persons.id, id));
  },
};
