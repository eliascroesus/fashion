import Ionicons from '@expo/vector-icons/Ionicons';
import { useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FeedMessage } from '../../components/feed-message';
import { findCachedCard } from '../../feed/cache';
import { photoHeight } from '../../feed/layout';
import { radii, Screen, spacing, useColors } from '../../theme';

/**
 * A look, opened from the grid. For now only its cover photo (already
 * cached from the grid, so it shows at once); the full look page is Step 2.5.
 */
export default function LookScreen() {
  const { t } = useTranslation();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { id } = useLocalSearchParams<{ id: string }>();
  const card = findCachedCard(useQueryClient(), id);

  return (
    <Screen testID="screen-look" style={{ paddingTop: insets.top }}>
      {card ? (
        <Image
          source={{ uri: card.photo.urls[1080] }}
          // The grid's smaller copy is already in memory: show it until the sharp one arrives.
          placeholder={{ uri: card.photo.urls[600] }}
          placeholderContentFit="cover"
          contentFit="cover"
          style={{
            width,
            height: photoHeight(card.photo, width),
            backgroundColor: card.photo.dominantColor,
          }}
          accessible={false}
        />
      ) : (
        <FeedMessage body={t('look.notFound')} />
      )}
      <Pressable
        testID="look-back"
        accessibilityRole="button"
        accessibilityLabel={t('look.back')}
        hitSlop={spacing.sm}
        onPress={() => {
          router.back();
        }}
        style={[styles.back, { top: insets.top + spacing.sm, backgroundColor: colors.surface }]}
      >
        <Ionicons name="chevron-back" size={22} color={colors.text} />
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  back: {
    position: 'absolute',
    left: spacing.md,
    width: 40,
    height: 40,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
