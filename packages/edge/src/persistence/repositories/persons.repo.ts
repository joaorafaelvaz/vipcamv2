import type { PaginatedResponse, PersonDetail, PersonSummary } from "@vipcam/shared";
import { and, eq, ilike, or, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import { erpClients } from "../schema/erp-cache.js";
import { type NewPerson, type Person, persons } from "../schema/persons.js";
import { sessions } from "../schema/sessions.js";

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

  /**
   * Listagem paginada de pessoas com filtros opcionais por tipo e search
   * (display_name OR phone via JOIN com erp_clients). Ordenado por
   * last_seen_at desc, NULLs por último.
   *
   * Onda 3 (visibility dashboard).
   */
  async listWithFilters(params: {
    type?: "client" | "employee";
    search?: string;
    limit: number;
    offset: number;
  }): Promise<PaginatedResponse<PersonSummary>> {
    const db = getDb();

    const whereClauses = [];
    if (params.type) whereClauses.push(eq(persons.person_type, params.type));
    if (params.search) {
      const pat = `%${params.search}%`;
      // search por display_name OR erp_clients.phone (subquery scalar)
      whereClauses.push(
        or(
          ilike(persons.display_name, pat),
          sql`EXISTS (SELECT 1 FROM ${erpClients} ec WHERE ec.erp_id = ${persons.erp_client_id} AND ec.phone ILIKE ${pat})`,
        ),
      );
    }
    const where = whereClauses.length ? and(...whereClauses) : undefined;

    const [items, totalRows] = await Promise.all([
      db
        .select({
          id: persons.id,
          display_name: persons.display_name,
          person_type: persons.person_type,
          photo_path: persons.thumbnail_path,
          last_seen_at: persons.last_seen_at,
          total_visits: persons.total_visits,
          erp_client_id: persons.erp_client_id,
          erp_employee_id: persons.erp_employee_id,
          phone: erpClients.phone,
        })
        .from(persons)
        .leftJoin(erpClients, eq(persons.erp_client_id, erpClients.erp_id))
        .where(where)
        .orderBy(sql`${persons.last_seen_at} DESC NULLS LAST`)
        .limit(params.limit)
        .offset(params.offset),
      db.select({ count: sql<number>`count(*)::int` }).from(persons).where(where),
    ]);

    return {
      items: items.map((row) => ({
        id: row.id,
        display_name: row.display_name,
        person_type: row.person_type,
        photo_path: row.photo_path,
        last_seen_at: row.last_seen_at?.toISOString() ?? null,
        total_visits: row.total_visits,
        erp_client_id: row.erp_client_id,
        erp_employee_id: row.erp_employee_id,
        phone: row.phone,
      })),
      total: totalRows[0]?.count ?? 0,
    };
  },

  /**
   * Versão enriquecida de findById que agrega first_seen_at + dominant_emotion
   * predominante (mode) + duração média das visitas, calculados via subqueries
   * em sessions. Onda 3 — usado pelo perfil em /people/[id].
   *
   * Retorna null se id não existe.
   */
  async findByIdWithStats(id: string): Promise<PersonDetail | null> {
    const db = getDb();
    const rows = await db
      .select({
        id: persons.id,
        display_name: persons.display_name,
        person_type: persons.person_type,
        photo_path: persons.thumbnail_path,
        last_seen_at: persons.last_seen_at,
        total_visits: persons.total_visits,
        erp_client_id: persons.erp_client_id,
        erp_employee_id: persons.erp_employee_id,
        phone: erpClients.phone,
        first_seen_at: sql<Date | null>`(SELECT MIN(${sessions.started_at}) FROM ${sessions} WHERE ${sessions.person_id} = ${persons.id})`,
        avg_dominant_emotion: sql<
          string | null
        >`(SELECT mode() WITHIN GROUP (ORDER BY ${sessions.dominant_emotion}) FROM ${sessions} WHERE ${sessions.person_id} = ${persons.id} AND ${sessions.dominant_emotion} IS NOT NULL)`,
        avg_visit_duration_min: sql<
          number | null
        >`(SELECT AVG(EXTRACT(EPOCH FROM (${sessions.ended_at} - ${sessions.started_at})) / 60.0)::float FROM ${sessions} WHERE ${sessions.person_id} = ${persons.id} AND ${sessions.ended_at} IS NOT NULL)`,
      })
      .from(persons)
      .leftJoin(erpClients, eq(persons.erp_client_id, erpClients.erp_id))
      .where(eq(persons.id, id))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      display_name: row.display_name,
      person_type: row.person_type,
      photo_path: row.photo_path,
      last_seen_at: row.last_seen_at?.toISOString() ?? null,
      total_visits: row.total_visits,
      erp_client_id: row.erp_client_id,
      erp_employee_id: row.erp_employee_id,
      phone: row.phone,
      first_seen_at: row.first_seen_at ? new Date(row.first_seen_at).toISOString() : null,
      avg_dominant_emotion: row.avg_dominant_emotion,
      avg_visit_duration_min: row.avg_visit_duration_min,
    };
  },
};
