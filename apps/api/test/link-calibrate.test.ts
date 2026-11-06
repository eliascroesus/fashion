import { runInNewContext, Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  evaluate,
  type LabelledPair,
  parsePairsCsv,
  parseThresholdArgs,
  suggest,
} from '../scripts/link-pairs/calibrate.ts';
import { thresholdsSchema } from '../src/links/check.ts';
import { type PairPageData, renderPairPage } from '../scripts/link-pairs/page.ts';

const G = '00000000-0000-4000-8000-00000000000';
const P = '11111111-1111-4111-8111-11111111111';

function pair(same: boolean, similarity: number, ai?: LabelledPair['ai']): LabelledPair {
  return { garmentId: `${G}1`, productId: `${P}1`, same, similarity, ai };
}

describe('link check calibration', () => {
  // 10 same pairs from 0.75 to 0.95, 50 different from 0.30 to 0.79.
  const same = Array.from({ length: 10 }, (_, i) => pair(true, 0.75 + i * 0.02));
  const different = Array.from({ length: 50 }, (_, i) => pair(false, 0.3 + i * 0.01));
  const pairs = [...same, ...different];

  it('counts wrong items verified, good ones rejected and the share sent to the AI', () => {
    const row = evaluate(pairs, 0.78, 0.6);
    // Different pairs at 0.78 and 0.79 pass the fingerprint alone.
    expect(row.wrongVerified).toBe(2);
    expect(row.wrongVerifiedShare).toBeCloseTo(0.04);
    expect(row.rightRejected).toBe(0);
    // 0.60–0.77: 18 different + 2 same (0.75, 0.77).
    expect(row.toAi).toBe(20);
  });

  it('counts the AI’s answers in between when it was asked', () => {
    const withAi = [pair(false, 0.7, 'yes'), pair(true, 0.7, 'no'), pair(false, 0.7, 'unsure')];
    expect(evaluate(withAi, 0.8, 0.5)).toMatchObject({
      wrongVerified: 1,
      rightRejected: 1,
      toAi: 3,
      toReview: 1,
    });
  });

  it('suggests thresholds that let at most 2% of wrong items through on the fingerprint', () => {
    const suggested = suggest(pairs);
    // 1 of 50 different pairs (2%) is at 0.79: verified from 0.79 lets exactly that one through.
    expect(suggested).toEqual({ verifyAt: 0.79, rejectBelow: 0.75 });
    // No good pair is below 0.75, so nothing good is rejected up to there.
    expect(evaluate(pairs, 0.79, 0.75).wrongVerifiedShare).toBeLessThanOrEqual(0.02);
  });

  it('suggests nothing from too few pairs', () => {
    expect(suggest([...same, ...different.slice(0, 29)])).toBeNull();
    expect(suggest([...same.slice(0, 9), ...different])).toBeNull();
  });

  it('`--set` takes two plain numbers the check accepts, nothing else', () => {
    expect(parseThresholdArgs('0.85', '0.6')).toEqual({ verifyAt: 0.85, rejectBelow: 0.6 });
    for (const [v, r] of [
      [undefined, undefined],
      ['', ''],
      ['0.85', undefined],
      ['abc', '0.5'],
      ['0.85', '-0.1'],
      ['0.4', '0.3'],
      ['0.8', '0.8'],
      ['1.2', '0.5'],
    ] as const) {
      expect(() => parseThresholdArgs(v, r)).toThrow();
    }
    // The same rules guard the database value: 0/0 (what empty input once became) is refused.
    expect(thresholdsSchema.safeParse({ verifyAt: 0, rejectBelow: 0 }).success).toBe(false);
  });

  it('reads the CSV the page copies, and refuses anything else', () => {
    const text = `garment_id,product_id,same\n${G}1,${P}1,yes\n# a note\n\n${G}2,${P}2,NO\n`;
    expect(parsePairsCsv(text)).toEqual([
      { garmentId: `${G}1`, productId: `${P}1`, same: true },
      { garmentId: `${G}2`, productId: `${P}2`, same: false },
    ]);
    expect(() => parsePairsCsv(`${G}1,${P}1,maybe`)).toThrow(/Line 1/);
    expect(() => parsePairsCsv('x,y,yes')).toThrow(/Line 1/);
  });
});

describe('the link pair page', () => {
  const data: PairPageData = {
    createdAt: '2026-11-05T00:00:00.000Z',
    fingerprintModel: 'Marqo/marqo-fashionSigLIP@c56244c',
    thresholds: { verifyAt: 0.85, rejectBelow: 0.55 },
    pairs: [
      {
        garmentId: `${G}1`,
        productId: `${P}1`,
        similarity: 0.812,
        source: 'nearest',
        look: { url: 'https://img.test/m/l/1080.webp', width: 1080, height: 1440 },
        box: [0.1, 0.2, 0.6, 0.7],
        category: 't_shirt',
        product: {
          name: 'Coat </script><script>alert(1)</script>',
          brand: 'Filippa K',
          url: 'https://img.test/m/p/1080.webp',
          width: 800,
          height: 1000,
        },
      },
    ],
  };

  it('keeps shop words as data, never markup', () => {
    const html = renderPairPage(data);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain('\\u003c/script>\\u003cscript>alert(1)');
  });

  it('runs, and copies the answers as CSV lines', async () => {
    const html = renderPairPage(data);
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';
    expect(() => new Script(script)).not.toThrow();
    const nodes = new Map<string, FakeNode>();
    class FakeNode {
      className = '';
      textContent = '';
      style: Record<string, string> = {};
      children: FakeNode[] = [];
      classList = { toggle: () => undefined };
      onclick: (() => unknown) | null = null;
      append(...items: FakeNode[]) {
        this.children.push(...items);
      }
    }
    const document = {
      createElement: () => new FakeNode(),
      getElementById: (id: string) => {
        if (!nodes.has(id)) nodes.set(id, new FakeNode());
        return nodes.get(id);
      },
    };
    const store = new Map<string, string>();
    let copied = '';
    runInNewContext(script, {
      document,
      window: { addEventListener: () => undefined },
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
      },
      navigator: {
        clipboard: {
          writeText: (text: string) => {
            copied = text;
            return Promise.resolve();
          },
        },
      },
    });
    expect(nodes.get('score')?.textContent).toContain('0 labelled (goal 100)');
    const card = nodes.get('grid')?.children[0];
    const answers = card?.children.find((n) => n.className === 'answers');
    answers?.children[0]?.onclick?.();
    expect(nodes.get('score')?.textContent).toContain('1 labelled (goal 100) · 1 same');
    // The fingerprint score shows only once answered.
    expect(card?.children.at(-1)?.textContent).toBe('Fingerprint score 0.812');
    await nodes.get('copy')?.onclick?.();
    expect(copied).toBe(`garment_id,product_id,same\n${G}1,${P}1,yes\n`);
  });
});
