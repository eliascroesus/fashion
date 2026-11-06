import { runInNewContext, Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { type RatingData, renderRatingPage } from '../scripts/similar-rating/page.ts';

const photo = (caption: string) => ({
  url: 'https://img.test/m/x/600.webp',
  width: 600,
  height: 750,
  caption,
});

const data: RatingData = {
  createdAt: '2026-11-05T04:00:00.000Z',
  model: 'Marqo/marqo-fashionSigLIP@c56244c',
  looks: [
    {
      id: 'l1',
      ...photo('A coat </script><script>alert(1)</script>'),
      similar: [photo('Near one'), photo('Near two')],
    },
  ],
  searches: [{ query: 'beige </script> trench', results: [photo('Found one')] }],
};

describe('the "More like this" rating page', () => {
  it('keeps captions as data, never markup', () => {
    const html = renderRatingPage(data);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain('beige \\u003c/script> trench');
    expect(html).toContain('\\u003c/script>\\u003cscript>alert(1)');
  });

  it('runs, and counts a rating', () => {
    const html = renderRatingPage(data);
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';
    expect(() => new Script(script)).not.toThrow();
    // Just enough of a browser for the page's script.
    const nodes = new Map<string, FakeNode>();
    class FakeNode {
      className = '';
      textContent = '';
      value = '';
      placeholder = '';
      children: FakeNode[] = [];
      classList = { toggle: () => undefined };
      onclick: (() => void) | null = null;
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
    const localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    };
    runInNewContext(script, { document, localStorage, navigator: {} });
    expect(nodes.get('score')?.textContent).toBe(
      '0 of 1 looks rated · good 0 · okay 0 · bad 0 — 0 of 1 searches rated · good 0 · okay 0 · bad 0',
    );

    // The look's "good" button: the first of its buttons row.
    const card = nodes.get('looks')?.children[0];
    const buttons = card?.children[1];
    buttons?.children[0]?.onclick?.();
    expect(nodes.get('score')?.textContent).toContain('1 of 1 looks rated · good 1');
    // The search's "bad" button: the third of its row.
    nodes.get('searches')?.children[0]?.children[1]?.children[2]?.onclick?.();
    expect(nodes.get('score')?.textContent).toContain(
      '1 of 1 searches rated · good 0 · okay 0 · bad 1',
    );
    // The caption went in as text.
    const strip = card?.children[0]?.children[1];
    expect(strip?.children[0]?.children[1]?.textContent).toBe('Near one');
  });
});
