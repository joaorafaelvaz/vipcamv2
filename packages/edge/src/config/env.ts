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
    ERP_MYSQL_URL: z
      .string()
      .regex(/^mysql:\/\//, "ERP_MYSQL_URL must start with mysql://")
      .optional(),
    // Queries SQL configuráveis pro ERP — defaults assumem schema padrão
    // (employees/clients/checkins). Override via env se schema do ERP diverge.
    ERP_QUERY_EMPLOYEES: z
      .string()
      .default(
        "SELECT id, name, role, photo_url, photo_updated_at, is_active FROM employees WHERE is_active = 1",
      ),
    ERP_QUERY_CLIENTS: z
      .string()
      .default("SELECT id, name, phone, is_active FROM clients WHERE is_active = 1"),
    ERP_QUERY_CHECKINS_SINCE: z
      .string()
      .default(
        "SELECT id, client_id, event_type, occurred_at, metadata FROM checkins WHERE occurred_at >= ? ORDER BY occurred_at",
      ),
    // Match temporal: janela ±N segundos em torno do checkin do ERP usada
    // pra encontrar detections anônimas candidatas. Default 300s (±5min) —
    // ajustar com base em volume real (horários de pico podem precisar
    // janela menor pra reduzir ambiguidade).
    MATCH_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
    // Onda 9-C: offset do timezone em que o ERP grava DATETIMEs (agendas.data é
    // wall-clock BRT). O edge roda em UTC; sem isso o mysql2 leria '20:30' como
    // 20:30Z (3h errado) e a janela do match-temporal nunca casaria com
    // detected_at (UTC do RealUTC da câmera). Brasil sem DST desde 2019 → offset
    // fixo é seguro. Formato mysql2: "±HH:MM".
    ERP_TZ_OFFSET: z
      .string()
      .regex(/^[+-]\d{2}:\d{2}$/, "ERP_TZ_OFFSET must look like -03:00")
      .default("-03:00"),
    // Onda 9-C: tamanho da janela deslizante do pollCheckins. Cada poll re-escaneia
    // `data >= now − N horas` (sem cursor monotônico — `agendas.data` não é
    // monotônico com o instante do check-in). 24h cobre um dia de operação +
    // gaps de restart; dedup por erp_id evita re-inserção.
    ERP_CHECKINS_LOOKBACK_HOURS: z.coerce.number().int().positive().default(24),
    // Onda 9-B: prefixo HTTPS público das fotos do ERP. O seeder concatena
    // com `usuarios.imagem` (ex: "avatar_1966.jpg?p8yr") pra montar a URL
    // absoluta antes de fetch. Path confirmado via /api/v2/agendas/getUnidade
    // (campo imagem_url) probe 2026-05-31: host SEM www, path /layout/img/avatar/.
    // Override em produção via /etc/vipcam/edge.env se o ERP mudar o domínio.
    ERP_PHOTO_URL_PREFIX: z.string().url().default("https://franquiabv.com.br/layout/img/avatar/"),
    // Onda 5: timezone p/ buckets de dia/hora das métricas. Timestamps são
    // timestamptz (UTC); a barbearia é local — sem isso pico/fluxo deslocam ~3h.
    METRICS_TZ: z.string().min(1).default("America/Sao_Paulo"),
    // Onda 7 — Failover B
    REID_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    REID_BASE_URL: z.string().url().default("http://127.0.0.1:5005"),
    // Thresholds via ENV pra calibração empírica sem rebuild — ver spec §4.3.
    REID_DIST_STRICT: z.coerce.number().min(0).max(2).default(0.35),
    REID_DIST_LOOSE: z.coerce.number().min(0).max(2).default(0.55),
    SNAPSHOTS_DIR: z.string().min(1).default("/var/lib/vipcam/snapshots"),
    // Onda 7: dimensões do frame que vem do snapshot.cgi. Necessário pra
    // denormalizar event.bbox (que é 0..1) pra pixels inteiros antes do
    // sidecar /embed (FastAPI Form(int) rejeita "0.234"). Default 2688x1520
    // conforme probe report Onda 6 — DH-IPC-HFW5442T-ASE @ channel=1.
    CAMERA_FRAME_WIDTH: z.coerce.number().int().positive().default(2688),
    CAMERA_FRAME_HEIGHT: z.coerce.number().int().positive().default(1520),
  })
  .refine(
    (v) =>
      (v.CAMERA_IP && v.CAMERA_USER && v.CAMERA_PASS) ||
      (!v.CAMERA_IP && !v.CAMERA_USER && !v.CAMERA_PASS),
    { message: "CAMERA_IP/USER/PASS must be all set or all unset" },
  )
  .refine((v) => v.REID_DIST_STRICT < v.REID_DIST_LOOSE, {
    message: "REID_DIST_STRICT must be < REID_DIST_LOOSE (strict < borderline boundary)",
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
