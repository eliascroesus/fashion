import type { EventSource } from '@outfitly/shared';
import { useIsFocused } from 'expo-router';
import { type ReactElement, useCallback, useEffect, useMemo, useRef } from 'react';
import { logImpression } from '../events';
import { ImpressionTracker } from '../feed/impressions';
import type { FeedKind } from '../feed/keys';
import { useFeed } from '../feed/use-feed';
import { useAppActive } from '../lib/app-state';
import { LookGrid, type VisibleCard } from './look-grid';

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
  const focused = useIsFocused();
  const appActive = useAppActive();
  /** The user has dragged this list since it opened. */
  const touched = useRef(false);
  const canReplace = useCallback(() => !touched.current, []);
  const feed = useFeed(kind, { enabled: true, canReplace });

  const tracker = useMemo(
    () =>
      new ImpressionTracker(({ lookId, position }) => {
        logImpression(lookId, position, SOURCE[kind]);
      }),
    [kind],
  );
  useEffect(
    () => () => {
      tracker.dispose();
    },
    [tracker],
  );
  useEffect(() => {
    tracker.setActive(active && focused && appActive);
  }, [tracker, active, focused, appActive]);

  const onVisibleChange = useCallback(
    (visible: VisibleCard[]) => {
      tracker.update(visible);
    },
    [tracker],
  );

  return (
    <LookGrid
      list={feed}
      empty={empty}
      testID={testID}
      onVisibleChange={onVisibleChange}
      // A new list replaced the old one: every card may count again.
      resetKey={feed.listId}
      onReset={() => {
        tracker.reset();
      }}
      onScrollBeginDrag={() => {
        touched.current = true;
      }}
    />
  );
}
