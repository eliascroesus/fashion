import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

describe('settings', () => {
  it('stop with a clear message when required settings are missing', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*SUPABASE_URL/);
  });

  it('fill in defaults and treat empty optional values as unset', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://localhost/x',
      SUPABASE_URL: 'https://p.supabase.co',
      DATABASE_CA_CERT: '',
    });
    expect(config).toMatchObject({ PORT: 8080, HOST: '0.0.0.0', RATE_LIMIT_PER_MINUTE: 300 });
    expect(config.DATABASE_CA_CERT).toBeUndefined();
  });
});
