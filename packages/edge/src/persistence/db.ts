import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getEnv } from "../config/env.js";
import { logger } from "../obs/logger.js";

let _db: PostgresJsDatabase | undefined;
let _client: ReturnType<typeof postgres> | undefined;

export function getDb(): PostgresJsDatabase {
  if (_db) return _db;
  const env = getEnv();
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to use the database");
  }
  _client = postgres(env.DATABASE_URL, {
    max: 10,
    idle_timeout: 30,
    onnotice: (n) => logger.debug({ notice: n }, "pg notice"),
  });
  _db = drizzle(_client);
  logger.info("postgres connection initialized");
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.end({ timeout: 5 });
    _client = undefined;
    _db = undefined;
  }
}
