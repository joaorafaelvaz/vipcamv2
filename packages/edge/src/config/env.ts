import { z } from "zod";

const envSchema = z
  .object({
    EDGE_PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    API_KEY: z.string().min(1, "API_KEY is required"),
    // Camera (opcional — quando ausente, discovery roda em modo offline para testes)
    CAMERA_IP: z
      .string()
      .regex(/^(\d{1,3}\.){3}\d{1,3}$/, "CAMERA_IP must be a valid IPv4")
      .optional(),
    CAMERA_USER: z.string().optional(),
    CAMERA_PASS: z.string().optional(),
    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\//, "DATABASE_URL must start with postgres:// or postgresql://")
      .optional(),
  })
  .refine(
    (v) =>
      (v.CAMERA_IP && v.CAMERA_USER && v.CAMERA_PASS) ||
      (!v.CAMERA_IP && !v.CAMERA_USER && !v.CAMERA_PASS),
    { message: "CAMERA_IP/USER/PASS must be all set or all unset" },
  );

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
