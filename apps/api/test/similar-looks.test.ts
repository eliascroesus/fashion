import { and, eq, lookLists, sql, swipes } from '@outfitly/db';
import {
  FEED_PAGE_SIZE,
  type FeedPage,
  feedPageSchema,
  FINGERPRINT_DIMENSIONS,
  MAX_SIMILAR_LOOKS,
  meSchema,
} from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  candidatesFor,
  createAuthor,
  createLogin,
  createLook,
  createLooks,
  diversityViolations,
} from './feed-fixtures.ts';
import { deleteOldLookLists, LIST_RULES } from '../src/feed/look-lists.ts';
import { buildTestApp, createTestContext, type TestContext } from './helpers.ts';
import { angled, dropFingerprintIndexes } from './vectors.ts';

const MODEL = 'Marqo/marqo-fashionSigLIP@c56244c';

let ctx: TestContext;
let app: FastifyInstance;

beforeAll(async () => {
  ctx = await createTestContext();
  await dropFingerprintIndexes(ctx.db);
  app = await buildTestApp(ctx);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await ctx.close();
});

/**
 * Each test gets its own two axes, so other tests' looks (at right angles,
 * cosine 0) always come after its own.
 */
let nextAxis = 0;
function axes(): (degrees: number) => number[] {
  const from = nextAxis;
  nextAxis += 2;
  return (degrees) => angled(degrees, from, from + 1);
}

/** Only these looks, in the order given (other tests' looks are in the same database). */
const only = (shown: readonly string[], mine: readonly (string | undefined)[]) =>
  shown.filter((id) => mine.includes(id));

async function fingerprintCover(lookId: string, vector: number[], model = MODEL): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE media SET embedding = ${`[${vector.join(',')}]`}::extensions.halfvec, embedding_model = ${model}
     WHERE id = (SELECT media_id FROM look_media WHERE look_id = ${lookId} AND position = 0)`);
}

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

async function similar(lookId: string, cursor?: string | null, token?: string): Promise<FeedPage> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  const res = await app.inject({
    method: 'GET',
    url: `/v1/looks/${lookId}/similar${query}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  expect(res.statusCode, res.body).toBe(200);
  return feedPageSchema.parse(res.json());
}

/** Every page, following the cursors. */
async function allPages(lookId: string, token?: string): Promise<string[]> {
  const pages = [await similar(lookId, null, token)];
  while (pages.at(-1)?.nextCursor) {
    pages.push(await similar(lookId, pages.at(-1)?.nextCursor, token));
    if (pages.length > 30) throw new Error('never ends');
  }
  return pages.flatMap((p) => p.items.map((c) => c.id));
}

