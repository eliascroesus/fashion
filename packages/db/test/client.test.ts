import { describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/client.ts';

describe('createDb', () => {
  it('survives an idle connection dropping (no crash, just a log line)', async () => {
    const db = createDb('postgres://nobody@127.0.0.1:1/none');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => db.$client.emit('error', new Error('read ETIMEDOUT'))).not.toThrow();
    expect(logged).toHaveBeenCalledWith('Database connection dropped while idle: read ETIMEDOUT');
    logged.mockRestore();
    await db.$client.end();
  });

  it('can pass a dropped connection to the caller’s logger instead', async () => {
    const seen: string[] = [];
    const db = createDb('postgres://nobody@127.0.0.1:1/none', {
      onConnectionError: (error) => seen.push(error.message),
    });
    db.$client.emit('error', new Error('read ECONNRESET'));
    expect(seen).toEqual(['read ECONNRESET']);
    await db.$client.end();
  });
});
