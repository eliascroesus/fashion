import Ionicons from '@expo/vector-icons/Ionicons';
import type { FeedCard } from '@outfitly/shared';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { setSaved, useIsSaved } from '../saves';
import { radii, spacing, useColors } from '../theme';

interface SaveButtonProps {
  card: FeedCard;
  size?: number;
  testID?: string;
}

/** The bookmark on a card or a look: one tap saves (with a little bounce), another unsaves. */
export function SaveButton({ card, size = 34, testID = 'save-button' }: SaveButtonProps) {
  const { t } = useTranslation();
  const colors = useColors();
  const saved = useIsSaved(card.id, card.saved);
  const scale = useSharedValue(1);
  const wasSaved = useRef(saved);

  // Bounce when it becomes saved (also after a double-tap on the photo).
  useEffect(() => {
    if (saved && !wasSaved.current) {
      scale.value = withSequence(withTiming(1.3, { duration: 110 }), withSpring(1));
    }
    wasSaved.current = saved;
  }, [saved, scale]);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={saved ? t('feed.unsave') : t('feed.save')}
      accessibilityState={{ selected: saved }}
      hitSlop={spacing.sm}
      onPress={() => {
        void setSaved(card, !saved);
      }}
      style={[
        styles.button,
        { width: size, height: size, backgroundColor: saved ? colors.accent : colors.surface },
      ]}
    >
      <Animated.View style={animated}>
        <Ionicons
          name={saved ? 'bookmark' : 'bookmark-outline'}
          size={Math.round(size * 0.53)}
          color={saved ? colors.onAccent : colors.text}
        />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
});
