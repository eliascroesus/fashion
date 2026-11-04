import type { FeedCard } from '@outfitly/shared';
import { Image } from 'expo-image';
import { forwardRef, useImperativeHandle } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { DOWNSCALE_PHOTOS } from '../lib/photos';
import { radii } from '../theme';

/** Swiped further than this share of the screen width (or flicked) counts as a pick. */
const PICK_DISTANCE = 0.28;
const PICK_SPEED = 900;

export type SwipeDirection = 'like' | 'pass';

export interface SwipeCardHandle {
  /** Throws the card off as if swiped (the ♥ and ✕ buttons). */
  swipe: (direction: SwipeDirection) => void;
}

interface SwipeCardProps {
  card: FeedCard;
  uri: string;
  width: number;
  height: number;
  label: string;
  onSwiped: (direction: SwipeDirection) => void;
}

/**
 * A look to drag right (like) or left (pass); it tilts with the drag and flies
 * off when let go far or fast enough, otherwise springs back. Runs on the UI
 * thread; only the pick itself goes to React.
 */
export const SwipeCard = forwardRef<SwipeCardHandle, SwipeCardProps>(function SwipeCard(
  { card, uri, width, height, label, onSwiped },
  ref,
) {
  const { width: screenWidth } = useWindowDimensions();
  const x = useSharedValue(0);
  const offscreen = screenWidth * 1.5;

  const throwOff = (direction: SwipeDirection) => {
    'worklet';
    x.value = withTiming(direction === 'like' ? offscreen : -offscreen, { duration: 220 }, () => {
      scheduleOnRN(onSwiped, direction);
    });
  };

  useImperativeHandle(ref, () => ({ swipe: throwOff }));

  const pan = usePanGesture({
    activeOffsetX: [-8, 8],
    onUpdate: (event) => {
      'worklet';
      x.value = event.translationX;
    },
    onDeactivate: (event) => {
      'worklet';
      const far = Math.abs(event.translationX) > screenWidth * PICK_DISTANCE;
      const fast = Math.abs(event.velocityX) > PICK_SPEED;
      if (far || fast) throwOff(event.translationX + event.velocityX * 0.1 > 0 ? 'like' : 'pass');
      else x.value = withSpring(0);
    },
  });

  const moving = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { rotate: `${String(x.value / 25)}deg` }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        testID="taste-card"
        accessible
        accessibilityRole="image"
        accessibilityLabel={label}
        style={[styles.card, { width, height, backgroundColor: card.photo.dominantColor }, moving]}
      >
        <Image
          source={{ uri }}
          placeholder={{ thumbhash: card.photo.thumbhash }}
          placeholderContentFit="cover"
          contentFit="cover"
          cachePolicy="memory-disk"
          allowDownscaling={DOWNSCALE_PHOTOS}
          transition={{ duration: 120, skipOnCacheHit: 'all' }}
          style={{ width, height }}
          accessible={false}
        />
      </Animated.View>
    </GestureDetector>
  );
});

const styles = StyleSheet.create({
  card: { borderRadius: radii.lg, overflow: 'hidden', position: 'absolute' },
});
