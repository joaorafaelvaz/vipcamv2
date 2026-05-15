import { z } from "zod";

const clientEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z
    .string()
    .url()
    .regex(/^https?:\/\//, "must start with http:// or https://"),
  NEXT_PUBLIC_API_KEY: z.string().min(1),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;

export function parseClientEnv(raw: Record<string, string | undefined>): ClientEnv {
  const r = clientEnvSchema.safeParse(raw);
  if (!r.success) {
    throw new Error(
      `Invalid client env: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
    );
  }
  return r.data;
}

// Lazy singleton. Next.js inlining substitui NEXT_PUBLIC_* em build time,
// então process.env.NEXT_PUBLIC_* é estático no bundle do client.
let _env: ClientEnv | undefined;

export function getClientEnv(): ClientEnv {
  if (!_env) {
    _env = parseClientEnv({
      NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
      NEXT_PUBLIC_API_KEY: process.env.NEXT_PUBLIC_API_KEY,
    });
  }
  return _env;
}
