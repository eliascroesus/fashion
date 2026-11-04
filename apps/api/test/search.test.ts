import { sql } from '@outfitly/db';
import {
  type FeedPage,
  feedPageSchema,
  meSchema,
  popularTagsSchema,
  suggestionsSchema,
} from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refreshSearchTerms, wordsQuery } from '../src/search.ts';
import { createAuthor, createLogin, createLook, createLooks } from './feed-fixtures.ts';
import { buildTestApp, createTestContext, type TestContext } from './helpers.ts';

let ctx: TestContext;
let app: FastifyInstance;
let author: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  ctx = await createTestContext();
  app = await buildTestApp(ctx);
  await app.ready();
  author = await createAuthor(ctx.db, 'search.author');
  const gone = await createAuthor(ctx.db, 'search.gone');

  ids['linenShirt'] = await createLook(ctx.db, {
    authorId: author,
    caption: 'Cream linen shirt, wide beige trousers and loafers',
    seasons: ['summer'],
    styles: ['minimal'],
  });
  ids['linenDress'] = await createLook(ctx.db, {
    authorId: author,
    caption: 'Linen dress with sandals',
    occasions: ['date'],
    seasons: ['summer'],
    styles: ['romantic'],
  });
  ids['leather'] = await createLook(ctx.db, {
    authorId: author,
    caption: 'Black leather jacket over a white tee and straight jeans',
    seasons: ['autumn'],
    styles: ['edgy'],
  });
  ids['hidden'] = await createLook(ctx.db, {
    authorId: author,
    caption: 'Linen hidden',
    status: 'hidden',
  });
  ids['draft'] = await createLook(ctx.db, {
    authorId: author,
    caption: 'Linen draft',
    status: 'draft',
  });
  ids['unready'] = await createLook(ctx.db, {
    authorId: author,
    caption: 'Linen not ready',
    cover: 'processing',
  });
  ids['goneAuthor'] = await createLook(ctx.db, { authorId: gone, caption: 'Linen gone' });
  await ctx.db.execute(sql`UPDATE profiles SET deleted_at = now() WHERE id = ${gone}`);
  await createLooks(
    ctx.db,
    Array.from({ length: 45 }, (_, i) => ({
      authorId: author,
      caption: 'Striped knit sweater',
      hoursAgo: 100 + i,
    })),
  );
  await refreshSearchTerms(ctx.db);
});

afterAll(async () => {
  await app.close();
  await ctx.close();
});

