import { z } from 'zod';

const optional = z
  .string()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // Supabase direct or session connection (port 5432), never the transaction pooler.
  DATABASE_URL: z.string().min(1),
  DATABASE_CA_CERT: optional,
  // Login tokens are checked against this project's public signing keys.
  SUPABASE_URL: z.url(),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  // Set automatically on Fly.io machines; tells us to trust the Fly-Client-IP header.
  FLY_APP_NAME: optional,
});

export type Config = z.infer<typeof envSchema>;

/** Reads and checks settings from the environment; stops with a clear message if any are wrong. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid API settings:\n${problems.join('\n')}`);
  }
  return result.data;
}
