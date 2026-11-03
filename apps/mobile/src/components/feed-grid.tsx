import type { EventSource, FeedCard } from '@outfitly/shared';
import {
  FlashList,
  type FlashListRef,
  type ListRenderItemInfo,
  type ViewToken,
} from '@shopify/flash-list';
import { Image } from 'expo-image';
import { router, useIsFocused } from 'expo-router';
import { type ReactElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  PixelRatio,
  RefreshControl,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { logImpression } from '../events';
import { ImpressionTracker } from '../feed/impressions';
import type { FeedKind } from '../feed/keys';
import {
  cardWidth,
  type GridMetrics,
  photoHeight,
  photosToPrefetch,
  pickPhotoUrl,
  shouldLoadMore,
} from '../feed/layout';
import { useFeed } from '../feed/use-feed';
import { useAppActive } from '../lib/app-state';
import { grid, spacing, ThemedText, useColors } from '../theme';
import { FeedCard as FeedCardView } from './feed-card';
import { FeedMessage } from './feed-message';

const SOURCE: Record<FeedKind, EventSource> = {
  'for-you': 'feed_for_you',
  following: 'feed_following',
};

const METRICS: GridMetrics = { columns: grid.columns, gap: grid.gap, inset: grid.inset };

/**
 * "On screen" = at least half of the card visible, reported as soon as it
 * changes (the impression clock and prefetching run off it; the handler is cheap).
 */
const VIEWABILITY = { itemVisiblePercentThreshold: 50, minimumViewTime: 0 };

interface FeedGridProps {
  kind: FeedKind;
  /** Whether this feed is the one showing on Home (the other keeps its place, hidden). */
  active: boolean;
  /** Shown when the feed has no looks at all. */
  empty: ReactElement;
  testID: string;
}

/**
 * A home feed as a two-column masonry grid: the next page loads 60% of the
 * way into the current one, photos for the next two screens are fetched
 * ahead, pull to refresh starts a new list, and cards seen for a second are
 * logged as impressions.
 */
export function FeedGrid({ kind, active, empty, testID }: FeedGridProps) {
  const { t } = useTranslation();
  const colors = useColors();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const focused = useIsFocused();
  const appActive = useAppActive();
  const listRef = useRef<FlashListRef<FeedCard>>(null);
  const offset = useRef(0);
  /** The user has dragged this list since it opened. */
  const touched = useRef(false);
  const viewport = useRef(screenHeight);
  const furthestVisible = useRef(-1);
  const prefetched = useRef(new Set<string>());

  const width = cardWidth(screenWidth, METRICS);
  const widthPx = PixelRatio.getPixelSizeForLayoutSize(width);
  const canReplace = useCallback(() => !touched.current, []);
  const feed = useFeed(kind, { enabled: true, canReplace });
  const { cards, loadMore, firstPage } = feed;

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

  // A new list replaced the old one: every card may count again, and the list
  // starts at the top (before paint, so the new cards never show at the old place).
  useLayoutEffect(() => {
    if (!firstPage) return;
    tracker.reset();
    furthestVisible.current = -1;
    if (offset.current > 0) listRef.current?.scrollToOffset({ offset: 0, animated: false });
    listRef.current?.recomputeViewableItems();
  }, [tracker, firstPage]);

  const prefetchAhead = useCallback(() => {
    const urls = photosToPrefetch({
      cards,
      furthestVisible: furthestVisible.current,
      viewportHeight: viewport.current,
      cardWidth: width,
      widthPx,
      metrics: METRICS,
      done: prefetched.current,
    });
    if (urls.length === 0) return;
    for (const url of urls) prefetched.current.add(url);
    void Image.prefetch(urls, 'memory-disk');
  }, [cards, width, widthPx]);

  // A page arrived: fetch its photos ahead, and keep going if the user is already near its end
  // (e.g. the page only held looks already on screen).
  useEffect(() => {
    prefetchAhead();
    if (shouldLoadMore(furthestVisible.current, cards.length)) loadMore();
  }, [cards, prefetchAhead, loadMore]);

  const onViewableItemsChanged = ({ viewableItems }: { viewableItems: ViewToken<FeedCard>[] }) => {
    const visible = viewableItems.flatMap((token) =>
      token.index === null ? [] : [{ lookId: token.item.id, position: token.index }],
    );
    tracker.update(visible);
    const furthest = Math.max(-1, ...visible.map((v) => v.position));
    if (furthest > furthestVisible.current) {
      furthestVisible.current = furthest;
      prefetchAhead();
    }
    if (shouldLoadMore(furthest, cards.length)) loadMore();
  };

  const openLook = useCallback((id: string) => {
    router.push({ pathname: '/look/[id]', params: { id } });
  }, []);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<FeedCard>) => (
      <View style={styles.cell}>
        <FeedCardView
          card={item}
          width={width}
          height={photoHeight(item.photo, width)}
          uri={pickPhotoUrl(item.photo.urls, widthPx)}
          onOpen={openLook}
        />
      </View>
    ),
    [width, widthPx, openLook],
  );

  let footer: ReactElement | null = null;
  if (feed.isFetchingNextPage) {
    footer = <ActivityIndicator style={styles.footer} color={colors.textMuted} />;
  } else if (feed.isFetchNextPageError) {
    footer = (
      <FeedMessage
        body={t('feed.loadMoreFailed')}
        action={{ label: t('errors.retry'), onPress: feed.retryNextPage }}
      />
    );
  } else if (!feed.hasNextPage && cards.length > 0) {
    footer = (
      <ThemedText tone="muted" style={styles.end} testID="feed-end">
        {t('feed.allCaughtUp')}
      </ThemedText>
    );
  }

  let emptyState = empty;
  if (feed.isPending) {
    emptyState = <ActivityIndicator style={styles.loading} color={colors.textMuted} />;
  } else if (feed.isError) {
    emptyState = (
      <FeedMessage
        title={t('feed.loadFailedTitle')}
        body={t('feed.loadFailed')}
        action={{ label: t('errors.retry'), onPress: feed.retry }}
      />
    );
  }

  return (
    <FlashList
      ref={listRef}
      testID={testID}
      data={cards}
      masonry
      numColumns={METRICS.columns}
      renderItem={renderItem}
      keyExtractor={(card) => card.id}
      // Cards are drawn a screen ahead, so fast scrolling doesn't reach empty space.
      drawDistance={screenHeight}
      viewabilityConfig={VIEWABILITY}
      onViewableItemsChanged={onViewableItemsChanged}
      onEndReached={loadMore}
      onEndReachedThreshold={1}
      onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
        offset.current = e.nativeEvent.contentOffset.y;
      }}
      scrollEventThrottle={16}
      onScrollBeginDrag={() => {
        touched.current = true;
      }}
      onLayout={(e: LayoutChangeEvent) => {
        viewport.current = e.nativeEvent.layout.height;
      }}
      refreshControl={
        <RefreshControl
          refreshing={feed.refreshing}
          onRefresh={() => void feed.refresh()}
          tintColor={colors.textMuted}
          colors={[colors.accent]}
          progressBackgroundColor={colors.surface}
        />
      }
      // iOS: keeps the last cards clear of the floating tab bar.
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      ListEmptyComponent={
        <View style={[styles.empty, { minHeight: screenHeight / 2 }]}>{emptyState}</View>
      }
      ListFooterComponent={footer}
    />
  );
}

const styles = StyleSheet.create({
  // Half a gap around each card + the rest at the edges = an even grid.
  content: {
    paddingHorizontal: grid.inset - grid.gap / 2,
    paddingTop: grid.inset,
    paddingBottom: spacing.xxxl,
  },
  cell: { paddingHorizontal: grid.gap / 2, paddingBottom: grid.gap },
  footer: { paddingVertical: spacing.xl },
  end: { textAlign: 'center', paddingVertical: spacing.xl },
  empty: { justifyContent: 'center' },
  loading: { paddingVertical: spacing.xxxl },
});
