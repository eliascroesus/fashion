import Ionicons from '@expo/vector-icons/Ionicons';
import type { FeedCard as Card } from '@outfitly/shared';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
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
  onOpen: (lookId: string) => void;
  /** Press and hold: the look's menu (save to board, see less). */
  onMenu: (lookId: string) => void;
  /** The save button gets `-save` added. */
  testID?: string;
}

/**
 * A look in the grid: only the photo, a save button and (once products exist)
 * the number of pieces. Its size is known before the photo loads; a blurred
 * preview and the photo's main colour fill it meanwhile. Tap opens the look;
 * press and hold opens its menu.
 */
export const FeedCard = memo(function FeedCard({
  card,
  width,
  height,
  uri,
  onOpen,
  onMenu,
  testID = 'feed-card',
}: FeedCardProps) {
  const { t } = useTranslation();
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={t('feed.openLook')}
      accessibilityHint={t('feed.moreOptions')}
      accessibilityActions={[{ name: 'longpress', label: t('lookMenu.title') }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'longpress') onMenu(card.id);
      }}
      onPress={() => {
        onOpen(card.id);
      }}
      delayLongPress={MENU_DELAY_MS}
      onLongPress={() => {
        Haptics.selectionAsync().catch(() => undefined);
        onMenu(card.id);
      }}
      style={({ pressed }) => [
        styles.card,
        { width, height, backgroundColor: card.photo.dominantColor, opacity: pressed ? 0.85 : 1 },
      ]}
    >
      <Image
        source={{ uri }}
        placeholder={{ thumbhash: card.photo.thumbhash }}
        placeholderContentFit="cover"
        contentFit="cover"
        // Cells are reused while scrolling: never show the previous look's photo.
        recyclingKey={card.id}
        cachePolicy="memory-disk"
        transition={120}
        style={StyleSheet.absoluteFill}
        accessible={false}
      />
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
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: { borderRadius: radii.md, overflow: 'hidden' },
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
