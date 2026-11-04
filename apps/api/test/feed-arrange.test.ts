import { describe, expect, it } from 'vitest';
import {
  applyDiversity,
  type Candidate,
  demoteSimilar,
  interleave,
  jitter,
  similarityKey,
} from '../src/feed/arrange.ts';
import { diversityViolations, seeded } from './feed-fixtures.ts';

function look(id: string, authorId: string, key: string | null = null): Candidate {
  return { id, authorId, similarityKey: key };
}

describe('similarityKey', () => {
  it('is the same for the same tags in any order, and null without tags', () => {
    expect(similarityKey(['work', 'date'], ['autumn'])).toBe(
      similarityKey(['date', 'work'], ['autumn']),
    );
    expect(similarityKey(['work'], ['autumn'])).not.toBe(similarityKey(['work'], ['winter']));
    expect(similarityKey([], [])).toBeNull();
  });
});

describe('demoteSimilar', () => {
  it('moves looks similar to "see less" ones to the back, keeping the order otherwise', () => {
    const pool = [
      look('a', 'x', 'k1'),
      look('b', 'x', 'k2'),
      look('c', 'x', null),
      look('d', 'x', 'k1'),
    ];
    expect(demoteSimilar(pool, new Set(['k1'])).map((c) => c.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(demoteSimilar(pool, new Set()).map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('interleave', () => {
  it('mixes pools by weight, smoothly', () => {
    const pool = (name: string) =>
      Array.from({ length: 10 }, (_, i) => ({ id: `${name}${String(i)}` }));
    const mixed = interleave({ following: pool('f'), fresh: pool('n') });
    // Weights 3 (following) : 2 (fresh), spread out rather than in runs.
    expect(mixed.slice(0, 5).map((m) => m.id[0])).toEqual(['f', 'n', 'f', 'n', 'f']);
    const firstTen = mixed.slice(0, 10).map((m) => m.id[0]);
    expect(firstTen.filter((p) => p === 'f')).toHaveLength(6);
    expect(mixed).toHaveLength(20);
  });

  it('shows a look that is in several pools once, where it comes up first', () => {
    const mixed = interleave(
      {
        following: [{ id: 'a' }, { id: 'b' }],
        taste: [{ id: 'a' }, { id: 'c' }],
        popular: [{ id: 'b' }, { id: 'c' }, { id: 'd' }],
      },
      { following: 3, taste: 3, fresh: 2, popular: 2 },
    );
    expect(mixed.map((m) => m.id)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('gives someone with picked styles (and no follows) 6 of every 10 from their styles', () => {
    const pool = (name: string) =>
      Array.from({ length: 20 }, (_, i) => ({ id: `${name}${String(i)}` }));
    const mixed = interleave({ taste: pool('t'), fresh: pool('n'), popular: pool('p') });
    const firstTwenty = mixed.slice(0, 20).map((m) => m.id[0]);
    expect(firstTwenty.filter((p) => p === 't')).toHaveLength(12);
  });

  it('skips empty pools and keeps each pool in order', () => {
    const mixed = interleave({ following: [], popular: [{ id: 'x' }, { id: 'y' }, { id: 'z' }] });
    expect(mixed.map((m) => m.id)).toEqual(['x', 'y', 'z']);
    expect(interleave({})).toEqual([]);
  });
});

describe('applyDiversity', () => {
  it('never shows the same author twice in a row and at most 2 similar in any 6', () => {
    // Worst-case input: long runs of one author and one style.
    const input: Candidate[] = [];
    for (let a = 0; a < 6; a++) {
      for (let i = 0; i < 20; i++) {
        input.push(look(`${String(a)}-${String(i)}`, `author${String(a)}`, `key${String(i % 4)}`));
      }
    }
    const out = applyDiversity(input);
    expect(diversityViolations(out)).toEqual([]);
    expect(new Set(out.map((c) => c.id)).size).toBe(input.length);
  });

  it('keeps the given order when it already follows the rules', () => {
    const input = [
      look('1', 'a', 'x'),
      look('2', 'b', 'y'),
      look('3', 'a', 'z'),
      look('4', 'c', 'x'),
    ];
    expect(applyDiversity(input)).toEqual(input);
  });

  it('stops at the limit', () => {
    const input = Array.from({ length: 50 }, (_, i) => look(String(i), `a${String(i % 5)}`));
    expect(applyDiversity(input, 20)).toHaveLength(20);
  });

  it('keeps a busy author apart at the end of a small catalogue', () => {
    // 300 looks from authors with 150/60/40/30/20: they can all alternate.
    const counts = [150, 60, 40, 30, 20];
    const input = counts.flatMap((n, a) =>
      Array.from({ length: n }, (_, i) => look(`${String(a)}-${String(i)}`, `author${String(a)}`)),
    );
    const random = seeded(3);
    const shuffled = input
      .map((c) => ({ c, k: random() }))
      .sort((x, y) => x.k - y.k)
      .map(({ c }) => c);
    const out = applyDiversity(shuffled);
    expect(out).toHaveLength(300);
    expect(diversityViolations(out)).toEqual([]);
  });

  it("doesn't let a bulk poster's low-ranked looks jump ahead when others can fill the list", () => {
    const good = Array.from({ length: 780 }, (_, i) =>
      look(`o${String(i)}`, `author${String(i % 40)}`),
    );
    const bulk = Array.from({ length: 820 }, (_, i) => look(`b${String(i)}`, 'bulk'));
    const out = applyDiversity([...good, ...bulk], 400);
    expect(out).toHaveLength(400);
    expect(out.some((c) => c.authorId === 'bulk')).toBe(false);
    expect(diversityViolations(out)).toEqual([]);
  });

  it('still shows everything when only one person has posted', () => {
    const input = Array.from({ length: 5 }, (_, i) => look(String(i), 'solo', 'same'));
    expect(applyDiversity(input).map((c) => c.id)).toEqual(['0', '1', '2', '3', '4']);
  });

  it('gives up the similarity rule before the author rule', () => {
    // Two authors, every look similar: alternating authors is still possible.
    const input = [
      look('a1', 'a', 'k'),
      look('a2', 'a', 'k'),
      look('a3', 'a', 'k'),
      look('b1', 'b', 'k'),
      look('b2', 'b', 'k'),
      look('b3', 'b', 'k'),
    ];
    const out = applyDiversity(input);
    expect(out.map((c) => c.authorId)).toEqual(['a', 'b', 'a', 'b', 'a', 'b']);
  });

  it('treats looks without tags as never similar', () => {
    const input = Array.from({ length: 12 }, (_, i) => look(String(i), `a${String(i % 2)}`, null));
    expect(applyDiversity(input)).toEqual(input);
  });
});

describe('jitter', () => {
  it('is repeatable with the same random numbers and varies with others', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ id: String(i), score: 1 - i / 100 }));
    const once = jitter(items, seeded(1)).map((i) => i.id);
    expect(jitter(items, seeded(1)).map((i) => i.id)).toEqual(once);
    expect(jitter(items, seeded(2)).map((i) => i.id)).not.toEqual(once);
    expect([...once].sort()).toEqual(items.map((i) => i.id).sort());
  });

  it('keeps clear winners near the top', () => {
    const items = [
      { id: 'top', score: 10 },
      ...Array.from({ length: 20 }, (_, i) => ({ id: String(i), score: 1 })),
    ];
    for (let seed = 0; seed < 20; seed++) {
      expect(jitter(items, seeded(seed))[0]?.id).toBe('top');
    }
  });
});
