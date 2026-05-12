import mysql, { type Pool, type PoolConnection } from "mysql2/promise";
import { getEnv } from "../config/env.js";
import { logger } from "../obs/logger.js";

let _pool: Pool | undefined;

export function getErpPool(): Pool {
  if (_pool) return _pool;
  const env = getEnv();
  if (!env.ERP_MYSQL_URL) throw new Error("ERP_MYSQL_URL is required");
  _pool = mysql.createPool({
    uri: env.ERP_MYSQL_URL,
    connectionLimit: 5,
    waitForConnections: true,
    queueLimit: 0,
  });
  logger.info("ERP MySQL pool initialized");
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
