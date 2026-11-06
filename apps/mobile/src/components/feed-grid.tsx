import type { EventSource } from '@outfitly/shared';
import { type ReactElement, useCallback, useRef } from 'react';
import type { FeedKind } from '../feed/keys';
import { useFeed } from '../feed/use-feed';
import { useImpressions } from '../feed/use-impressions';
import { LookGrid } from './look-grid';

const SOURCE: Record<FeedKind, EventSource> = {
  'for-you': 'feed_for_you',
  following: 'feed_following',
};

interface FeedGridProps {
  kind: FeedKind;
  /** Whether this feed is the one showing on Home (the other keeps its place, hidden). */
  active: boolean;
  /** Shown when the feed has no looks at all. */
  empty: ReactElement;
  testID: string;
}

/**
 * A home feed in the look grid: pull to refresh starts a new list, and cards
 * seen for a second are logged as impressions.
 */
export function FeedGrid({ kind, active, empty, testID }: FeedGridProps) {
  /** The user has dragged this list since it opened. */
  const touched = useRef(false);
  const canReplace = useCallback(() => !touched.current, []);
  const feed = useFeed(kind, { enabled: true, canReplace });
  const impressions = useImpressions(SOURCE[kind], active);

  return (
    <LookGrid
      origin={SOURCE[kind]}
      list={feed}
      empty={empty}
      testID={testID}
      onVisibleChange={impressions.onVisibleChange}
      // A new list replaced the old one: every card may count again.
      resetKey={feed.listId}
      onReset={impressions.reset}
      onScrollBeginDrag={() => {
        touched.current = true;
      }}
    />
  );
}
