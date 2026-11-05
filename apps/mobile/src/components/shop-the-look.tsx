import Ionicons from '@expo/vector-icons/Ionicons';
import { formatMoney, formatTotals, type LookItem, piecesTotal } from '@outfitly/shared';
import { Image } from 'expo-image';
import { getLocales } from 'expo-localization';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { fontWeights } from '@outfitly/ui-tokens';
import { type LayoutChangeEvent, Pressable, StyleSheet, View } from 'react-native';
import { daysSince, moneyLocale } from '../looks/shop';
import { radii, spacing, ThemedText, useColors } from '../theme';

/** Product photos in the list: a fixed 4:5 frame, so nothing moves when they load. */
const THUMB = { width: 64, height: 80 } as const;
const SOLD_OUT_OPACITY = 0.45;
/** Between short facts on one line ("Price checked today · zalando.se"); the same in every language. */
const SEPARATOR = ' · ';

/** The locale prices are written in (the app's language, the phone's region). */
export function useMoneyLocale(): string {
  const { i18n } = useTranslation();
  return useMemo(() => moneyLocale(i18n.language, getLocales().at(0)?.regionCode), [i18n.language]);
}

interface ItemRowProps {
  item: LookItem;
  locale: string;
  ticked: boolean;
  highlighted: boolean;
  onTick: (id: string) => void;
  /** Opens the shop (Step 3.7); until then the button shows but can't be pressed. */
  onShop: ((item: LookItem) => void) | undefined;
  onLayout: (id: string, event: LayoutChangeEvent) => void;
}

function ItemRow({ item, locale, ticked, highlighted, onTick, onShop, onLayout }: ItemRowProps) {
  const { t } = useTranslation();
  const colors = useColors();
  const soldOut = item.stock === 'out_of_stock';
  const title = item.brand ? `${item.brand} ${item.name}` : item.name;

  let checked: string | null = null;
  if (item.priceCheckedAt) {
    const days = daysSince(item.priceCheckedAt, new Date());
    checked =
      days === 0
        ? t('look.checkedToday')
        : days === 1
          ? t('look.checkedYesterday')
          : t('look.checkedDaysAgo', { count: days });
  }

  return (
    <View
      testID="shop-item"
      onLayout={(event) => {
        onLayout(item.id, event);
      }}
      style={[styles.row, highlighted ? { backgroundColor: colors.surfaceMuted } : null]}
    >
      <View
        style={[
          styles.thumb,
          { backgroundColor: item.image?.dominantColor ?? colors.surfaceMuted },
          soldOut ? styles.soldOut : null,
        ]}
      >
        {item.image ? (
          <Image
            source={{ uri: item.image.urls[300] }}
            placeholder={{ thumbhash: item.image.thumbhash }}
            placeholderContentFit="cover"
            contentFit="cover"
            recyclingKey={item.image.urls[300]}
            cachePolicy="memory-disk"
            transition={{ duration: 120, skipOnCacheHit: 'all' }}
            style={StyleSheet.absoluteFill}
            accessible={false}
          />
        ) : (
          <Ionicons name="shirt-outline" size={24} color={colors.textMuted} />
        )}
      </View>
      <View style={[styles.text, soldOut ? styles.soldOut : null]}>
        {item.brand ? (
          <ThemedText variant="caption" tone="muted" numberOfLines={1}>
            {item.brand}
          </ThemedText>
        ) : null}
        <ThemedText numberOfLines={2}>{item.name}</ThemedText>
        <View style={styles.priceLine}>
          <ThemedText variant="bodyStrong" testID="shop-item-price">
            {item.price ? formatMoney(item.price, locale) : t('look.noPrice')}
          </ThemedText>
          {soldOut ? (
            <ThemedText variant="caption" style={{ color: colors.danger }}>
              {t('look.soldOut')}
            </ThemedText>
          ) : item.stock === 'in_stock' ? (
            <ThemedText variant="caption" tone="muted">
              {t('look.inStock')}
            </ThemedText>
          ) : null}
        </View>
        <ThemedText variant="caption" tone="muted" numberOfLines={1}>
          {[checked, item.shop].filter(Boolean).join(SEPARATOR)}
        </ThemedText>
      </View>
      <View style={styles.side}>
        <Pressable
          testID="shop-item-tick"
          accessibilityRole="checkbox"
          accessibilityLabel={t('look.tickLabel', { name: title })}
          accessibilityState={{ checked: ticked, disabled: soldOut }}
          disabled={soldOut}
          hitSlop={spacing.sm}
          onPress={() => {
            onTick(item.id);
          }}
          style={[
            styles.tick,
            ticked
              ? { backgroundColor: colors.accent, borderColor: colors.accent }
              : { borderColor: colors.border },
            soldOut ? styles.soldOut : null,
          ]}
        >
          {ticked ? <Ionicons name="checkmark" size={16} color={colors.onAccent} /> : null}
        </Pressable>
        <Pressable
          testID="shop-item-shop"
          accessibilityRole="link"
          accessibilityLabel={t('look.shopLabel', { name: title, shop: item.shop })}
          accessibilityState={{ disabled: !onShop }}
          disabled={!onShop}
          onPress={() => {
            onShop?.(item);
          }}
          style={(state) => [
            styles.shop,
            { borderColor: colors.text, opacity: !onShop ? 0.4 : state.pressed ? 0.7 : 1 },
          ]}
        >
          <ThemedText variant="caption" style={styles.shopText}>
            {t('look.shop')}
          </ThemedText>
        </Pressable>
      </View>
    </View>
  );
}