async function get(url: string, token?: string) {
  return app.inject({
    method: 'GET',
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function search(q: string, cursor?: string, token?: string): Promise<FeedPage> {
  const params = new URLSearchParams({ q, ...(cursor ? { cursor } : {}) });
  const res = await get(`/v1/search/looks?${params.toString()}`, token);
  expect(res.statusCode).toBe(200);
  return feedPageSchema.parse(res.json());
}

const found = async (q: string) => (await search(q)).items.map((c) => c.id).sort();
const sorted = (...names: string[]) => names.map((n) => ids[n]).sort();

async function suggestions(q: string) {
  const res = await get(`/v1/search/suggest?${new URLSearchParams({ q }).toString()}`);
  expect(res.statusCode).toBe(200);
  return suggestionsSchema.parse(res.json());
}

describe('search', () => {
  it('finds linen looks for "linnen" (a typo), and nothing else', async () => {
    expect(await found('linnen')).toEqual(sorted('linenShirt', 'linenDress'));
    expect(await found('linen')).toEqual(sorted('linenShirt', 'linenDress'));
    expect(await found('LINEN!')).toEqual(sorted('linenShirt', 'linenDress'));
  });

  it('finds tags by their id, a typo of it, or their Swedish word', async () => {
    expect(await found('minimel')).toEqual(sorted('linenShirt'));
    expect(await found('summer')).toEqual(sorted('linenShirt', 'linenDress'));
    expect(await found('sommar')).toEqual(sorted('linenShirt', 'linenDress'));
    expect(await found('höst')).toEqual(sorted('leather'));
    expect(await found('Dejt')).toEqual(sorted('linenDress'));
  });

  it('needs every word, leaves out small words, and completes the last word', async () => {
    expect(await found('linen dress')).toEqual(sorted('linenDress'));
    expect(await found('linen jacket')).toEqual([]);
    expect(await found('shirt with loafers')).toEqual(sorted('linenShirt'));
    expect(await found('leath')).toEqual(sorted('leather'));
    expect(await found('white tee')).toEqual(sorted('leather'));
    expect(await found('wide-leg')).toEqual([]);
  });

  it('never shows hidden or draft looks, unready photos or deleted authors', async () => {
    const all = await found('linen');
    for (const name of ['hidden', 'draft', 'unready', 'goneAuthor']) {
      expect(all).not.toContain(ids[name]);
    }
  });

  it('pages through every match 20 at a time without repeats', async () => {
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await search('sweater', cursor);
      sizes.push(page.items.length);
      seen.push(...page.items.map((c) => c.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(sizes).toEqual([20, 20, 5]);
    expect(new Set(seen).size).toBe(45);
  });

  it('ranks a word in the caption above the same word in the AI description', async () => {
    const [inAi, inCaption] = await createLooks(ctx.db, [
      { authorId: author, caption: 'Grey coat', popularity: 0.9 },
      { authorId: author, caption: 'Velvet blazer', popularity: 0.01 },
    ]);
    await ctx.db.execute(
      sql`UPDATE looks SET ai_description = 'A grey coat over a velvet top' WHERE id = ${inAi}`,
    );
    expect((await search('velvet')).items.map((c) => c.id)).toEqual([inCaption, inAi]);
  });

  it('shows what the logged-in viewer saved', async () => {
    const { token } = await createLogin(ctx.db);
    const session = await app.inject({
      method: 'POST',
      url: '/v1/session',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() },
      payload: {},
    });
    const profileId = meSchema.parse(session.json()).activeProfileId;
    await ctx.db.execute(
      sql`INSERT INTO saves (profile_id, look_id) VALUES (${profileId}, ${ids['linenDress']})`,
    );
    const page = await search('linen', undefined, token);
    expect(page.items.find((c) => c.id === ids['linenDress'])?.saved).toBe(true);
    expect(page.items.find((c) => c.id === ids['linenShirt'])?.saved).toBe(false);
  });

  it('treats quotes and tsquery syntax as plain text', async () => {
    expect(await found("linen' & !(")).toEqual(sorted('linenShirt', 'linenDress'));
    expect(await found("'\\:*|")).toEqual([]);
    expect(wordsQuery(['lin'], new Map([['lin', ['lin', "it's", 'back\\slash']]]))).toBe(
      "('lin':* | 'it''s' | 'back\\\\slash')",
    );
  });

  it('refuses an empty search, a bad cursor and too long a text', async () => {
    expect((await get('/v1/search/looks?q=%20')).statusCode).toBe(400);
    expect((await get('/v1/search/looks?q=linen&cursor=nope')).statusCode).toBe(400);
    expect((await get(`/v1/search/looks?q=${'a'.repeat(101)}`)).statusCode).toBe(400);
  });
});

describe('suggestions', () => {
  it('complete the last word, most common first, keeping earlier words', async () => {
    expect((await suggestions('lin')).terms).toEqual(['linen']);
    const s = (await suggestions('s')).terms;
    expect(s.slice(0, 2)).toEqual(['striped', 'sweater']);
    expect(s).toEqual(expect.arrayContaining(['summer', 'sommar', 'shirt', 'sandals']));
    expect((await suggestions('white lea')).terms).toEqual(['white leather']);
  });

  it('turn a typo into the real word, and never suggest small words', async () => {
    expect((await suggestions('linnen')).terms).toContain('linen');
    expect((await suggestions('wi')).terms).toEqual(['wide']);
    expect((await suggestions('som')).terms).toEqual(['sommar']);
  });

  it('find people who post, by handle or name, but not deleted or empty profiles', async () => {
    const anna = await createAuthor(ctx.db, 'anna.styles');
    await ctx.db.execute(sql`UPDATE profiles SET display_name = 'Anna Berg' WHERE id = ${anna}`);
    await createLook(ctx.db, { authorId: anna, caption: 'Navy blazer' });
    await createAuthor(ctx.db, 'anna.nolooks');
    const closed = await createAuthor(ctx.db, 'anna.closed');
    await createLook(ctx.db, { authorId: closed, caption: 'Red scarf' });
    await ctx.db.execute(sql`UPDATE profiles SET deleted_at = now() WHERE id = ${closed}`);

    for (const q of ['anna', '@Anna', 'berg', 'anna.styels']) {
      const { profiles } = await suggestions(q);
      expect(profiles.map((p) => p.handle)).toEqual(['anna.styles']);
    }
    expect((await suggestions('anna')).profiles[0]).toEqual({
      id: anna,
      handle: 'anna.styles',
      displayName: 'Anna Berg',
      avatar: null,
      isVerified: false,
    });
    // One letter is too little to look for people (and a LIKE wildcard is just a character).
    expect((await suggestions('a')).profiles).toEqual([]);
    expect((await suggestions('a_')).profiles).toEqual([]);
  });
});

describe('popular tags and the vocabulary', () => {
  it('lists the tags most looks carry, most first', async () => {
    const res = await get('/v1/search/popular');
    expect(res.statusCode).toBe(200);
    expect(popularTagsSchema.parse(res.json()).tags).toEqual([
      'summer',
      'autumn',
      'date',
      'edgy',
      'minimal',
      'romantic',
    ]);
  });

  it('follows the looks: words of a hidden look go, and nothing changes on a rerun', async () => {
    await refreshSearchTerms(ctx.db); // Takes in the looks added by the tests above.
    expect(await refreshSearchTerms(ctx.db)).toEqual({ changed: 0, removed: 0 });
    const words = async () => {
      const { rows } = await ctx.db.execute<{ term: string; lexeme: string; look_count: number }>(
        sql`SELECT term, lexeme, look_count FROM search_terms
             WHERE term IN ('loafers', 'sommar', 'with', 'a') ORDER BY term`,
      );
      return rows;
    };
    expect(await words()).toEqual([
      { term: 'loafers', lexeme: 'loafers', look_count: 1 },
      { term: 'sommar', lexeme: 'summer', look_count: 2 },
    ]);
    await ctx.db.execute(sql`UPDATE looks SET status = 'hidden' WHERE id = ${ids['linenShirt']}`);
    expect((await refreshSearchTerms(ctx.db)).removed).toBeGreaterThan(0);
    expect(await words()).toEqual([{ term: 'sommar', lexeme: 'summer', look_count: 1 }]);
    await ctx.db.execute(
      sql`UPDATE looks SET status = 'published' WHERE id = ${ids['linenShirt']}`,
    );
    await refreshSearchTerms(ctx.db);
  });
});
