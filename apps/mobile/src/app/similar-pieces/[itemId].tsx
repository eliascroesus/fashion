import { formatMoney, type SimilarPiece, type SimilarPieceSort } from '@outfitly/shared';
import { fontWeights } from '@outfitly/ui-tokens';
import { FlashList, type FlashListRef, type ListRenderItemInfo } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { openShop, prepareShop } from '../../clicks';
import { FeedMessage } from '../../components/feed-message';
import { showToast } from '../../components/toast';
import { useMoneyLocale } from '../../lib/money';
import { useSimilarPieces } from '../../looks/queries';
import { radii, Screen, spacing, ThemedText, useColors } from '../../theme';

const SORTS: readonly SimilarPieceSort[] = ['nearest', 'cheaper'];
const COLUMNS = 2;
/** Product photos sit in a fixed 4:5 frame, so the grid never moves while they load. */
const FRAME_RATIO = 5 / 4;

interface PieceCardProps {
  piece: SimilarPiece;
  width: number;
  locale: string;
  onShop: (piece: SimilarPiece) => void;
}

function PieceCard({ piece, width, locale, onShop }: PieceCardProps) {
  const { t } = useTranslation();
  const colors = useColors();
  const title = piece.brand ? `${piece.brand} ${piece.name}` : piece.name;
  const price = piece.price ? formatMoney(piece.price, locale) : t('look.noPrice');
  return (
    <Pressable
      testID="similar-piece"
      accessibilityRole="link"
      // The whole card is one button: its label says what VoiceOver users can't see inside.
      accessibilityLabel={t('similar.pieceLabel', { name: title, price })}
      accessibilityHint={t('look.shopHint', { shop: piece.shop })}
      onPress={() => {
        onShop(piece);
      }}
      style={(state) => [styles.card, { width, opacity: state.pressed ? 0.8 : 1 }]}
    >
      <View
        style={[
          styles.frame,
          { width, height: width * FRAME_RATIO, backgroundColor: piece.image.dominantColor },
        ]}
      >
        <Image
          source={{ uri: piece.image.urls[600] }}
          placeholder={{ thumbhash: piece.image.thumbhash }}
          placeholderContentFit="cover"
          contentFit="cover"
          recyclingKey={piece.image.urls[600]}
          cachePolicy="memory-disk"
          transition={{ duration: 120, skipOnCacheHit: 'all' }}
          style={StyleSheet.absoluteFill}
          accessible={false}
        />
      </View>
      {piece.brand ? (
        <ThemedText variant="caption" tone="muted" numberOfLines={1}>
          {piece.brand}
        </ThemedText>
      ) : null}
      <ThemedText numberOfLines={2}>{piece.name}</ThemedText>
      <View style={styles.priceLine}>
        <ThemedText variant="bodyStrong">{price}</ThemedText>
        <View style={[styles.shop, { borderColor: colors.text }]}>
          <ThemedText variant="caption" style={styles.shopText}>
            {t('look.shop')}
          </ThemedText>
        </View>
      </View>
      <ThemedText variant="caption" tone="muted" numberOfLines={1}>
        {piece.shop}
      </ThemedText>
    </Pressable>
  );
}

/**
 * "Similar pieces" for one piece of a look: products whose shop photos look
 * most like it (same kind), or the cheaper ones among the nearest. Tapping one
 * opens its shop inside Outfitly, like Shop on a look.
 */
