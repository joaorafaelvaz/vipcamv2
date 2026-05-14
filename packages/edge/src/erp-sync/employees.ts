import { logger } from "../obs/logger.js";
import { erpRepo, personsRepo } from "../persistence/repositories/index.js";
import type { NewErpEmployee } from "../persistence/schema/erp-cache.js";
import { fetchErpEmployees } from "./queries.js";

export interface SyncResult {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
}

/**
 * Sincroniza funcionários do ERP MySQL para o cache local.
 *
 * Para cada row do ERP:
 *  - se NÃO existe: cria erp_employees + Person (person_type=employee)
 *  - se mudou (name/is_active): atualiza ambos
 *  - se igual: skip
 *
 * Idempotente: rodar 2x sem mudanças no ERP retorna { created: 0, updated: 0 }.
 *
 * ⚠ Pós-Discovery 2026-05-11: NÃO faz upload pra Face DB câmera (P3 refutada).
 * Reconhecimento facial automático de funcionários só vem na Onda 3
 * (failover B com InsightFace local + pgvector ANN match).
 */
export async function syncEmployees(): Promise<SyncResult> {
  const rows = await fetchErpEmployees();
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const erpId = String(row.id);
    const isActive = Boolean(row.is_active);
    const existing = await erpRepo.findEmployeeByErpId(erpId);

    if (!existing) {
      // Cache local — usa exactOptionalPropertyTypes-safe construction
      const newRow: NewErpEmployee = {
        erp_id: erpId,
        name: row.name,
        is_active: isActive,
      };
      if (row.role !== undefined) newRow.role = row.role;
      if (row.photo_url !== undefined) newRow.photo_path = row.photo_url;
      if (row.photo_updated_at !== undefined) {
        newRow.erp_updated_at = new Date(row.photo_updated_at);
      }
      await erpRepo.upsertEmployee(newRow);

      // Person vinculada
      await personsRepo.create({
        person_type: "employee",
        display_name: row.name,
        erp_employee_id: erpId,
      });
      created += 1;
    } else {
      // I2 (review 2026-05-13): comparar TODAS as colunas mutáveis. Antes,
      // role/photo_url mudando no ERP eram skipados → cache stale.
      const nameChanged = row.name !== existing.name;
      const activeChanged = isActive !== existing.is_active;
      const roleChanged = row.role !== undefined && existing.role !== row.role;
      const photoChanged = row.photo_url !== undefined && existing.photo_path !== row.photo_url;
      if (nameChanged || activeChanged || roleChanged || photoChanged) {
        const patch: NewErpEmployee = {
          ...existing,
          name: row.name,
          is_active: isActive,
        };
        if (row.role !== undefined) patch.role = row.role;
        if (row.photo_url !== undefined) patch.photo_path = row.photo_url;
        if (row.photo_updated_at !== undefined) {
          patch.erp_updated_at = new Date(row.photo_updated_at);
        }
        await erpRepo.upsertEmployee(patch);

        // Person.display_name segue erp_employees.name. Outras colunas de Person
        // (display_name) só atualizam quando name muda — evita UPDATE no-op.
        if (nameChanged) {
          const person = await personsRepo.findByErpEmployeeId(erpId);
          if (person) await personsRepo.update(person.id, { display_name: row.name });
        }
        updated += 1;
      } else {
        skipped += 1;
      }
    }
  }

  logger.info({ fetched: rows.length, created, updated, skipped }, "employee sync complete");
  return { fetched: rows.length, created, updated, skipped };
}