describe('GET /v1/looks/:lookId/similar', () => {
  it('puts the looks whose covers look most alike first, never the look itself or unshowable ones', async () => {
    const author = await createAuthor(ctx.db, 'near.one');
    const other = await createAuthor(ctx.db, 'near.two');
    const at = axes();
    const base = await createLook(ctx.db, { authorId: author });
    await fingerprintCover(base, at(0));
    // Alternating authors, so the diversity rules keep the order as it is.
    const [far, near, middle, hidden, draft, unready, otherModel] = await createLooks(ctx.db, [
      { authorId: other },
      { authorId: other },
      { authorId: author },
      { authorId: other, status: 'hidden' },
      { authorId: other, status: 'draft' },
      { authorId: other, cover: 'processing' },
      { authorId: author },
    ]);
    await fingerprintCover(far ?? '', at(60));
    await fingerprintCover(near ?? '', at(10));
    await fingerprintCover(middle ?? '', at(30));
    for (const id of [hidden, draft, unready]) await fingerprintCover(id ?? '', at(1));
    // Same direction, other model: fingerprints of two models can't be compared.
    await fingerprintCover(otherModel ?? '', at(0), 'some-other-model');

    const ids = (await similar(base)).items.map((c) => c.id);
    expect(ids.slice(0, 3)).toEqual([near, middle, far]);
    expect(ids).not.toContain(base);
    for (const id of [hidden, draft, unready]) expect(ids).not.toContain(id);
    // It still comes, with the looks the fingerprints didn't rank (by tags, after them).
    expect(ids.indexOf(otherModel ?? '')).toBeGreaterThan(2);
  });

  it('leaves out the viewer’s own looks, "see less" ones and looks seen today; seen this week go last', async () => {
    const { token, profileId } = await viewer();
    const author = await createAuthor(ctx.db, 'near.rules');
    const at = axes();
    const base = await createLook(ctx.db, { authorId: author });
    await fingerprintCover(base, at(0));
    const [own, seeLess, seenToday, seenLastWeek, plain, plainFar] = await createLooks(ctx.db, [
      { authorId: profileId },
      { authorId: author },
      { authorId: author },
      { authorId: author },
      { authorId: author },
      { authorId: author },
    ]);
    const angles = [5, 6, 7, 8, 20, 40];
    for (const [i, id] of [own, seeLess, seenToday, seenLastWeek, plain, plainFar].entries()) {
      await fingerprintCover(id ?? '', at(angles[i] ?? 0));
    }
    await ctx.db.insert(swipes).values({ profileId, lookId: seeLess ?? '', kind: 'see_less' });
    await ctx.db.execute(sql`
      INSERT INTO seen (profile_id, look_id, last_seen_at) VALUES
        (${profileId}, ${seenToday}, now() - interval '2 hours'),
        (${profileId}, ${seenLastWeek}, now() - interval '3 days')`);

    const mine = [own, seeLess, seenToday, seenLastWeek, plain, plainFar];
    const ids = (await similar(base, null, token)).items.map((c) => c.id);
    expect(only(ids, mine)).toEqual([plain, plainFar, seenLastWeek]);
    // Logged out, nothing is left out but hidden looks.
    const anyone = (await similar(base)).items.map((c) => c.id);
    expect(only(anyone, mine)).toEqual(mine);
  });

  it('keeps the diversity rules: never the same poster twice in a row while others are left', async () => {
    const posters = await Promise.all(
      ['near.a', 'near.b', 'near.c'].map((handle) => createAuthor(ctx.db, handle)),
    );
    const at = axes();
    const base = await createLook(ctx.db, { authorId: posters[0] ?? '' });
    await fingerprintCover(base, at(0));
    // The nearest 12 are all by one poster (no tags, so only the poster rule applies).
    const ids = await createLooks(
      ctx.db,
      Array.from({ length: 24 }, (_, i) => ({ authorId: posters[i < 12 ? 0 : 1 + (i % 2)] ?? '' })),
    );
    for (const [i, id] of ids.entries()) await fingerprintCover(id, at(1 + i));
    const shown = (await similar(base)).items.map((c) => c.id);
    expect(shown).toHaveLength(FEED_PAGE_SIZE);
    expect(only(shown, ids)).toEqual(shown);
    expect(diversityViolations(await candidatesFor(ctx.db, shown))).toEqual([]);
  });

  it(`pages 20 at a time without repeats or gaps, up to ${String(MAX_SIMILAR_LOOKS)}`, async () => {
    const author = await createAuthor(ctx.db, 'near.many');
    const other = await createAuthor(ctx.db, 'near.many.two');
    const at = axes();
    const from = nextAxis - 2;
    const base = await createLook(ctx.db, { authorId: author });
    await fingerprintCover(base, at(0));
    const ids = await createLooks(
      ctx.db,
      Array.from({ length: MAX_SIMILAR_LOOKS + 30 }, (_, i) => ({
        authorId: i % 2 === 0 ? other : author,
      })),
    );
    // Angles from 0.1° to 43°: every look a different distance.
    await ctx.db.execute(sql`
      UPDATE media m SET embedding_model = ${MODEL},
             embedding = (SELECT array_agg(CASE WHEN k = ${from + 1} THEN cos(radians(0.1 * x.n))
                                                WHEN k = ${from + 2} THEN sin(radians(0.1 * x.n))
                                                ELSE 0 END ORDER BY k)
                            FROM generate_series(1, ${FINGERPRINT_DIMENSIONS}::int) k)::extensions.halfvec
        FROM (SELECT lm.media_id, row_number() OVER (ORDER BY u.ord) AS n
                FROM unnest(${`{${ids.join(',')}}`}::uuid[]) WITH ORDINALITY u(id, ord)
                JOIN look_media lm ON lm.look_id = u.id AND lm.position = 0) x
       WHERE m.id = x.media_id`);
    const all = await allPages(base);
    expect(all).toHaveLength(MAX_SIMILAR_LOOKS);
    expect(new Set(all).size).toBe(all.length);
    // Exactly the nearest MAX_SIMILAR_LOOKS (the posters alternate, so the order stays too).
    expect(all).toEqual(ids.slice(0, MAX_SIMILAR_LOOKS));
  });

  it('reuses a logged-out list for a while, and starts over when a cursor’s list is gone', async () => {
    const author = await createAuthor(ctx.db, 'near.reuse');
    const at = axes();
    const base = await createLook(ctx.db, { authorId: author });
    await fingerprintCover(base, at(0));
    const ids = await createLooks(
      ctx.db,
      Array.from({ length: 30 }, () => ({ authorId: author })),
    );
    for (const [i, id] of ids.entries()) await fingerprintCover(id, at(1 + i));
    const listsOf = () =>
      ctx.db.$count(lookLists, and(eq(lookLists.kind, 'similar'), eq(lookLists.key, base)));

    const first = await similar(base);
    const again = await similar(base);
    expect(again.items.map((c) => c.id)).toEqual(first.items.map((c) => c.id));
    expect(await listsOf()).toBe(1);

    // The list was cleaned up meanwhile: the cursor starts a new list instead of failing.
    await ctx.db.delete(lookLists).where(eq(lookLists.key, base));
    const restarted = await similar(base, first.nextCursor);
    expect(restarted.items.map((c) => c.id)).toEqual(first.items.map((c) => c.id));
    // Another look's cursor never pages this look's list.
    const other = await createLook(ctx.db, { authorId: author });
    await fingerprintCover(other, axes()(0));
    const foreign = await similar(other, first.nextCursor);
    expect(foreign.items.map((c) => c.id)).not.toContain(other);
    expect(foreign.items[0]?.id).not.toBe(restarted.items[0]?.id);
  });

  it('gives a look without a fingerprint the looks sharing its tags, shared only for a few minutes', async () => {
    const author = await createAuthor(ctx.db, 'near.tags');
    const other = await createAuthor(ctx.db, 'near.tags.two');
    const base = await createLook(ctx.db, {
      authorId: author,
      occasions: ['wedding'],
      seasons: ['spring'],
    });
    const [both, one] = await createLooks(ctx.db, [
      { authorId: other, occasions: ['wedding'], seasons: ['spring'] },
      { authorId: author, occasions: ['wedding'], seasons: ['autumn'] },
    ]);
    const ids = (await similar(base)).items.map((c) => c.id);
    expect(ids.slice(0, 2)).toEqual([both, one]);
    const lists = () =>
      ctx.db
        .select({ complete: lookLists.complete })
        .from(lookLists)
        .where(eq(lookLists.key, base));
    // The next visitor gets the same tags-only list for a few minutes…
    await similar(base);
    expect(await lists()).toEqual([{ complete: false }]);
    // …then a new one (by then the look may have its fingerprint).
    await ctx.db.execute(sql`UPDATE look_lists SET created_at = now() - make_interval(
                               mins => ${LIST_RULES.tagsOnlyReuseMinutes + 1}) WHERE key = ${base}`);
    await similar(base);
    expect(await lists()).toEqual([{ complete: false }, { complete: false }]);
  });

  it(`keeps a profile’s newest ${String(LIST_RULES.perProfile)} lists, and the hourly cleanup removes lists older than a day`, async () => {
    const { token, profileId } = await viewer();
    const author = await createAuthor(ctx.db, 'near.lists');
    const looksOpened = await createLooks(
      ctx.db,
      Array.from({ length: LIST_RULES.perProfile + 2 }, () => ({ authorId: author })),
    );
    for (const id of looksOpened) await similar(id, null, token);
    const own = () =>
      ctx.db.$count(
        lookLists,
        and(eq(lookLists.kind, 'similar'), eq(lookLists.profileId, profileId)),
      );
    expect(await own()).toBe(LIST_RULES.perProfile);

    await ctx.db.execute(sql`UPDATE look_lists SET created_at = now() - interval '25 hours'
                              WHERE profile_id = ${profileId}`);
    expect(await deleteOldLookLists(ctx.db)).toBeGreaterThanOrEqual(LIST_RULES.perProfile);
    expect(await own()).toBe(0);
  });

  it('starts over for a cursor it can’t read, and is 404 for a look that cannot be shown', async () => {
    const author = await createAuthor(ctx.db, 'near.bad');
    const base = await createLook(ctx.db, { authorId: author });
    const hidden = await createLook(ctx.db, { authorId: author, status: 'hidden' });
    // E.g. a cursor an older app kept: page 1 again rather than an error.
    const restart = await similar(base, 'nope');
    expect(restart.items.map((c) => c.id)).toEqual((await similar(base)).items.map((c) => c.id));
    const gone = await app.inject({ method: 'GET', url: `/v1/looks/${hidden}/similar` });
    expect(gone.statusCode).toBe(404);
  });

  it('never pages another viewer’s list (or a logged-out one) for a logged-in viewer', async () => {
    const a = await viewer();
    const b = await viewer();
    const author = await createAuthor(ctx.db, 'near.owner');
    const at = axes();
    const base = await createLook(ctx.db, { authorId: author });
    await fingerprintCover(base, at(0));
    const theirs = await createLooks(
      ctx.db,
      Array.from({ length: 25 }, () => ({ authorId: author })),
    );
    for (const [i, id] of theirs.entries()) await fingerprintCover(id, at(2 + i));
    // B's own look, nearest of all: in A's and the logged-out lists, never in B's.
    const own = await createLook(ctx.db, { authorId: b.profileId });
    await fingerprintCover(own, at(1));

    const ofA = await similar(base, null, a.token);
    const loggedOut = await similar(base);
    expect(ofA.items[0]?.id).toBe(own);
    expect(loggedOut.items[0]?.id).toBe(own);
    for (const cursor of [ofA.nextCursor, loggedOut.nextCursor]) {
      const page = await similar(base, cursor, b.token);
      // B gets their own list from the top instead.
      expect(page.items.map((c) => c.id)).not.toContain(own);
      expect(page.items[0]?.id).toBe(theirs[0]);
    }
  });

  it('skips looks hidden since the list was made, and still fills the page', async () => {
    const author = await createAuthor(ctx.db, 'near.hidden');
    const other = await createAuthor(ctx.db, 'near.hidden.two');
    const at = axes();
    const base = await createLook(ctx.db, { authorId: author });
    await fingerprintCover(base, at(0));
    const ids = await createLooks(
      ctx.db,
      Array.from({ length: 45 }, (_, i) => ({ authorId: i % 2 === 0 ? other : author })),
    );
    for (const [i, id] of ids.entries()) await fingerprintCover(id, at(1 + i));
    const first = await similar(base);
    const mine = only(
      first.items.map((c) => c.id),
      ids,
    );
    expect(mine).toEqual(ids.slice(0, FEED_PAGE_SIZE));
    // Three looks of page 2 are hidden after the list was made.
    const gone = ids.slice(FEED_PAGE_SIZE, FEED_PAGE_SIZE + 3);
    await ctx.db.execute(sql`UPDATE looks SET status = 'hidden'
                              WHERE id = ANY(${`{${gone.join(',')}}`}::uuid[])`);
    const second = await similar(base, first.nextCursor);
    expect(second.items).toHaveLength(FEED_PAGE_SIZE);
    expect(
      only(
        second.items.map((c) => c.id),
        ids,
      ),
    ).toEqual(ids.slice(FEED_PAGE_SIZE + 3, 2 * FEED_PAGE_SIZE + 3));
  });
});
