import type { EventSource } from '@outfitly/shared';
import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useMemo } from 'react';
import type { VisibleCard } from '../components/look-grid';
import { logImpression } from '../events';
import { useAppActive } from '../lib/app-state';
import { ImpressionTracker } from './impressions';

/**
 * Impressions for a look grid: cards at least half on screen for a second,
 * with their position, while the grid is `active`, its screen focused and
 * the app in front. `reset` when a new list replaces the old one.
 */
export function useImpressions(source: EventSource, active: boolean) {
  const focused = useIsFocused();
  const appActive = useAppActive();
  const tracker = useMemo(
    () =>
      new ImpressionTracker(({ lookId, position }) => {
        logImpression(lookId, position, source);
      }),
    [source],
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
  const reset = useCallback(() => {
    tracker.reset();
  }, [tracker]);
  return { onVisibleChange, reset };
}
