import Ionicons from '@expo/vector-icons/Ionicons';
import type { FeedCard, LookDetail, LookItem } from '@outfitly/shared';
import type { FlashListRef } from '@shopify/flash-list';
import {
  type NativeStackNavigationProp,
  router,
  useLocalSearchParams,
  useNavigation,
} from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiRequestError } from '../../api';
import { ActivityIndicator, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AuthorRow } from '../../components/author-row';
import { FeedMessage } from '../../components/feed-message';
import { LookGrid } from '../../components/look-grid';
import { LookPhotos } from '../../components/look-photos';
import { SaveButton } from '../../components/save-button';
import { SelectionBar, ShopTheLook } from '../../components/shop-the-look';
import type { CardList } from '../../feed/card-list';
import { markLookShown } from '../../looks/open-timing';
import { useLookDetail, useSimilarLooks } from '../../looks/queries';
import { findCard } from '../../saves';
import { grid, radii, Screen, spacing, ThemedText, useColors } from '../../theme';

/** The look as a grid card (to save it), when it isn't in any cached list. */
function cardOf(look: LookDetail): FeedCard | undefined {
  const [cover] = look.photos;
  if (!cover) return undefined;
  return {
    id: look.id,
    authorId: look.author.id,
    photo: cover,
    itemCount: look.itemCount,
    saved: look.saved,
  };
}

const nothing = () => undefined;

/** "More like this" until the zoom is over: still loading, and asks for nothing. */
const NOT_BUILT_YET: CardList = {
  cards: [],
  isPending: true,
  isError: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  isFetchNextPageError: false,
  loadMore: nothing,
  retryNextPage: nothing,
  retry: nothing,
  refreshing: false,
  refresh: () => Promise.resolve(),
};

/** If the stack never says the opening animation ended, go ahead after this long. */
const OPENED_FALLBACK_MS = 600;
/** A piece whose dot was tapped stays highlighted this long. */
const HIGHLIGHT_MS = 1500;
/** Room left above a piece scrolled to: the round buttons floating over the top. */
const ABOVE_PIECE = 40 + 2 * spacing.sm;

