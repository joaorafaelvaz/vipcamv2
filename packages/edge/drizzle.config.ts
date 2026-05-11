import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/persistence/schema/index.ts",
  out: "./src/persistence/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://vipcam:vipcam@localhost:5432/vipcam",
  },
  // Verbose nos comandos para debugging
  verbose: true,
  strict: true,
});
