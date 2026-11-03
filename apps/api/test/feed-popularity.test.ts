import { eq, events, feedSnapshots, inArray, looks, saves, sql } from '@outfitly/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteOldFeedSnapshots, POPULARITY, recomputePopularity } from '../src/feed/popularity.ts';
import { createAuthor, createLook } from './feed-fixtures.ts';
import { createTestContext, type TestContext } from './helpers.ts';

let ctx: TestContext;
let author: string;
const savers: string[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
  author = await createAuthor(ctx.db, 'pop.author');
  for (let i = 0; i < 5; i++) savers.push(await createAuthor(ctx.db, `pop.saver.${String(i)}`));
});

afterAll(async () => {
  await ctx.close();
});

/** `count` impressions of a look, `daysAgo` days ago. */
async function views(lookId: string, count: number, daysAgo = 0) {
  await ctx.db.insert(events).values(
    Array.from({ length: count }, () => ({
      name: 'impression',
      lookId,
      createdAt: sql`now() - make_interval(days => ${daysAgo})`,
    })),
  );
}

/** Saves of a look by the first `count` savers, `daysAgo` days ago. */
async function savesOf(lookId: string, count: number, daysAgo = 0) {
  await ctx.db.insert(saves).values(
    savers.slice(0, count).map((profileId) => ({
      profileId,
      lookId,
      createdAt: sql`now() - make_interval(days => ${daysAgo})`,
    })),
  );
}

async function scores(ids: string[]): Promise<Map<string, number>> {
  const rows = await ctx.db
    .select({ id: looks.id, score: looks.popularityScore })
    .from(looks)
    .where(inArray(looks.id, ids));
  return new Map(rows.map((r) => [r.id, r.score]));
}

describe('popularity score', () => {
  it('ranks looks by saves per view, new looks in between', async () => {
    const loved = await createLook(ctx.db, { authorId: author, popularity: 0 });
    const untouched = await createLook(ctx.db, { authorId: author, popularity: 0 });
    const ignored = await createLook(ctx.db, { authorId: author, popularity: 0 });
    await views(loved, 10);
    await savesOf(loved, 5);
    await views(ignored, 100);
    await savesOf(ignored, 1);

    await recomputePopularity(ctx.db);
    const s = await scores([loved, untouched, ignored]);
    expect(s.get(loved)).toBeCloseTo(6 / 30, 3);
    expect(s.get(untouched)).toBeCloseTo(1 / 20, 4);
    expect(s.get(ignored)).toBeCloseTo(2 / 120, 3);
  });

  it('counts recent saves more than old ones, and ignores undone saves', async () => {
    const recent = await createLook(ctx.db, { authorId: author });
    const old = await createLook(ctx.db, { authorId: author });
    const undone = await createLook(ctx.db, { authorId: author });
    await savesOf(recent, 3, 0);
    await savesOf(old, 3, 20);
    await savesOf(undone, 3, 0);
    await ctx.db
      .update(saves)
      .set({ deletedAt: sql`now()` })
      .where(eq(saves.lookId, undone));

    await recomputePopularity(ctx.db);
    const s = await scores([recent, old, undone]);
    expect(s.get(recent)).toBeGreaterThan(s.get(old) ?? Infinity);
    expect(s.get(old)).toBeGreaterThan(s.get(undone) ?? Infinity);
    expect(s.get(undone)).toBeCloseTo(1 / 20, 4);
  });

  it('leaves unchanged scores and updated_at alone', async () => {
    const look = await createLook(ctx.db, { authorId: author });
    await recomputePopularity(ctx.db);
    const [before] = await ctx.db
      .select({ updatedAt: looks.updatedAt })
      .from(looks)
      .where(eq(looks.id, look));
    await ctx.db.execute(sql`SELECT pg_sleep(0.01)`);
    // Nothing happened since, so nothing is written again.
    expect(await recomputePopularity(ctx.db)).toBe(0);
    await views(look, 50);
    expect(await recomputePopularity(ctx.db)).toBeGreaterThan(0);
    const [after] = await ctx.db
      .select({ updatedAt: looks.updatedAt })
      .from(looks)
      .where(eq(looks.id, look));
    expect(after?.updatedAt).toEqual(before?.updatedAt);
  });

  it('counts viewers, not impressions: one per person per look per day', async () => {
    const look = await createLook(ctx.db, { authorId: author, popularity: 0 });
    const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
    const seenBy = (sessionId: string, daysAgo: number) => ({
      name: 'impression',
      lookId: look,
      sessionId,
      createdAt: sql`date_trunc('day', now()) - make_interval(days => ${daysAgo}) + interval '1 hour'`,
    });
    // a: 5 times today and once 2 days ago (2 viewer-days); b: 3 times today (1).
    await ctx.db
      .insert(events)
      .values([
        ...Array.from({ length: 5 }, () => seenBy(a, 0)),
        seenBy(a, 2),
        ...Array.from({ length: 3 }, () => seenBy(b, 0)),
      ]);
    await recomputePopularity(ctx.db);
    // 3 viewer-days, each decayed a little (9 impressions would give ~8; 2 people or 2 days ~2).
    const score = (await scores([look])).get(look) ?? 0;
    const viewers = 1 / score - POPULARITY.priorViews;
    expect(viewers).toBeGreaterThan(2.4);
    expect(viewers).toBeLessThan(3.1);
  });

  it('only scores published looks', async () => {
    const draft = await createLook(ctx.db, { authorId: author, status: 'draft', popularity: 0 });
    await recomputePopularity(ctx.db);
    expect((await scores([draft])).get(draft)).toBe(0);
  });
});

describe('feed list cleanup', () => {
  it('deletes For You lists older than a day and keeps newer ones', async () => {
    const [old] = await ctx.db
      .insert(feedSnapshots)
      .values({ lookIds: [], createdAt: sql`now() - interval '25 hours'` })
      .returning({ id: feedSnapshots.id });
    const [fresh] = await ctx.db
      .insert(feedSnapshots)
      .values({ lookIds: [], createdAt: sql`now() - interval '23 hours'` })
      .returning({ id: feedSnapshots.id });
    expect(await deleteOldFeedSnapshots(ctx.db)).toBe(1);
    const left = await ctx.db.select({ id: feedSnapshots.id }).from(feedSnapshots);
    expect(left.map((r) => r.id)).toEqual([fresh?.id]);
    expect(left.map((r) => r.id)).not.toContain(old?.id);
  });
});
