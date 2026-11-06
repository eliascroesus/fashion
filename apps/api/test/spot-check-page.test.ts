import { runInNewContext, Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { type PageData, renderPage } from '../scripts/spot-check/page.ts';

const data: PageData = {
  model: 'gemini-3.1-flash-lite',
  promptVersion: 'spot-v1',
  createdAt: '2026-11-05T00:00:00.000Z',
  photos: [
    {
      mediaId: 'm1',
      url: 'https://img.test/m/m1/600.webp',
      width: 1080,
      height: 1440,
      status: 'done',
      readAt: '2026-11-05T00:00:00.000Z',
      description: 'A coat </script><script>alert(1)</script>',
      tags: ['minimal'],
      flags: [],
      garments: [
        {
          id: 'g1',
          category: 't_shirt',
          color: 'white',
          attributes: { pattern: 'solid' },
          box: [0.1, 0.2, 0.5, 0.6],
          fingerprinted: true,
        },
      ],
    },
  ],
  cost: {
    runCalls: 2,
    runMicros: 1710,
    calls: 2,
    readings: 1,
    totalMicros: 1710,
    perPhotoMicros: 1710,
    perSuccessMicros: 855,
    averageInput: 1500,
    averageOutput: 320,
  },
};

describe('the spot-check page', () => {
  it('keeps the AI’s words as data, never markup', () => {
    const html = renderPage(data);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain('\\u003c/script>\\u003cscript>alert(1)');
  });

  it('has a script that parses', () => {
    const html = renderPage(data);
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';
    expect(script).toContain('const data = ');
    // Parses only (not run): a syntax error throws here.
    expect(() => new Script(script)).not.toThrow();
  });

  it('runs and adds up the ticks', () => {
    const html = renderPage(data);
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';
    // Just enough of a browser for the page's script.
    const nodes = new Map<string, FakeNode>();
    class FakeNode {
      className = '';
      textContent = '';
      style: Record<string, string> = {};
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
    expect(nodes.get('score')?.textContent).toContain('0 of 1 photos checked');
    expect(nodes.get('meta')?.textContent).toContain(
      '$1.71 per 1,000 photos (2 calls for 1 readings',
    );

    // "All right" on the only photo: 1 of 1 piece right, nothing missed.
    const card = nodes.get('grid')?.children[0];
    const body = card?.children[1];
    const missedRow = body?.children.find((n) => n.className === 'missed');
    missedRow?.children[2]?.onclick?.();
    expect(nodes.get('score')?.textContent).toContain('1 of 1 photos checked');
    expect(nodes.get('score')?.textContent).toContain('= 100% (goal 90%)');
    // Kept per reading of the photo.
    const kept = JSON.parse(store.get('spot-check:spot-v1') ?? '{}') as Record<string, unknown>;
    expect(Object.keys(kept)).toEqual(['m1@2026-11-05T00:00:00.000Z']);
  });
});
