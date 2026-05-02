import { z } from "zod";

const envSchema = z.object({
  EDGE_PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_KEY: z.string().min(1, "API_KEY is required"),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(raw: NodeJS.ProcessEnv | Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid environment: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return result.data;
}

// Lazy singleton: parsing só acontece quando getEnv() é chamado pela primeira vez.
// Isso evita que o load do módulo (ex: pelo test runner importando parseEnv)
// dispare validação contra `process.env` real, que pode não ter API_KEY definido.
let _env: Env | undefined;

export function getEnv(): Env {
  if (!_env) _env = parseEnv(process.env);
  return _env;
}

/**
 * Reseta o singleton — útil em testes que precisam re-validar com process.env mockado.
 * Não usar em código de produção.
 */
export function resetEnvCache(): void {
  _env = undefined;
}
