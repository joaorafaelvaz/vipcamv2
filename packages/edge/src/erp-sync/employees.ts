import { getEnv } from "../config/env.js";
import { logger } from "../obs/logger.js";
import { erpRepo, personsRepo } from "../persistence/repositories/index.js";
import type { NewErpEmployee } from "../persistence/schema/erp-cache.js";
import { seedEmployeeFace } from "./employee-face-seeder.js";
import { makeProductionDeps } from "./employee-face-seeder-deps.js";
import { fetchErpEmployees } from "./queries.js";

/** Resultado base do sync — usado por clients.ts (sem fields novos da Onda 9-B). */
export interface SyncResult {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
}

/** Resultado do sync de employees — extends SyncResult com counters do seeder
 * (Onda 9-B). syncEmployees retorna esta forma; syncClients continua retornando
 * SyncResult plain. */
export interface EmployeeSyncResult extends SyncResult {
  // Onda 9-B: per-employee seeder outcomes
  embedded: number;
  skipped_placeholder: number;
  skipped_unchanged: number;
  fetch_failed: number;
  no_face: number;
  sidecar_error: number;
  seeder_unexpected_error: number;
}

/**
 * Sincroniza funcionários do ERP MySQL para o cache local.
 *
 * Para cada row do ERP:
 *  - se NÃO existe: cria erp_employees + Person (person_type=employee)
 *  - se mudou (name/is_active): atualiza ambos
 *  - se igual: skip
 *
 * Onda 9-B: após cada create/update, chama seedEmployeeFace pra baixar
 * foto do ERP, embeddar via sidecar, e popular face_records. Falhas do
 * seeder NÃO interrompem o loop — contadas no SyncResult pra observability.
 *
 * Idempotente: rodar 2x sem mudanças no ERP retorna { created: 0, updated: 0 }
 * e o seeder skipa via persons.last_embedded_image_token.
 */
export async function syncEmployees(): Promise<EmployeeSyncResult> {
  const rows = await fetchErpEmployees();
  const env = getEnv();
  const deps = makeProductionDeps(env);
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let embedded = 0;
  let skipped_placeholder = 0;
  let skipped_unchanged = 0;
  let fetch_failed = 0;
  let no_face = 0;
  let sidecar_error = 0;
  let seeder_unexpected_error = 0;

  for (const row of rows) {
    const erpId = String(row.id);
    const isActive = Boolean(row.is_active);
    const existing = await erpRepo.findEmployeeByErpId(erpId);
    let person: Awaited<ReturnType<typeof personsRepo.findByErpEmployeeId>> = null;

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
      person = await personsRepo.create({
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
          const p = await personsRepo.findByErpEmployeeId(erpId);
          if (p) await personsRepo.update(p.id, { display_name: row.name });
        }
        updated += 1;
      } else {
        skipped += 1;
      }
      // Onda 9-B: captura person p/ seeder (caminho update não criava
      // referência local antes — agora precisa pra passar pra seedEmployeeFace).
      person = await personsRepo.findByErpEmployeeId(erpId);
    }

    // Onda 9-B: seed face — falhas NÃO interrompem o loop, viram counters
    if (person && row.photo_url !== undefined) {
      try {
        const result = await seedEmployeeFace(person, row.photo_url, deps);
        switch (result.status) {
          case "embedded":
            embedded += 1;
            break;
          case "placeholder":
            skipped_placeholder += 1;
            break;
          case "unchanged":
            skipped_unchanged += 1;
            break;
          case "fetch_failed":
            fetch_failed += 1;
            break;
          case "no_face":
            no_face += 1;
            break;
          case "sidecar_error":
            sidecar_error += 1;
            break;
        }
      } catch (err) {
        seeder_unexpected_error += 1;
        logger.error({ erp_employee_id: erpId, err }, "seedEmployeeFace unexpected error");
      }
    }
  }

  const result: EmployeeSyncResult = {
    fetched: rows.length,
    created,
    updated,
    skipped,
    embedded,
    skipped_placeholder,
    skipped_unchanged,
    fetch_failed,
    no_face,
    sidecar_error,
    seeder_unexpected_error,
  };
  logger.info(result, "employee sync complete");
  return result;
}
