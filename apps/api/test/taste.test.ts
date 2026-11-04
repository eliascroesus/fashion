import { eq, tasteProfiles } from '@outfitly/db';
import { meSchema, STYLES, tastePickerSchema, tasteSchema } from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PICKER_LOOKS } from '../src/taste.ts';
import { createAuthor, createLogin, createLooks } from './feed-fixtures.ts';
import { buildTestApp, createTestContext, type TestContext } from './helpers.ts';

let ctx: TestContext;
let app: FastifyInstance;

beforeAll(async () => {
  ctx = await createTestContext();
  app = await buildTestApp(ctx);
  await app.ready();
  const authors = [await createAuthor(ctx.db, 'taste.a'), await createAuthor(ctx.db, 'taste.b')];
  // Three looks per style, the first of each the most popular; one draft that must never show.
  await createLooks(
    ctx.db,
    STYLES.flatMap((style, s) =>
      [0, 1, 2].map((rank) => ({
        authorId: authors[(s + rank) % 2] ?? '',
        styles: [style],
        popularity: 0.9 - rank * 0.3 - s * 0.01,
      })),
    ),
  );
  await createLooks(ctx.db, [
    { authorId: authors[0] ?? '', styles: ['streetwear'], popularity: 5, status: 'draft' },
  ]);
});

afterAll(async () => {
  await app.close();
  await ctx.close();
});

async function viewer(): Promise<{ token: string; profileId: string }> {
  const { token } = await createLogin(ctx.db);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/session',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() },
    payload: {},
  });
  const me = meSchema.parse(res.json());
  if (!me.activeProfileId) throw new Error('no active profile');
  return { token, profileId: me.activeProfileId };
}

function putTaste(token: string | null, payload: unknown, key: string = crypto.randomUUID()) {
  return app.inject({
    method: 'PUT',
    url: '/v1/taste',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'idempotency-key': key },
    payload: payload as Record<string, unknown>,
  });
}

describe('PUT /v1/taste', () => {
  it('stores the picked styles and brands for a profile without a taste', async () => {
    const { token, profileId } = await viewer();
    const res = await putTaste(token, { styles: ['edgy', 'minimal'], brands: ['cos'] });
    expect(res.statusCode, res.body).toBe(200);
    expect(tasteSchema.parse(res.json())).toEqual({ styles: ['minimal', 'edgy'], brands: ['cos'] });
    const [row] = await ctx.db
      .select()
      .from(tasteProfiles)
      .where(eq(tasteProfiles.profileId, profileId));
    expect(row).toMatchObject({ styles: ['minimal', 'edgy'], brands: ['cos'] });
  });

  it('keeps a taste the profile already has (picks from a logged-out phone never overwrite it)', async () => {
    const { token } = await viewer();
    await putTaste(token, { styles: ['classic'], brands: [] });
    const res = await putTaste(token, { styles: ['streetwear'], brands: ['nike'] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ styles: ['classic'], brands: [] });
  });

  it('answers a retry with the same key without storing twice', async () => {
    const { token, profileId } = await viewer();
    const key = crypto.randomUUID();
    const body = { styles: ['sporty'], brands: [] };
    const first = await putTaste(token, body, key);
    const again = await putTaste(token, body, key);
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(await ctx.db.$count(tasteProfiles, eq(tasteProfiles.profileId, profileId))).toBe(1);
  });

  it('refuses unknown styles or brands, and needs a login', async () => {
    const { token } = await viewer();
    expect((await putTaste(token, { styles: ['goth'], brands: [] })).statusCode).toBe(400);
    expect((await putTaste(token, { styles: [], brands: ['gucci'] })).statusCode).toBe(400);
    expect((await putTaste(null, { styles: ['edgy'], brands: [] })).statusCode).toBe(401);
  });
});

describe('GET /v1/taste/picker', () => {
  it("works logged out: each style's most popular look first, then more, up to 10", async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/taste/picker' });
    expect(res.statusCode, res.body).toBe(200);
    const { items } = tastePickerSchema.parse(res.json());
    expect(items).toHaveLength(PICKER_LOOKS);
    // Every style shows up once among the first STYLES.length looks.
    const firstRound = items.slice(0, STYLES.length).flatMap((item) => item.styles);
    expect(new Set(firstRound)).toEqual(new Set(STYLES));
    expect(new Set(items.map((item) => item.card.id)).size).toBe(items.length);
    expect(items.every((item) => item.card.photo.urls[600].startsWith('https://'))).toBe(true);
  });
});
