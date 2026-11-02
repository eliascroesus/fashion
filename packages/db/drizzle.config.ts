import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  // Supabase owns the auth/storage schemas; we only manage public.
  schemaFilter: ['public'],
});
