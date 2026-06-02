import mysql, { type Pool, type PoolConnection, type PoolOptions } from "mysql2/promise";
import { getEnv } from "../config/env.js";
import { logger } from "../obs/logger.js";

let _pool: Pool | undefined;

/**
 * Monta a config do pool mysql2. Função pura (testável) — o `timezone` é a peça
 * crítica: faz o mysql2 interpretar os DATETIMEs do ERP (wall-clock BRT) como o
 * instante UTC correto, tanto na leitura (agendas.data → Date) quanto na
 * serialização do `?` (since: Date → literal). Sem isso, o edge (UTC) leria
 * '20:30' como 20:30Z e o match-temporal erraria 3h. (Onda 9-C)
 */
export function buildErpPoolConfig(env: {
  ERP_MYSQL_URL: string;
  ERP_TZ_OFFSET: string;
}): PoolOptions {
  return {
    uri: env.ERP_MYSQL_URL,
    timezone: env.ERP_TZ_OFFSET,
    connectionLimit: 5,
    waitForConnections: true,
    queueLimit: 0,
  };
}

export function getErpPool(): Pool {
  if (_pool) return _pool;
  const env = getEnv();
  if (!env.ERP_MYSQL_URL) throw new Error("ERP_MYSQL_URL is required");
  _pool = mysql.createPool(
    buildErpPoolConfig({
      ERP_MYSQL_URL: env.ERP_MYSQL_URL,
      ERP_TZ_OFFSET: env.ERP_TZ_OFFSET,
    }),
  );
  logger.info({ timezone: env.ERP_TZ_OFFSET }, "ERP MySQL pool initialized");
  return _pool;
}

export async function withErpConn<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await getErpPool().getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

export async function closeErpPool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
  }
}
