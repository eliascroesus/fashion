import Ionicons from '@expo/vector-icons/Ionicons';
import type { FeedCard as Card } from '@outfitly/shared';
import { Image } from 'expo-image';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { radii, spacing, ThemedText, useColors } from '../theme';

interface FeedCardProps {
  card: Card;
  width: number;
  height: number;
  /** The photo size that fits this card (see pickPhotoUrl). */
  uri: string;
  onOpen: (lookId: string) => void;
}

/** Saving arrives in Step 2.4; until then the tap is caught here so it doesn't open the look. */
function saveNotReadyYet() {
  return undefined;
}

/**
 * A look in the grid: only the photo, a save button and (once products exist)
 * the number of pieces. Its size is known before the photo loads; a blurred
 * preview and the photo's main colour fill it meanwhile.
 */
export const FeedCard = memo(function FeedCard({
  card,
  width,
  height,
  uri,
  onOpen,
}: FeedCardProps) {
  const { t } = useTranslation();
  const colors = useColors();
  return (
    <Pressable
      testID="feed-card"
      accessibilityRole="button"
      accessibilityLabel={t('feed.openLook')}
      onPress={() => {
        onOpen(card.id);
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
      <Pressable
        testID="feed-card-save"
        accessibilityRole="button"
        accessibilityLabel={t('feed.save')}
        hitSlop={spacing.sm}
        onPress={saveNotReadyYet}
        style={[styles.save, { backgroundColor: colors.surface }]}
      >
        <Ionicons name="bookmark-outline" size={18} color={colors.text} />
      </Pressable>
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
  save: {
    position: 'absolute',
    right: spacing.sm,
    bottom: spacing.sm,
    width: 34,
    height: 34,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
