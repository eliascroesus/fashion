import Ionicons from '@expo/vector-icons/Ionicons';
import type { FeedCard, LookItem } from '@outfitly/shared';
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
import { DOWNSCALE_PHOTOS } from '../lib/photos';
import { dotPlacement, dotsOnPhoto } from '../looks/shop';
import { saveIfNot } from '../saves';
import { radii, spacing, useColors } from '../theme';
import { gridPhotoUrl } from './look-grid';

type Photo = FeedCard['photo'];

const POP_SIZE = 96;
/** A piece's dot on the photo, and the bigger area that takes the tap. */
const DOT_SIZE = 24;
const DOT_HIT = 44;
/** Two taps on a photo within this long are a double-tap (a single tap does nothing). */
const DOUBLE_TAP_MS = 300;

interface LookPhotosProps {
  /** The look as a card (for saving); its photo is the cover. */
  card: FeedCard;
  /** All the look's photos once loaded; until then only the cover. */
  photos: readonly Photo[];
  width: number;
  /** The cover photo is displayed (open-time measurement). */
  onCoverShown?: () => void;
  /** The look's pieces: those with a dot get one on their photo. */
  items?: readonly LookItem[];
  /** A piece's dot was tapped. */
  onDotPress?: (item: LookItem) => void;
}

/**
 * The look's photos, swiped sideways, all as tall as the cover (sizes known
 * up front, so nothing jumps). The cover is where the grid card zooms to.
 * Double-tap saves, with a bookmark that pops up in the middle. Each piece
 * with a known place gets a dot there; tapping it shows the piece.
 */
export function LookPhotos({
  card,
  photos,
  width,
  onCoverShown,
  items = [],
  onDotPress,
}: LookPhotosProps) {
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

  const sharp = (photo: Photo, placeholder: boolean) => (
    <Image
      source={{ uri: photo.urls[1080] }}
      {...(placeholder ? { placeholder: { thumbhash: photo.thumbhash } } : {})}
      placeholderContentFit="cover"
      contentFit="cover"
      cachePolicy="memory-disk"
      // Narrower phones show the 1080 smaller (on iPhone, not redrawn mid-zoom).
      allowDownscaling={DOWNSCALE_PHOTOS}
      transition={placeholder ? 0 : 150}
      style={StyleSheet.absoluteFill}
      accessible={false}
    />
  );

  const dots = (photo: Photo, index: number) =>
    dotsOnPhoto(items, index).flatMap(({ item, x, y }) => {
      const place = dotPlacement(photo, { width, height }, { x, y });
      if (!place) return [];
      // Kept fully on the photo, even for a piece at its very edge.
      const left = Math.min(Math.max(place.left, DOT_SIZE / 2), width - DOT_SIZE / 2);
      const top = Math.min(Math.max(place.top, DOT_SIZE / 2), height - DOT_SIZE / 2);
      return [
        <Pressable
          key={item.id}
          testID="look-dot"
          accessibilityRole="button"
          accessibilityLabel={t('look.dotLabel', {
            name: item.brand ? `${item.brand} ${item.name}` : item.name,
          })}
          onPress={() => {
            onDotPress?.(item);
          }}
          style={[styles.dotHit, { left: left - DOT_HIT / 2, top: top - DOT_HIT / 2 }]}
        >
          <View
            style={[
              styles.pieceDot,
              { backgroundColor: colors.surface, borderColor: colors.border },
            ]}
          >
            <View style={[styles.pieceDotMiddle, { backgroundColor: colors.text }]} />
          </View>
        </Pressable>,
      ];
    });

  const renderPhoto = ({ item, index }: { item: Photo; index: number }) => {
    const frame = { width, height, backgroundColor: item.dominantColor };
    // The cover first shows the very copy the grid card loaded (in memory, so at once),
    // with the sharp 1080 fading in on top.
    const image =
      index === 0 ? (
        <View style={frame}>
          <Image
            source={{ uri: gridPhotoUrl(item.urls, width) }}
            placeholder={{ thumbhash: item.thumbhash }}
            placeholderContentFit="cover"
            contentFit="cover"
            cachePolicy="memory-disk"
            style={StyleSheet.absoluteFill}
            accessible={false}
            {...(onCoverShown ? { onDisplay: onCoverShown } : {})}
          />
          {sharp(item, false)}
          {/* Where the grid card zooms to: an empty frame over the photo. The photos must not be
              inside Link.AppleZoomTarget: after the zoom they stay undrawn (only the main colour
              showed, unnoticed with the plain stand-in pictures). */}
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <Link.AppleZoomTarget>
              <View collapsable={false} style={{ width, height }} />
            </Link.AppleZoomTarget>
          </View>
          {dots(item, index)}
        </View>
      ) : (
        <View style={frame}>
          {sharp(item, true)}
          {dots(item, index)}
        </View>
      );
    return (
      <Pressable
        testID={`look-photo-${String(index)}`}
        accessibilityLabel={t('look.photoOf', { index: index + 1, count: photos.length })}
        accessibilityRole="image"
        onPress={onPress}
      >
        {image}
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
        // The pieces (and their dots) arrive with the look, after the cover.
        extraData={items}
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
        // On a small pill of their own, so they show on light and dark photos alike.
        <View
          style={[styles.dots, { backgroundColor: colors.surface }]}
          pointerEvents="none"
          testID="look-photo-dots"
        >
          {photos.map((photo, index) => (
            <View
              key={`${String(index)}-${photo.urls[300]}`}
              style={[
                styles.dot,
                { backgroundColor: index === page ? colors.text : colors.border },
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
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
  },
  dot: { width: 6, height: 6, borderRadius: radii.pill },
  dotHit: {
    position: 'absolute',
    width: DOT_HIT,
    height: DOT_HIT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pieceDot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pieceDotMiddle: { width: 8, height: 8, borderRadius: radii.pill },
});
