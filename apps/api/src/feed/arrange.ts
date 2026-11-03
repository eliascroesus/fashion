// Pure feed logic (no database): mixing pools and the diversity rules.

export const FEED_RULES = {
  /** The fresh pool: published within this many hours. */
  freshHours: 72,
  /** Looks the viewer saw within this many days are left out. */
  seenDays: 7,
  /** Looks in one For You list (20 pages). */
  snapshotSize: 400,
  /** Candidates fetched per pool when building a list. */
  poolLimit: 400,
  /** The following pool takes at most this many newest looks per followed person. */
  followingPerAuthor: 50,
  /** At most `maxSimilar` looks with the same similarity key in any `similarWindow` in a row. */
  similarWindow: 6,
  maxSimilar: 2,
  /** Popular and taste candidates are reordered by score × (1 − jitter·random). */
  jitter: 0.25,
  /**
   * Logged-out visitors share lists: page 1 picks one of up to this many made
   * in the last `sharedListMinutes`, so strangers can't fill the database.
   */
  sharedLists: 8,
  sharedListMinutes: 15,
  /** A profile keeps its newest few lists (one per refresh); older ones go. */
  listsPerProfile: 5,
  /** Looks similar to the profile's newest this-many "see less like this" go to the back. */
  seeLessRemembered: 50,
} as const;

/** Where a For You candidate came from. */
export const POOLS = ['following', 'taste', 'fresh', 'popular'] as const;
export type Pool = (typeof POOLS)[number];

/** Share of each pool in the mix (e.g. 3 of every 10 from people you follow). */
export const POOL_WEIGHTS: Record<Pool, number> = { following: 3, taste: 3, fresh: 2, popular: 2 };

export interface Candidate {
  id: string;
  authorId: string;
  /** Looks with the same key count as similar; null means unknown (never similar). */
  similarityKey: string | null;
}

/**
 * Until AI fingerprints arrive (Phase 3), two looks are "similar" when they
 * carry exactly the same occasion and season tags.
 */
export function similarityKey(
  occasions: readonly string[],
  seasons: readonly string[],
): string | null {
  if (occasions.length === 0 && seasons.length === 0) return null;
  return `${[...occasions].sort().join(',')}|${[...seasons].sort().join(',')}`;
}

/**
 * "See less like this": looks similar to ones the viewer marked move to the
 * back of their pool (order otherwise kept), so they come up late or not at all.
 */
export function demoteSimilar<T extends Pick<Candidate, 'similarityKey'>>(
  items: readonly T[],
  lessLike: ReadonlySet<string>,
): T[] {
  if (lessLike.size === 0) return [...items];
  const similar = (c: T) => c.similarityKey !== null && lessLike.has(c.similarityKey);
  return [...items.filter((c) => !similar(c)), ...items.filter(similar)];
}

/**
 * Reorders by score with a little randomness, so each new list (pull to
 * refresh) differs a bit while high scorers stay near the top. Ties keep
 * their order.
 */
export function jitter<T extends { score: number }>(
  items: readonly T[],
  random: () => number,
  amount: number = FEED_RULES.jitter,
): T[] {
  return items
    .map((item) => ({ item, key: item.score * (1 - amount * random()) }))
    .sort((a, b) => b.key - a.key)
    .map(({ item }) => item);
}

/**
 * Mixes the pools by weight (smooth weighted round-robin: with weights 3:2 the
 * order is A B A B A, not A A A B B). Each pool keeps its own order; a look in
 * several pools appears once, where it comes up first. Empty pools are skipped.
 */
export function interleave<T extends { id: string }>(
  pools: Partial<Record<Pool, readonly T[]>>,
  weights: Record<Pool, number> = POOL_WEIGHTS,
): T[] {
  const queues = POOLS.flatMap((pool) => {
    const items = pools[pool] ?? [];
    return items.length > 0 && weights[pool] > 0
      ? [{ items, next: 0, weight: weights[pool], current: 0 }]
      : [];
  });
  const taken = new Set<string>();
  const out: T[] = [];
  while (queues.length > 0) {
    const total = queues.reduce((sum, q) => sum + q.weight, 0);
    let best = 0;
    queues.forEach((q, i) => {
      q.current += q.weight;
      if (q.current > (queues[best]?.current ?? -Infinity)) best = i;
    });
    const queue = queues[best];
    if (!queue) break;
    queue.current -= total;
    while (queue.next < queue.items.length && taken.has(queue.items[queue.next]?.id ?? '')) {
      queue.next++;
    }
    const item = queue.items[queue.next];
    if (item) {
      queue.next++;
      taken.add(item.id);
      out.push(item);
    }
    if (queue.next >= queue.items.length) queues.splice(best, 1);
  }
  return out;
}

/**
 * Applies the diversity rules, keeping the given order wherever it can: each
 * position takes the earliest remaining look that (1) isn't by the previous
 * look's author and (2) wouldn't make 3 similar looks within 6. Looks that
 * don't fit yet wait for a later position. When one author has more looks
 * left than everyone else together and the others can't fill the remaining
 * slots, theirs go first whenever allowed, so the end of a small catalogue
 * doesn't bunch them up. When nothing fits (e.g.
 * only one person has posted) the feed still goes on: the similarity rule
 * gives way first, then the author rule.
 */
export function applyDiversity<T extends Candidate>(
  candidates: readonly T[],
  limit: number = Infinity,
): T[] {
  const { similarWindow, maxSimilar } = FEED_RULES;
  const remaining = [...candidates];
  const left = new Map<string, number>();
  for (const c of remaining) left.set(c.authorId, (left.get(c.authorId) ?? 0) + 1);
  const out: T[] = [];
  while (out.length < limit && remaining.length > 0) {
    const previous = out.at(-1);
    const recent = out.slice(-(similarWindow - 1));
    const tooSimilar = (c: T) =>
      c.similarityKey !== null &&
      recent.filter((r) => r.similarityKey === c.similarityKey).length >= maxSimilar;

    let busiest: string | undefined;
    let most = 0;
    for (const [author, count] of left) {
      if (count > most) [busiest, most] = [author, count];
    }
    // Only when the other authors can't fill the slots left anyway.
    const others = remaining.length - most;
    const allowed =
      busiest !== previous?.authorId && most > others && others < limit - out.length
        ? (c: T) => c.authorId === busiest
        : (c: T) => c.authorId !== previous?.authorId;

    let index = remaining.findIndex((c) => allowed(c) && !tooSimilar(c));
    if (index < 0) index = remaining.findIndex(allowed);
    if (index < 0) index = 0;
    const [next] = remaining.splice(index, 1);
    if (!next) break;
    out.push(next);
    left.set(next.authorId, (left.get(next.authorId) ?? 1) - 1);
  }
  return out;
}
