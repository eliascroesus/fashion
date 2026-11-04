import type { FeedCard } from '@outfitly/shared';
import { Image } from 'expo-image';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets';
import { DOWNSCALE_PHOTOS } from '../lib/photos';
import { radii, spacing } from '../theme';

/** Swiped further than this share of the screen width (or flicked) counts as a pick. */
const PICK_DISTANCE = 0.28;
const PICK_SPEED = 900;
/** Cards settle into place quickly, slowing down at the end. */
const SETTLE = { duration: 300, easing: Easing.out(Easing.cubic) };
/** A picked card flies off fast at first, then eases out of sight. */
const THROW = { duration: 280, easing: Easing.out(Easing.quad) };
const SPRING_BACK = { damping: 18, stiffness: 220 };
/** Each place back in the stack: this much smaller and lower (two places back: invisible). */
const STEP_SCALE = 0.05;
const STEP_DROP = spacing.lg;

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
  /** The card you swipe; the other one waits behind it. */
  isTop: boolean;
  /**
   * How far the top card is on its way out (0–1), written by the top card: the
   * card behind rises as it goes, so it's already in place when it has left.
   */
  leaving: SharedValue<number>;
  /** The top card was picked (it starts flying off now). */
  onPick: (direction: SwipeDirection) => void;
  /** The picked card is out of sight. */
  onSwiped: (direction: SwipeDirection) => void;
}

/**
 * A look in the taste picker's stack. On top it follows the finger (tilting a
 * little) and flies off when let go far or fast enough, otherwise springs back.
 * Behind, it waits one place back, rises as the top card leaves, and becomes the
 * top card itself (the same view, so nothing reloads or jumps). New cards ease
 * in from further back. Everything moves on the UI thread.
 */
export const SwipeCard = forwardRef<SwipeCardHandle, SwipeCardProps>(function SwipeCard(
  { card, uri, width, height, label, isTop, leaving, onPick, onSwiped },
  ref,
) {
  const { width: screenWidth } = useWindowDimensions();
  const x = useSharedValue(0);
  /** Picked and flying off: further drags and taps belong to the next card. */
  const gone = useSharedValue(false);
  const top = useSharedValue(isTop);
  /** Places back in the stack: 0 on top, 1 behind it, 2 out of sight. Starts one further back. */
  const depth = useSharedValue(isTop ? 1 : 2);
  const offscreen = screenWidth * 1.5;
  const pickDistance = screenWidth * PICK_DISTANCE;
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      // Ease in: the first card from one place back, the next ones from out of sight.
      mounted.current = true;
      depth.value = withTiming(isTop ? 0 : 1, SETTLE);
      return;
    }
    if (!isTop) return;
    // Moving up: carry on from where it is now (it rose while the top card left), in one UI frame.
    scheduleOnUI(() => {
      'worklet';
      const behind = Math.min(Math.max(2 - depth.value, 0), 1);
      depth.value = Math.max(depth.value - leaving.value * behind, 0);
      depth.value = withTiming(0, SETTLE);
      top.value = true;
    });
  }, [isTop, depth, top, leaving]);

  // The top card tells the one behind how far it has gone.
  useAnimatedReaction(
    () => (top.value ? Math.min(Math.abs(x.value) / pickDistance, 1) : -1),
    (now) => {
      if (now >= 0) leaving.value = now;
    },
  );

  const throwOff = (direction: SwipeDirection) => {
    'worklet';
    if (gone.value || !top.value) return;
    gone.value = true;
    scheduleOnRN(onPick, direction);
    x.value = withTiming(direction === 'like' ? offscreen : -offscreen, THROW, (finished) => {
      if (finished) scheduleOnRN(onSwiped, direction);
    });
  };

  useImperativeHandle(ref, () => ({ swipe: throwOff }));

  const pan = usePanGesture({
    enabled: isTop,
    activeOffsetX: [-8, 8],
    onUpdate: (event) => {
      'worklet';
      if (gone.value) return;
      x.value = event.translationX;
    },
    onDeactivate: (event) => {
      'worklet';
      if (gone.value) return;
      const far = Math.abs(event.translationX) > pickDistance;
      const fast = Math.abs(event.velocityX) > PICK_SPEED;
      if (far || fast) throwOff(event.translationX + event.velocityX * 0.1 > 0 ? 'like' : 'pass');
      else x.value = withSpring(0, SPRING_BACK);
    },
  });

  const placed = useAnimatedStyle(() => {
    // Behind the top card it rises as the top card leaves; the top card ignores that.
    const behind = Math.min(Math.max(2 - depth.value, 0), 1);
    const back = top.value ? depth.value : Math.max(depth.value - leaving.value * behind, 0);
    return {
      opacity: interpolate(back, [1, 2], [1, 0], Extrapolation.CLAMP),
      transform: [
        { translateX: x.value },
        { translateY: back * STEP_DROP },
        { scale: 1 - back * STEP_SCALE },
        { rotate: `${String(x.value / 25)}deg` },
      ],
    };
  });

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        {...(isTop ? { testID: 'taste-card' } : {})}
        accessible={isTop}
        accessibilityElementsHidden={!isTop}
        importantForAccessibility={isTop ? 'yes' : 'no-hide-descendants'}
        accessibilityRole="image"
        accessibilityLabel={label}
        style={[styles.card, { width, height, backgroundColor: card.photo.dominantColor }, placed]}
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
