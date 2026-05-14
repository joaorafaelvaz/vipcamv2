import { logger } from "../obs/logger.js";
import { erpRepo } from "../persistence/repositories/index.js";
import type { NewErpClient } from "../persistence/schema/erp-cache.js";
import type { SyncResult } from "./employees.js";
import { fetchErpClients } from "./queries.js";

/**
 * Sincroniza clientes do ERP MySQL para o cache local. Pattern idêntico a
 * syncEmployees() mas mais simples — não cria Person record (clientes
 * só viram Person quando match temporal vincula a uma detection anônima).
 *
 * Idempotente. Retorna SyncResult { fetched, created, updated, skipped }.
 */
export async function syncClients(): Promise<SyncResult> {
  const rows = await fetchErpClients();
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const erpId = String(row.id);
    const isActive = Boolean(row.is_active);
    const existing = await erpRepo.findClientByErpId(erpId);

    if (!existing) {
      const newRow: NewErpClient = {
        erp_id: erpId,
        name: row.name,
        is_active: isActive,
      };
      if (row.phone !== undefined) newRow.phone = row.phone;
      await erpRepo.upsertClient(newRow);
      created += 1;
      continue;
    }

    // I2 (review 2026-05-13): comparar TODAS as colunas mutáveis (não só
    // name/is_active). Antes do fix, cliente trocando telefone no ERP era
    // skipado e o cache local ficava com phone stale.
    const phoneChanged = row.phone !== undefined && existing.phone !== row.phone;
    const nameChanged = existing.name !== row.name;
    const activeChanged = existing.is_active !== isActive;
    if (nameChanged || activeChanged || phoneChanged) {
      const patch: NewErpClient = {
        ...existing,
        name: row.name,
        is_active: isActive,
      };
      if (row.phone !== undefined) patch.phone = row.phone;
      await erpRepo.upsertClient(patch);
      updated += 1;
    } else {
      skipped += 1;
    }
  }

  logger.info({ fetched: rows.length, created, updated, skipped }, "client sync complete");
  return { fetched: rows.length, created, updated, skipped };
}
