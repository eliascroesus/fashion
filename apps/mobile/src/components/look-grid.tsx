import type { FeedCard } from '@outfitly/shared';
import {
  FlashList,
  type FlashListRef,
  type ListRenderItemInfo,
  type ViewToken,
} from '@shopify/flash-list';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import {
  type ReactElement,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
} from 'react';
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
import {
  cardWidth,
  type GridMetrics,
  photoHeight,
  photosToPrefetch,
  pickPhotoUrl,
  shouldLoadMore,
} from '../feed/layout';
import type { CardList } from '../saves/queries';
import { grid, spacing, ThemedText, useColors } from '../theme';
import { FeedCard as FeedCardView } from './feed-card';
import { FeedMessage } from './feed-message';

const METRICS: GridMetrics = { columns: grid.columns, gap: grid.gap, inset: grid.inset };

/**
 * "On screen" = at least half of the card visible, reported as soon as it
 * changes (impressions and prefetching run off it; the handler is cheap).
 */
const VIEWABILITY = { itemVisiblePercentThreshold: 50, minimumViewTime: 0 };

export interface VisibleCard {
  lookId: string;
  position: number;
}

interface LookGridProps {
  list: CardList;
  /** Shown when the list has no looks at all. */
  empty: ReactElement;
  testID: string;
  /** Test id of each card (its save button gets `-save` added). */
  cardTestID?: string;
  /** Scrolls with the grid, above the first cards. */
  header?: ReactElement | null;
  /** Which cards are at least half on screen (e.g. for impressions). */
  onVisibleChange?: (visible: VisibleCard[]) => void;
  /**
   * Changes when a new list replaces the old one: the grid jumps to the top
   * before it's drawn, after `onReset` (e.g. impressions count afresh).
   */
  resetKey?: unknown;
  onReset?: () => void;
  /** The user started dragging the grid. */
  onScrollBeginDrag?: () => void;
  /** Under the last card once the list has ended (default "You're all caught up"); null for none. */
  endMessage?: string | null;
}

/**
 * Looks as a two-column masonry grid: sizes known before photos load, the
 * next page 60% of the way into the current one, photos for the next two
 * screens fetched ahead, pull to refresh. Tap opens a look; press and hold
 * opens its menu.
 */
export function LookGrid({
  list,
  empty,
  testID,
  cardTestID = 'feed-card',
  header,
  onVisibleChange,
  resetKey,
  onReset,
  onScrollBeginDrag,
  endMessage,
}: LookGridProps) {
  const { t } = useTranslation();
  const colors = useColors();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const listRef = useRef<FlashListRef<FeedCard>>(null);
  const offset = useRef(0);
  const viewport = useRef(screenHeight);
  const furthestVisible = useRef(-1);
  const prefetched = useRef(new Set<string>());
  const reset = useEffectEvent(() => {
    onReset?.();
  });

  const width = cardWidth(screenWidth, METRICS);
  const widthPx = PixelRatio.getPixelSizeForLayoutSize(width);
  const { cards, loadMore } = list;

  // A new list replaced the old one: start at the top (before paint, so the
  // new cards never show at the old place) and look again at what's visible.
  useLayoutEffect(() => {
    if (!resetKey) return;
    reset();
    furthestVisible.current = -1;
    if (offset.current > 0) listRef.current?.scrollToOffset({ offset: 0, animated: false });
    listRef.current?.recomputeViewableItems();
  }, [resetKey]);

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
    onVisibleChange?.(visible);
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
  const openMenu = useCallback((id: string) => {
    router.push({ pathname: '/look-menu/[id]', params: { id } });
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
          onMenu={openMenu}
          testID={cardTestID}
        />
      </View>
    ),
    [width, widthPx, openLook, openMenu, cardTestID],
  );

  let footer: ReactElement | null = null;
  if (list.isFetchingNextPage) {
    footer = <ActivityIndicator style={styles.footer} color={colors.textMuted} />;
  } else if (list.isFetchNextPageError) {
    footer = (
      <FeedMessage
        body={t('feed.loadMoreFailed')}
        action={{ label: t('errors.retry'), onPress: list.retryNextPage }}
      />
    );
  } else if (!list.hasNextPage && cards.length > 0 && endMessage !== null) {
    footer = (
      <ThemedText tone="muted" style={styles.end} testID="feed-end">
        {endMessage ?? t('feed.allCaughtUp')}
      </ThemedText>
    );
  }

  let emptyState = empty;
  if (list.isPending) {
    emptyState = <ActivityIndicator style={styles.loading} color={colors.textMuted} />;
  } else if (list.isError) {
    emptyState = (
      <FeedMessage
        title={t('feed.loadFailedTitle')}
        body={t('feed.loadFailed')}
        action={{ label: t('errors.retry'), onPress: list.retry }}
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
      {...(onScrollBeginDrag ? { onScrollBeginDrag } : {})}
      onLayout={(e: LayoutChangeEvent) => {
        viewport.current = e.nativeEvent.layout.height;
      }}
      refreshControl={
        <RefreshControl
          refreshing={list.refreshing}
          onRefresh={() => void list.refresh()}
          tintColor={colors.textMuted}
          colors={[colors.accent]}
          progressBackgroundColor={colors.surface}
        />
      }
      // iOS: keeps the last cards clear of the floating tab bar.
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      ListHeaderComponent={header ?? null}
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
