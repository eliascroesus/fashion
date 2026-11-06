import Ionicons from '@expo/vector-icons/Ionicons';
import type { FeedCard as Card, ClickSource } from '@outfitly/shared';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { Link } from 'expo-router';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { originParams } from '../clicks/shop';
import { DOWNSCALE_PHOTOS } from '../lib/photos';
import { markLookOpening } from '../looks/open-timing';
import { radii, spacing, ThemedText, useColors } from '../theme';
import { SaveButton } from './save-button';

/** Press and hold this long for the look's menu (a little quicker than the system default). */
const MENU_DELAY_MS = 350;

interface FeedCardProps {
  card: Card;
  width: number;
  height: number;
  /** The photo size that fits this card (see pickPhotoUrl). */
  uri: string;
  /** Press and hold: the look's menu (save to board, see less). */
  onMenu: (lookId: string) => void;
  /** The list this card is in and its place there, passed to the look (a Shop tap records them). */
  origin?: ClickSource;
  position: number;
  /** The save button gets `-save` added. */
  testID?: string;
}

/**
 * A look in the grid: only the photo, a save button and (once products exist)
 * the number of pieces. Its size is known before the photo loads; a blurred
 * preview and the photo's main colour fill it meanwhile. Tap opens the look
 * (on iOS 18+ the card zooms into the look page); press and hold opens its menu.
 */
export const FeedCard = memo(function FeedCard({
  card,
  width,
  height,
  uri,
  onMenu,
  origin,
  position,
  testID = 'feed-card',
}: FeedCardProps) {
  const { t } = useTranslation();
  const colors = useColors();
  return (
    <Link
      href={{ pathname: '/look/[id]', params: { id: card.id, ...originParams(origin, position) } }}
      asChild
      onPress={markLookOpening}
    >
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={t('feed.openLook')}
        accessibilityHint={t('feed.moreOptions')}
        accessibilityActions={[{ name: 'longpress', label: t('lookMenu.title') }]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'longpress') onMenu(card.id);
        }}
        delayLongPress={MENU_DELAY_MS}
        onLongPress={() => {
          Haptics.selectionAsync().catch(() => undefined);
          onMenu(card.id);
        }}
        // One flat style object: Link hands its props to the card through a slot that
        // can't merge style arrays or functions (dropped in release, an error in development).
        style={{ ...styles.card, width, height, backgroundColor: card.photo.dominantColor }}
      >
        {({ pressed }) => (
          <>
            {/* The photo is what zooms into the look page (iOS 18+). Its wrapper takes no
                space of its own, so the photo needs its own size. */}
            <Link.AppleZoom>
              <Image
                source={{ uri }}
                placeholder={{ thumbhash: card.photo.thumbhash }}
                placeholderContentFit="cover"
                contentFit="cover"
                // Cells are reused while scrolling: never show the previous look's photo.
                recyclingKey={card.id}
                cachePolicy="memory-disk"
                allowDownscaling={DOWNSCALE_PHOTOS}
                // Photos already on the phone (fetched ahead) show at once; only downloads fade in.
                transition={{ duration: 120, skipOnCacheHit: 'all' }}
                style={{ width, height }}
                accessible={false}
              />
            </Link.AppleZoom>
            {card.itemCount > 0 ? (
              <View style={[styles.badge, { backgroundColor: colors.surface }]}>
                <Ionicons name="pricetag-outline" size={12} color={colors.text} />
                <ThemedText variant="caption">
                  {t('feed.itemCount', { count: card.itemCount })}
                </ThemedText>
              </View>
            ) : null}
            <View style={styles.save}>
              <SaveButton card={card} testID={`${testID}-save`} />
            </View>
            {pressed ? (
              <View
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, styles.pressed, { backgroundColor: colors.text }]}
              />
            ) : null}
          </>
        )}
      </Pressable>
    </Link>
  );
});

const styles = StyleSheet.create({
  card: { borderRadius: radii.md, overflow: 'hidden' },
  // Dims the card a little while it's held.
  pressed: { opacity: 0.12 },
  badge: {
    position: 'absolute',
    left: spacing.sm,
    bottom: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
    borderRadius: radii.pill,
  },
  save: { position: 'absolute', right: spacing.sm, bottom: spacing.sm },
});
