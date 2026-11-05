import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const REQUIRED = {
  DATABASE_URL: 'postgres://localhost/x',
  SUPABASE_URL: 'https://p.supabase.co',
  R2_ACCOUNT_ID: 'acc',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_ORIGINALS_BUCKET: 'outfitly-originals',
  R2_PUBLIC_BUCKET: 'outfitly-public',
  MEDIA_PUBLIC_BASE_URL: 'https://img.example.com',
};

describe('settings', () => {
  it('stop with a clear message when required settings are missing', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*SUPABASE_URL[\s\S]*R2_ACCOUNT_ID/);
  });

  it('fill in defaults and treat empty optional values as unset', () => {
    const config = loadConfig({ ...REQUIRED, DATABASE_CA_CERT: '' });
    expect(config).toMatchObject({
      PORT: 8080,
      HOST: '0.0.0.0',
      RATE_LIMIT_PER_MINUTE: 300,
      R2_JURISDICTION: 'eu',
    });
    expect(config.DATABASE_CA_CERT).toBeUndefined();
  });

  it('turn the photo AI off without keys and only take priced Gemini models', () => {
    const config = loadConfig({ ...REQUIRED, GEMINI_API_KEY: '', EMBEDDER_URL: '' });
    expect(config).toMatchObject({
      GEMINI_MODEL: 'gemini-3.1-flash-lite',
      GEMINI_THINKING_LEVEL: 'MINIMAL',
      AI_DAILY_CAP_USD: 5,
    });
    expect(config.GEMINI_API_KEY).toBeUndefined();
    expect(config.EMBEDDER_URL).toBeUndefined();
    expect(config.GEMINI_MEDIA_RESOLUTION).toBeUndefined();
    expect(() => loadConfig({ ...REQUIRED, GEMINI_MODEL: 'gemini-9-ultra' })).toThrow(
      /GEMINI_MODEL/,
    );
    expect(() => loadConfig({ ...REQUIRED, EMBEDDER_SECRET: 'short' })).toThrow(/EMBEDDER_SECRET/);
    expect(() => loadConfig({ ...REQUIRED, AI_DAILY_CAP_USD: '0' })).toThrow(/AI_DAILY_CAP_USD/);
  });
});
