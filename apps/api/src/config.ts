import { z } from 'zod';
import { GEMINI_PRICES } from './ai/gemini.ts';

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
  // Cloudflare R2: private bucket for originals, public bucket served on the image CDN.
  R2_ACCOUNT_ID: z.string().min(1),
  // Our buckets are in the EU jurisdiction (data stays in the EU).
  R2_JURISDICTION: z.enum(['eu', 'default']).default('eu'),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_ORIGINALS_BUCKET: z.string().min(1),
  R2_PUBLIC_BUCKET: z.string().min(1),
  MEDIA_PUBLIC_BASE_URL: z.url(),
  // Set automatically on Fly.io machines; tells us to trust the Fly-Client-IP header.
  FLY_APP_NAME: optional,
  // Gemini (garment spotting). Without a key, photos are published without it.
  GEMINI_API_KEY: optional,
  // Only models with a known price: the daily spend cap needs every call's cost.
  GEMINI_MODEL: z
    .enum(Object.keys(GEMINI_PRICES) as [keyof typeof GEMINI_PRICES])
    .default('gemini-3.1-flash-lite'),
  // How hard the model thinks; MODEL_DEFAULT leaves it to the model. Thinking is billed as output.
  GEMINI_THINKING_LEVEL: z
    .enum(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH', 'MODEL_DEFAULT'])
    .default('MINIMAL'),
  // Image detail Gemini reads (fewer tokens when lower); unset = the model's default.
  GEMINI_MEDIA_RESOLUTION: optional.pipe(z.enum(['LOW', 'MEDIUM', 'HIGH']).optional()),
  // AI spending stops for the day (UTC) once logged costs reach this.
  AI_DAILY_CAP_USD: z.coerce.number().positive().default(5),
  // The fingerprint service (services/embedder). Without it, nothing is fingerprinted.
  EMBEDDER_URL: optional.pipe(z.url().optional()),
  EMBEDDER_SECRET: optional.pipe(z.string().min(32).optional()),
});

export type Config = z.infer<typeof envSchema>;

export function r2Config(config: Config) {
  return {
    accountId: config.R2_ACCOUNT_ID,
    jurisdiction: config.R2_JURISDICTION,
    accessKeyId: config.R2_ACCESS_KEY_ID,
    secretAccessKey: config.R2_SECRET_ACCESS_KEY,
    originalsBucket: config.R2_ORIGINALS_BUCKET,
    publicBucket: config.R2_PUBLIC_BUCKET,
    publicBaseUrl: config.MEDIA_PUBLIC_BASE_URL,
  };
}

/** Reads and checks settings from the environment; stops with a clear message if any are wrong. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid API settings:\n${problems.join('\n')}`);
  }
  return result.data;
}
