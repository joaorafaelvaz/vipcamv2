import type { RowDataPacket } from "mysql2/promise";
import { getEnv } from "../config/env.js";
import { logger } from "../obs/logger.js";
import { withErpConn } from "./mysql-client.js";

/**
 * Tipos das linhas esperadas das queries ERP. As queries são configuráveis
 * via env (ERP_QUERY_*), mas DEVEM retornar pelo menos as colunas listadas
 * em REQUIRED_COLUMNS — validateErpQueries() valida no boot e falha hard
 * se faltar algo.
 */
export interface ErpEmployeeRow extends RowDataPacket {
  id: string | number;
  name: string;
  role?: string;
  photo_url?: string;
  photo_updated_at?: Date | string;
  is_active: number | boolean;
}

export interface ErpClientRow extends RowDataPacket {
  id: string | number;
  name: string;
  phone?: string;
  is_active: number | boolean;
}

export interface ErpCheckinRow extends RowDataPacket {
  id: string | number;
  client_id: string | number;
  event_type: string;
  occurred_at: Date | string;
  metadata?: string | null; // JSON string (parseado pelo caller)
}

export async function fetchErpEmployees(): Promise<ErpEmployeeRow[]> {
  const env = getEnv();
  return withErpConn(async (conn) => {
    const [rows] = await conn.execute<ErpEmployeeRow[]>(env.ERP_QUERY_EMPLOYEES);
    return rows;
  });
}

export async function fetchErpClients(): Promise<ErpClientRow[]> {
  const env = getEnv();
  return withErpConn(async (conn) => {
    const [rows] = await conn.execute<ErpClientRow[]>(env.ERP_QUERY_CLIENTS);
    return rows;
  });
}

export async function fetchErpCheckinsSince(since: Date): Promise<ErpCheckinRow[]> {
  const env = getEnv();
  return withErpConn(async (conn) => {
    const [rows] = await conn.execute<ErpCheckinRow[]>(env.ERP_QUERY_CHECKINS_SINCE, [since]);
    return rows;
  });
}

/**
 * Colunas que CADA query precisa retornar. Validadas no boot via
 * validateErpQueries(); ajuste do schema do ERP é resolvido com SQL "AS"
 * (ex: "SELECT cod AS id, nome AS name, ..." pra esquemas em pt).
 */
const REQUIRED_COLUMNS = {
  employees: ["id", "name", "is_active"],
  clients: ["id", "name", "is_active"],
  checkins: ["id", "client_id", "event_type", "occurred_at"],
} as const;

/**
 * Valida no boot que as queries configuradas retornam as colunas necessárias.
 * Falha hard com mensagem acionável se faltar algo (vs descobrir 30s depois
 * quando o cron disparar). Usar `LIMIT 1` evita carregar dados — apenas
 * inspeciona o shape das colunas via field metadata do mysql2.
 */
export async function validateErpQueries(): Promise<void> {
  const env = getEnv();
  await withErpConn(async (conn) => {
    // employees + clients (sem placeholders)
    for (const [kind, query] of [
      ["employees", `${env.ERP_QUERY_EMPLOYEES} LIMIT 1`],
      ["clients", `${env.ERP_QUERY_CLIENTS} LIMIT 1`],
    ] as const) {
      const [rows, fields] = await conn.execute(query);
      const cols = fields.map((f) => f.name.toLowerCase());
      for (const required of REQUIRED_COLUMNS[kind]) {
        if (!cols.includes(required.toLowerCase())) {
          throw new Error(
            `ERP query "${kind}" missing required column: "${required}". Got: ${cols.join(", ")}. Use SQL AS to alias if your schema differs.`,
          );
        }
      }
      logger.info(
        { kind, columns: cols, sample_rows: (rows as RowDataPacket[]).length },
        "ERP query validated",
      );
    }

    // checkins (usa "?" param — passamos new Date(0) só pra exercitar a query)
    const [, fields] = await conn.execute(`${env.ERP_QUERY_CHECKINS_SINCE} LIMIT 1`, [new Date(0)]);
    const cols = fields.map((f) => f.name.toLowerCase());
    for (const required of REQUIRED_COLUMNS.checkins) {
      if (!cols.includes(required.toLowerCase())) {
        throw new Error(
          `ERP query "checkins" missing required column: "${required}". Got: ${cols.join(", ")}.`,
        );
      }
    }
    logger.info({ kind: "checkins", columns: cols }, "ERP query validated");
  });
}