export default function SimilarPiecesSheet() {
  const { t } = useTranslation();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const locale = useMoneyLocale();
  const { width: screenWidth } = useWindowDimensions();
  const { itemId, name, currency } = useLocalSearchParams<{
    itemId: string;
    name?: string;
    currency?: string;
  }>();
  const [sort, setSort] = useState<SimilarPieceSort>('nearest');
  const listRef = useRef<FlashListRef<SimilarPiece>>(null);
  const { pieces, query } = useSimilarPieces(itemId, sort);
  const cardWidth = (screenWidth - 2 * spacing.lg - spacing.md * (COLUMNS - 1)) / COLUMNS;

  useEffect(() => {
    prepareShop();
  }, []);

  const shop = useCallback(
    (piece: SimilarPiece) => {
      const position = pieces.indexOf(piece);
      void openShop(
        piece.lookId,
        piece,
        { source: 'similar_pieces', position: position < 0 ? null : position },
        { bar: colors.surface, controls: colors.text },
      ).then((result) => {
        if (result === 'failed') showToast(t('look.shopFailed'));
      });
    },
    [pieces, colors.surface, colors.text, t],
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<SimilarPiece>) => (
      <View style={styles.cell}>
        <PieceCard piece={item} width={cardWidth} locale={locale} onShop={shop} />
      </View>
    ),
    [cardWidth, locale, shop],
  );

  let empty = (
    <ThemedText tone="muted" style={styles.note}>
      {t('similar.empty')}
    </ThemedText>
  );
  if (query.isPending) {
    empty = <ActivityIndicator style={styles.note} color={colors.textMuted} />;
  } else if (query.isError) {
    empty = (
      <FeedMessage
        body={t('similar.loadFailed')}
        action={{ label: t('errors.retry'), onPress: () => void query.refetch() }}
      />
    );
  }

  let footer = null;
  if (query.isFetchingNextPage) {
    footer = <ActivityIndicator style={styles.note} color={colors.textMuted} />;
  } else if (query.isFetchNextPageError) {
    footer = (
      <FeedMessage
        body={t('similar.loadFailed')}
        action={{ label: t('errors.retry'), onPress: () => void query.fetchNextPage() }}
      />
    );
  }

  const header = (
    <View style={styles.header}>
      <ThemedText variant="title" accessibilityRole="header">
        {t('similar.title')}
      </ThemedText>
      {name ? (
        <ThemedText tone="muted" numberOfLines={1}>
          {name}
        </ThemedText>
      ) : null}
      <View
        style={styles.sorts}
        accessibilityRole="tablist"
        accessibilityLabel={t('similar.sortLabel')}
      >
        {SORTS.map((option) => {
          const selected = option === sort;
          return (
            <Pressable
              key={option}
              testID={`similar-sort-${option}`}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              hitSlop={spacing.xs}
              onPress={() => {
                // The other order starts from the top.
                listRef.current?.scrollToOffset({ offset: 0, animated: false });
                setSort(option);
              }}
              style={[
                styles.sort,
                selected
                  ? { backgroundColor: colors.text, borderColor: colors.text }
                  : { borderColor: colors.border },
              ]}
            >
              <ThemedText
                variant="caption"
                style={[styles.sortText, { color: selected ? colors.background : colors.text }]}
              >
                {t(`similar.${option}`)}
              </ThemedText>
            </Pressable>
          );
        })}
      </View>
      {sort === 'cheaper' && currency && pieces.length > 0 ? (
        <ThemedText variant="caption" tone="muted">
          {t('similar.cheaperNote', { currency })}
        </ThemedText>
      ) : null}
    </View>
  );

  return (
    <Screen style={[styles.sheet, { paddingBottom: insets.bottom }]} testID="similar-pieces">
      <FlashList
        ref={listRef}
        data={pieces}
        numColumns={COLUMNS}
        keyExtractor={(piece) => piece.productId}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={footer}
        onEndReached={() => {
          if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) {
            void query.fetchNextPage();
          }
        }}
        onEndReachedThreshold={1}
        contentContainerStyle={styles.content}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  sheet: { paddingTop: spacing.xl },
  content: { paddingHorizontal: spacing.lg - spacing.md / 2, paddingBottom: spacing.xl },
  header: { gap: spacing.xs, paddingHorizontal: spacing.md / 2, paddingBottom: spacing.md },
  sorts: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  sort: {
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  sortText: { fontWeight: fontWeights.semibold },
  cell: { paddingHorizontal: spacing.md / 2, paddingBottom: spacing.lg },
  card: { gap: spacing.xxs },
  frame: { borderRadius: radii.md, overflow: 'hidden', marginBottom: spacing.xs },
  priceLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  shop: {
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
  },
  shopText: { fontWeight: fontWeights.semibold },
  note: { padding: spacing.xl, textAlign: 'center' },
});
