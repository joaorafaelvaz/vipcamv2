import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import {
  type ErpCheckin,
  type ErpClient,
  type ErpEmployee,
  type NewErpCheckin,
  type NewErpClient,
  type NewErpEmployee,
  erpCheckins,
  erpClients,
  erpEmployees,
} from "../schema/erp-cache.js";

/**
 * 3 entidades em 1 repo porque sempre usadas juntas (sync ERP, match temporal).
 */
export const erpRepo = {
  // ============ Clients ============
  async upsertClient(data: NewErpClient): Promise<ErpClient> {
    const [c] = await getDb()
      .insert(erpClients)
      .values(data)
      .onConflictDoUpdate({
        target: erpClients.erp_id,
        set: {
          name: data.name,
          phone: data.phone,
          photo_path: data.photo_path,
          is_active: data.is_active ?? true,
          erp_updated_at: data.erp_updated_at,
          synced_at: sql`now()`,
        },
      })
      .returning();
    if (!c) throw new Error("upsert returned no row");
    return c;
  },

  async findClientByErpId(erpId: string): Promise<ErpClient | null> {
    const rows = await getDb()
      .select()
      .from(erpClients)
      .where(eq(erpClients.erp_id, erpId))
      .limit(1);
    return rows[0] ?? null;
  },

  // ============ Employees ============
  async upsertEmployee(data: NewErpEmployee): Promise<ErpEmployee> {
    const [e] = await getDb()
      .insert(erpEmployees)
      .values(data)
      .onConflictDoUpdate({
        target: erpEmployees.erp_id,
        set: {
          name: data.name,
          role: data.role,
          photo_path: data.photo_path,
          photo_hash: data.photo_hash,
          is_active: data.is_active ?? true,
          erp_updated_at: data.erp_updated_at,
          synced_at: sql`now()`,
        },
      })
      .returning();
    if (!e) throw new Error("upsert returned no row");
    return e;
  },

  async findEmployeeByErpId(erpId: string): Promise<ErpEmployee | null> {
    const rows = await getDb()
      .select()
      .from(erpEmployees)
      .where(eq(erpEmployees.erp_id, erpId))
      .limit(1);
    return rows[0] ?? null;
  },

  // ============ Checkins ============
  async upsertCheckin(data: NewErpCheckin): Promise<ErpCheckin> {
    const [c] = await getDb()
      .insert(erpCheckins)
      .values(data)
      .onConflictDoUpdate({
        target: erpCheckins.erp_id,
        set: {
          erp_client_id: data.erp_client_id,
          event_type: data.event_type,
          occurred_at: data.occurred_at,
          metadata: data.metadata ?? {},
          // processed_at NÃO é resetado por upsert — preserva estado de processamento
        },
      })
      .returning();
    if (!c) throw new Error("upsert returned no row");
    return c;
  },

  async findCheckinByErpId(erpId: string): Promise<ErpCheckin | null> {
    const rows = await getDb()
      .select()
      .from(erpCheckins)
      .where(eq(erpCheckins.erp_id, erpId))
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * Checkins ainda não processados que ocorreram em ou antes de `before`.
   * Usado pelo match-temp loop (processa checkins com delay X após ocorrerem).
   */
  async findUnprocessedCheckinsBefore(before: Date, limit: number): Promise<ErpCheckin[]> {
    return getDb()
      .select()
      .from(erpCheckins)
      .where(and(isNull(erpCheckins.processed_at), lte(erpCheckins.occurred_at, before)))
      .orderBy(asc(erpCheckins.occurred_at))
      .limit(limit);
  },

  async markCheckinProcessed(erpCheckinId: string): Promise<void> {
    await getDb()
      .update(erpCheckins)
      .set({ processed_at: sql`now()` })
      .where(eq(erpCheckins.erp_id, erpCheckinId));
  },
};
