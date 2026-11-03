import Ionicons from '@expo/vector-icons/Ionicons';
import type { FeedCard } from '@outfitly/shared';
import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { Link } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { photoHeight } from '../feed/layout';
import { saveIfNot } from '../saves';
import { radii, spacing, useColors } from '../theme';

type Photo = FeedCard['photo'];

const POP_SIZE = 96;
/** Two taps on a photo within this long are a double-tap (a single tap does nothing). */
const DOUBLE_TAP_MS = 300;

interface LookPhotosProps {
  /** The look as a card (for saving); its photo is the cover. */
  card: FeedCard;
  /** All the look's photos once loaded; until then only the cover. */
  photos: readonly Photo[];
  width: number;
  /** The cover is on screen: its first frame after layout (open-time measurement). */
  onCoverShown?: () => void;
}

/**
 * The look's photos, swiped sideways, all as tall as the cover (sizes known
 * up front, so nothing jumps). The cover is where the grid card zooms to.
 * Double-tap saves, with a bookmark that pops up in the middle.
 */
export function LookPhotos({ card, photos, width, onCoverShown }: LookPhotosProps) {
  const { t } = useTranslation();
  const colors = useColors();
  const height = photoHeight(card.photo, width);
  const [page, setPage] = useState(0);
  const pop = useSharedValue(0);
  const lastTap = useRef(0);

  const onPress = () => {
    const now = Date.now();
    if (now - lastTap.current > DOUBLE_TAP_MS) {
      lastTap.current = now;
      return;
    }
    lastTap.current = 0;
    pop.value = withSequence(
      withSpring(1, { damping: 12 }),
      withDelay(350, withTiming(0, { duration: 200 })),
    );
    saveIfNot(card);
  };
  const popStyle = useAnimatedStyle(() => ({
    opacity: pop.value,
    transform: [{ scale: 0.6 + 0.4 * pop.value }],
  }));

  const renderPhoto = ({ item, index }: { item: Photo; index: number }) => {
    const image = (
      <Image
        source={{ uri: item.urls[1080] }}
        // The cover's smaller copy is already in memory from the grid: show it until the sharp one arrives.
        placeholder={index === 0 ? { uri: item.urls[600] } : { thumbhash: item.thumbhash }}
        placeholderContentFit="cover"
        contentFit="cover"
        cachePolicy="memory-disk"
        style={{ width, height, backgroundColor: item.dominantColor }}
        accessible={false}
      />
    );
    return (
      <Pressable
        testID={`look-photo-${String(index)}`}
        accessibilityLabel={t('look.photoOf', { index: index + 1, count: photos.length })}
        onPress={onPress}
        // The cover shows the grid's copy at once (the sharp one follows): that frame is "open".
        {...(index === 0 && onCoverShown
          ? {
              onLayout: () => {
                requestAnimationFrame(onCoverShown);
              },
            }
          : {})}
      >
        {index === 0 ? <Link.AppleZoomTarget>{image}</Link.AppleZoomTarget> : image}
      </Pressable>
    );
  };

  return (
    <View style={{ width, height }} testID="look-photos">
      <FlashList
        data={photos}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(_photo, index) => String(index)}
        renderItem={renderPhoto}
        onMomentumScrollEnd={(e) => {
          setPage(Math.round(e.nativeEvent.contentOffset.x / width));
        }}
      />
      <Animated.View
        pointerEvents="none"
        style={[styles.pop, { backgroundColor: colors.surface }, popStyle]}
      >
        <Ionicons name="bookmark" size={POP_SIZE / 2} color={colors.accent} />
      </Animated.View>
      {photos.length > 1 ? (
        <View style={styles.dots} pointerEvents="none" testID="look-photo-dots">
          {photos.map((photo, index) => (
            <View
              key={`${String(index)}-${photo.urls[300]}`}
              style={[
                styles.dot,
                { backgroundColor: index === page ? colors.surface : colors.textMuted },
              ]}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pop: {
    position: 'absolute',
    alignSelf: 'center',
    top: '50%',
    marginTop: -POP_SIZE / 2,
    width: POP_SIZE,
    height: POP_SIZE,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dots: {
    position: 'absolute',
    bottom: spacing.md,
    alignSelf: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
  },
  dot: { width: 6, height: 6, borderRadius: radii.pill },
});
