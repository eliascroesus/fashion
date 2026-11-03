import type { PersistedClient } from '@tanstack/react-query-persist-client';
import { describe, expect, it } from 'vitest';
import { feedQueryKey } from '../feed/keys';
import { boardLooksQueryKey, savesQueryKey } from '../saves/keys';
import { trimFeedsForStorage } from './persist';

function query(queryKey: readonly unknown[], data: unknown) {
  return {
    queryKey,
    queryHash: JSON.stringify(queryKey),
    state: { data, dataUpdatedAt: 1, status: 'success' },
  };
}

function client(queries: ReturnType<typeof query>[]): PersistedClient {
  return {
    timestamp: 1,
    buster: 'v1',
    clientState: { mutations: [], queries },
  } as unknown as PersistedClient;
}

const pages = (count: number) => ({
  pages: Array.from({ length: count }, (_, i) => ({ items: [], nextCursor: `c${String(i + 1)}` })),
  pageParams: [null, ...Array.from({ length: count - 1 }, (_, i) => `c${String(i + 1)}`)],
});

describe('trimFeedsForStorage', () => {
  it('keeps the first 2 pages of each feed, with the cursor to go on', () => {
    const trimmed = trimFeedsForStorage(client([query(feedQueryKey('for-you', null), pages(6))]));
    expect(trimmed.clientState.queries[0]?.state.data).toEqual({
      pages: [
        { items: [], nextCursor: 'c1' },
        { items: [], nextCursor: 'c2' },
      ],
      pageParams: [null, 'c1'],
    });
  });

  it('trims Saves and board lists the same way', () => {
    const trimmed = trimFeedsForStorage(
      client([
        query(savesQueryKey('p1'), pages(5)),
        query(boardLooksQueryKey('p1', 'b'), pages(3)),
      ]),
    );
    for (const q of trimmed.clientState.queries) {
      expect((q.state.data as { pages: unknown[] }).pages).toHaveLength(2);
    }
  });

  it('leaves short feeds and other queries alone', () => {
    const me = query(['me'], { userId: 'x' });
    const short = query(feedQueryKey('following', 'p1'), pages(2));
    const trimmed = trimFeedsForStorage(client([me, short]));
    expect(trimmed.clientState.queries).toEqual([me, short]);
  });
});