interface ShopTheLookProps {
  items: readonly LookItem[];
  /** The ticked pieces (the look page keeps them, for its selection bar). */
  ticked: ReadonlySet<string>;
  onTick: (id: string) => void;
  /** The piece whose dot was just tapped, shown highlighted for a moment. */
  highlighted: string | null;
  onShop?: (item: LookItem) => void;
  /** Where each piece sits inside this list (for scrolling to it). */
  onItemLayout: (id: string, y: number) => void;
}

/**
 * The look's pieces (outerwear first): photo, brand, name, price, stock and
 * how fresh the price is, with "Total look" on top. Sold-out pieces are
 * greyed, can't be ticked and are never counted.
 */
export function ShopTheLook({
  items,
  ticked,
  onTick,
  highlighted,
  onShop,
  onItemLayout,
}: ShopTheLookProps) {
  const { t } = useTranslation();
  const locale = useMoneyLocale();
  const all = piecesTotal(items);
  const notes = [
    all.soldOut > 0 ? t('look.notCountedSoldOut', { count: all.soldOut }) : null,
    all.unpriced > 0 ? t('look.notCountedUnpriced', { count: all.unpriced }) : null,
  ].filter((note) => note !== null);

  return (
    <View style={styles.box} testID="shop-the-look">
      <View style={styles.heading}>
        <ThemedText variant="title" accessibilityRole="header">
          {t('look.shopTitle')}
        </ThemedText>
        {all.totals.length > 0 ? (
          <ThemedText variant="bodyStrong" testID="shop-total">
            {t('look.totalLook', { total: formatTotals(all.totals, locale) })}
          </ThemedText>
        ) : null}
        {notes.length > 0 ? (
          <ThemedText variant="caption" tone="muted">
            {notes.join(SEPARATOR)}
          </ThemedText>
        ) : null}
      </View>
      {items.map((item) => (
        <ItemRow
          key={item.id}
          item={item}
          locale={locale}
          ticked={ticked.has(item.id)}
          highlighted={highlighted === item.id}
          onTick={onTick}
          onShop={onShop}
          onLayout={(id, event) => {
            onItemLayout(id, event.nativeEvent.layout.y);
          }}
        />
      ))}
    </View>
  );
}

/**
 * The ticked pieces' running total, floating at the bottom of the look page
 * while any are ticked (so it stays in view wherever the ticks are).
 */
export function SelectionBar({
  items,
  ticked,
  onClear,
  bottom,
}: {
  items: readonly LookItem[];
  ticked: ReadonlySet<string>;
  onClear: () => void;
  /** Distance from the bottom of the screen. */
  bottom: number;
}) {
  const { t } = useTranslation();
  const colors = useColors();
  const locale = useMoneyLocale();
  const chosen = piecesTotal(items, ticked);
  const count = items.filter((item) => ticked.has(item.id)).length;
  if (count === 0) return null;
  return (
    <View
      style={[
        styles.selected,
        { bottom, backgroundColor: colors.surface, borderColor: colors.border },
      ]}
      testID="shop-selected"
    >
      <ThemedText
        variant="bodyStrong"
        style={styles.selectedText}
        testID="shop-selected-total"
        accessibilityLiveRegion="polite"
      >
        {t('look.selectedTotal', {
          count,
          // Only pieces without a price ticked: nothing to add up.
          total: chosen.totals.length > 0 ? formatTotals(chosen.totals, locale) : t('look.noPrice'),
        })}
      </ThemedText>
      <Pressable
        testID="shop-clear"
        accessibilityRole="button"
        accessibilityLabel={t('look.clearSelection')}
        hitSlop={spacing.sm}
        onPress={onClear}
      >
        <ThemedText variant="bodyStrong" style={{ color: colors.accent }}>
          {t('look.clearSelection')}
        </ThemedText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: spacing.xs },
  heading: { gap: spacing.xxs, marginBottom: spacing.sm },
  row: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    marginHorizontal: -spacing.sm,
    borderRadius: radii.md,
  },
  thumb: {
    ...THUMB,
    borderRadius: radii.sm,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1, gap: spacing.xxs },
  priceLine: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, flexWrap: 'wrap' },
  side: { alignItems: 'flex-end', justifyContent: 'space-between' },
  tick: {
    width: 26,
    height: 26,
    borderRadius: radii.pill,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shop: {
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  shopText: { fontWeight: fontWeights.semibold },
  soldOut: { opacity: SOLD_OUT_OPACITY },
  selected: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  selectedText: { flex: 1 },
});
