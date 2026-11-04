// Test helpers for feeds: authors, looks with ready cover photos, logins and the rule checker.
import { type Db, lookMedia, looks, media, profiles, sql } from '@outfitly/db';
import { lookSlug, type Occasion, type Season, type Style } from '@outfitly/shared';
import { type Candidate, FEED_RULES, similarityKey } from '../src/feed/arrange.ts';
import { signToken } from './helpers.ts';

/** Small deterministic random numbers (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every diversity-rule break in a feed, as readable strings (empty when the feed is fine). */
export function diversityViolations(feed: readonly Candidate[]): string[] {
  const problems: string[] = [];
  feed.forEach((card, i) => {
    if (i > 0 && feed[i - 1]?.authorId === card.authorId) {
      problems.push(`same author at ${String(i - 1)} and ${String(i)}`);
    }
    const window = feed.slice(Math.max(0, i - FEED_RULES.similarWindow + 1), i + 1);
    const similar = window.filter((c) => c.similarityKey && c.similarityKey === card.similarityKey);
    if (similar.length > FEED_RULES.maxSimilar) {
      problems.push(`${String(similar.length)} similar looks in the 6 ending at ${String(i)}`);
    }
  });
  return problems;
}

export async function createAuthor(db: Db, handle: string): Promise<string> {
  const [row] = await db
    .insert(profiles)
    .values({ handle, accountType: 'creator' })
    .returning({ id: profiles.id });
  if (!row) throw new Error('profile insert returned no row');
  return row.id;
}

/** A Supabase login (auth.users row) and its token; `POST /v1/session` gives it a profile. */
export async function createLogin(db: Db): Promise<{ userId: string; token: string }> {
  const userId = crypto.randomUUID();
  await db.execute(sql`INSERT INTO auth.users (id, is_anonymous) VALUES (${userId}, false)`);
  return { userId, token: await signToken({ sub: userId }) };
}

export interface LookSpec {
  authorId: string;
  occasions?: Occasion[];
  seasons?: Season[];
  styles?: Style[];
  /** Hours ago it went public (default 10 days). */
  hoursAgo?: number;
  status?: 'draft' | 'published' | 'hidden';
  popularity?: number;
  /** The cover photo's state (default ready). */
  cover?: 'ready' | 'processing';
}

/** Inserts looks, each with its own cover photo, in bulk. Returns their ids in order. */
export async function createLooks(db: Db, specs: readonly LookSpec[]): Promise<string[]> {
  const rows = specs.map((spec) => {
    const lookId = crypto.randomUUID();
    const mediaId = crypto.randomUUID();
    const status = spec.status ?? 'published';
    const ready = (spec.cover ?? 'ready') === 'ready';
    return {
      look: {
        id: lookId,
        authorProfileId: spec.authorId,
        slug: lookSlug(null, lookId),
        status,
        occasionTags: spec.occasions ?? [],
        seasonTags: spec.seasons ?? [],
        styleTags: spec.styles ?? [],
        popularityScore: spec.popularity ?? 0.05,
        publishedAt:
          status === 'draft'
            ? null
            : new Date(Date.now() - (spec.hoursAgo ?? 240) * 60 * 60 * 1000),
      },
      media: {
        id: mediaId,
        ownerProfileId: spec.authorId,
        status: ready ? ('ready' as const) : ('processing' as const),
        originalKey: `originals/${mediaId}`,
        key1080: ready ? `m/${mediaId}/1080.webp` : null,
        key600: ready ? `m/${mediaId}/600.webp` : null,
        key300: ready ? `m/${mediaId}/300.webp` : null,
        width: ready ? 1080 : null,
        height: ready ? 1440 : null,
        thumbhash: ready ? 'k0oGLQaSVsN0BVhn2oq2Z5SQUQcZ' : null,
        dominantColor: ready ? '#a08870' : null,
      },
      link: { lookId, mediaId, position: 0 },
    };
  });
  for (let from = 0; from < rows.length; from += 500) {
    const batch = rows.slice(from, from + 500);
    await db.insert(media).values(batch.map((r) => r.media));
    await db.insert(looks).values(batch.map((r) => r.look));
    await db.insert(lookMedia).values(batch.map((r) => r.link));
  }
  return rows.map((r) => r.look.id);
}

export async function createLook(db: Db, spec: LookSpec): Promise<string> {
  const [id] = await createLooks(db, [spec]);
  if (!id) throw new Error('look insert returned no id');
  return id;
}

/** Author and similarity key per look, for checking the diversity rules on a feed. */
export async function candidatesFor(db: Db, ids: readonly string[]): Promise<Candidate[]> {
  const rows = await db
    .select({
      id: looks.id,
      authorId: looks.authorProfileId,
      occasions: looks.occasionTags,
      seasons: looks.seasonTags,
    })
    .from(looks);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) throw new Error(`unknown look ${id}`);
    return { id, authorId: row.authorId, similarityKey: similarityKey(row.occasions, row.seasons) };
  });
}
