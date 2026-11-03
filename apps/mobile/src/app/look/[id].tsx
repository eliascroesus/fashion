import Ionicons from '@expo/vector-icons/Ionicons';
import type { FeedCard } from '@outfitly/shared';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { GestureDetector, useTapGesture } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FeedMessage } from '../../components/feed-message';
import { SaveButton } from '../../components/save-button';
import { photoHeight } from '../../feed/layout';
import { findCard, saveIfNot } from '../../saves';
import { radii, Screen, spacing, useColors } from '../../theme';

const POP_SIZE = 96;

/** The cover photo; double-tap saves it, with a bookmark that pops up in the middle. */
function Photo({ card, width }: { card: FeedCard; width: number }) {
  const colors = useColors();
  const pop = useSharedValue(0);
  const doubleTap = useTapGesture({
    numberOfTaps: 2,
    runOnJS: true,
    onActivate: () => {
      pop.value = withSequence(
        withSpring(1, { damping: 12 }),
        withDelay(350, withTiming(0, { duration: 200 })),
      );
      saveIfNot(card);
    },
  });
  const popStyle = useAnimatedStyle(() => ({
    opacity: pop.value,
    transform: [{ scale: 0.6 + 0.4 * pop.value }],
  }));

  return (
    <GestureDetector gesture={doubleTap}>
      <View testID="look-photo" accessible={false}>
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
        <Animated.View
          pointerEvents="none"
          style={[styles.pop, { backgroundColor: colors.surface }, popStyle]}
        >
          <Ionicons name="bookmark" size={POP_SIZE / 2} color={colors.accent} />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

/**
 * A look, opened from a grid. For now its cover photo (already cached from
 * the grid, so it shows at once) and the save button; double-tap the photo to
 * save. The full look page is Step 2.5.
 */
export default function LookScreen() {
  const { t } = useTranslation();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { id } = useLocalSearchParams<{ id: string }>();
  const card = findCard(id);

  return (
    <Screen testID="screen-look" style={{ paddingTop: insets.top }}>
      {card ? <Photo card={card} width={width} /> : <FeedMessage body={t('look.notFound')} />}
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
      {card ? (
        <View style={[styles.save, { top: insets.top + spacing.sm }]}>
          <SaveButton card={card} size={40} testID="look-save" />
        </View>
      ) : null}
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
  save: { position: 'absolute', right: spacing.md },
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
});
