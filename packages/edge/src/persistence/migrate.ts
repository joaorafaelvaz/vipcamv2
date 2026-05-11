import { join } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { logger } from "../obs/logger.js";
import { closeDb, getDb } from "./db.js";

async function run() {
  const db = getDb();
  const folder = join(import.meta.dir, "migrations");
  logger.info({ folder }, "running migrations");
  await migrate(db, { migrationsFolder: folder });
  logger.info("migrations complete");
  await closeDb();
}

run().catch((err) => {
  logger.error({ err }, "migrations failed");
  process.exit(1);
});