/** True once this screen's opening animation (e.g. the zoom from the grid) has finished. */
function useOpened(): boolean {
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (opened) return;
    const timer = setTimeout(() => {
      setOpened(true);
    }, OPENED_FALLBACK_MS);
    const unsubscribe = navigation.addListener('transitionEnd', (event) => {
      if (!event.data.closing) setOpened(true);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [navigation, opened]);
  return opened;
}

/**
 * Scrolling to a piece of the look when its dot is tapped: the list's place
 * on the page, each piece's place in it, and a short highlight.
 */
function usePieceScroll() {
  const listRef = useRef<FlashListRef<FeedCard>>(null);
  const bodyY = useRef(0);
  const shopY = useRef(0);
  const pieceY = useRef(new Map<string, number>());
  const [highlighted, setHighlighted] = useState<string | null>(null);
  useEffect(() => {
    if (highlighted === null) return;
    const timer = setTimeout(() => {
      setHighlighted(null);
    }, HIGHLIGHT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [highlighted]);

  const showPiece = (item: LookItem) => {
    const y = pieceY.current.get(item.id);
    if (y === undefined) return;
    const offset = Math.max(0, bodyY.current + shopY.current + y - ABOVE_PIECE);
    listRef.current?.scrollToOffset({ offset, animated: true });
    setHighlighted(item.id);
  };

  return {
    listRef,
    highlighted,
    showPiece,
    onBodyY: (y: number) => {
      bodyY.current = y;
    },
    onShopY: (y: number) => {
      shopY.current = y;
    },
    onPieceY: (id: string, y: number) => {
      pieceY.current.set(id, y);
    },
  };
}

/**
 * A look: its photos (the grid card zooms into the first) with a dot on each
 * piece, who posted it with a Follow button, the caption, its pieces with
 * prices ("shop the look"), and "More like this" underneath. The screen it
 * was opened from stays as it was, so Back lands on the same spot.
 */
export default function LookScreen() {
  const { t } = useTranslation();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { id } = useLocalSearchParams<{ id: string }>();
  const detail = useLookDetail(id);
  const similar = useSimilarLooks(id);
  // "More like this" (below the screen at first) is fetched at once but only built after the
  // zoom, which then has the main thread to itself.
  const opened = useOpened();
  // The card from the grid shows at once; the look's own data fills in the rest.
  const card = findCard(id) ?? (detail.data ? cardOf(detail.data) : undefined);
  // Removed or hidden since (404), versus no connection or a server problem (worth a retry).
  const gone = detail.error instanceof ApiRequestError && detail.error.status === 404;
  const retry = { label: t('errors.retry'), onPress: () => void detail.refetch() };
  const pieces = usePieceScroll();
  const items = detail.data?.items ?? [];
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const tick = (itemId: string) => {
    setTicked((current) => {
      const next = new Set(current);
      if (!next.delete(itemId)) next.add(itemId);
      return next;
    });
  };

  let body = <ActivityIndicator style={styles.loading} color={colors.textMuted} />;
  if (detail.data) {
    body = (
      <>
        <AuthorRow author={detail.data.author} />
        {detail.data.caption ? (
          <ThemedText testID="look-caption">{detail.data.caption}</ThemedText>
        ) : null}
        {items.length > 0 ? (
          <View
            onLayout={(e) => {
              pieces.onShopY(e.nativeEvent.layout.y);
            }}
          >
            <ShopTheLook
              items={items}
              ticked={ticked}
              onTick={tick}
              highlighted={pieces.highlighted}
              onItemLayout={pieces.onPieceY}
            />
          </View>
        ) : null}
      </>
    );
  } else if (gone) {
    body = <FeedMessage body={t('look.notFound')} />;
  } else if (detail.isError) {
    body = <FeedMessage body={t('look.loadFailed')} action={retry} />;
  }

  const header = card ? (
    <View style={styles.header}>
      <LookPhotos
        card={card}
        photos={detail.data?.photos ?? [card.photo]}
        width={width}
        onCoverShown={markLookShown}
        items={items}
        onDotPress={pieces.showPiece}
      />
      <View
        style={styles.body}
        onLayout={(e) => {
          pieces.onBodyY(e.nativeEvent.layout.y);
        }}
      >
        {body}
        <ThemedText variant="title" accessibilityRole="header" style={styles.more}>
          {t('look.moreLikeThis')}
        </ThemedText>
      </View>
    </View>
  ) : null;

  const roundButton = { top: insets.top + spacing.sm, backgroundColor: colors.surface };
  return (
    <Screen testID="screen-look" style={{ paddingTop: insets.top }}>
      {card ? (
        <LookGrid
          scrollRef={pieces.listRef}
          list={opened ? similar : NOT_BUILT_YET}
          testID="look-page"
          cardTestID="similar-card"
          header={header}
          endMessage={null}
          refreshable={false}
          empty={
            <ThemedText tone="muted" style={styles.none}>
              {t('look.noSimilar')}
            </ThemedText>
          }
        />
      ) : gone ? (
        <FeedMessage body={t('look.notFound')} />
      ) : detail.isError ? (
        <FeedMessage body={t('look.loadFailed')} action={retry} />
      ) : (
        <ActivityIndicator style={styles.loading} color={colors.textMuted} />
      )}
      <Pressable
        testID="look-back"
        accessibilityRole="button"
        accessibilityLabel={t('look.back')}
        hitSlop={spacing.sm}
        onPress={() => {
          router.back();
        }}
        style={[styles.round, styles.back, roundButton]}
      >
        <Ionicons name="chevron-back" size={22} color={colors.text} />
      </Pressable>
      {card ? (
        <View style={[styles.save, { top: insets.top + spacing.sm }]}>
          <SaveButton card={card} size={40} testID="look-save" />
        </View>
      ) : null}
      <SelectionBar
        items={items}
        ticked={ticked}
        onClear={() => {
          setTicked(new Set());
        }}
        bottom={insets.bottom + spacing.md}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  // The grid pads its content; the photos go edge to edge.
  header: {
    marginHorizontal: -(grid.inset - grid.gap / 2),
    marginTop: -grid.inset,
    marginBottom: spacing.sm,
  },
  body: { padding: spacing.lg, gap: spacing.lg },
  more: { marginTop: spacing.sm },
  loading: { paddingVertical: spacing.xl },
  none: { textAlign: 'center', padding: spacing.xl },
  round: {
    position: 'absolute',
    width: 40,
    height: 40,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  back: { left: spacing.md },
  save: { position: 'absolute', right: spacing.md },
});
