import Ionicons from '@expo/vector-icons/Ionicons';
import { BRANDS, type BrandId, type Style, STYLES, type TastePicker } from '@outfitly/shared';
import { useQuery } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Animated, { FadeIn, useSharedValue } from 'react-native-reanimated';
import {
  PixelRatio,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../api';
import { Button } from '../components/button';
import { Chip } from '../components/chip';
import { type SwipeCardHandle, type SwipeDirection, SwipeCard } from '../components/swipe-card';
import { pickPhotoUrl } from '../feed/layout';
import { finishPicker } from '../taste';
import { preselectStyles, toggle } from '../taste/logic';
import { radii, Screen, spacing, ThemedText, useColors } from '../theme';

/** Past this, a slow connection skips the swiping and goes straight to the chips. */
const LOOKS_WAIT_MS = 3000;
/** Room left under the card for the ♥ / ✕ buttons and the texts above it. */
const CARD_HEIGHT_SHARE = 0.55;

type PickerItem = TastePicker['items'][number];
const NO_ITEMS: PickerItem[] = [];

/**
 * Every card has the same frame (so the stack looks tidy whatever the photos'
 * shapes; photos are cropped to fill it): as wide as the screen minus margins,
 * 4:5, at most CARD_HEIGHT_SHARE of the screen tall.
 */
function cardSize(screenWidth: number, screenHeight: number): { width: number; height: number } {
  const maxWidth = screenWidth - spacing.xl * 2;
  const height = Math.min(maxWidth * 1.25, screenHeight * CARD_HEIGHT_SHARE);
  return { width: Math.round(height / 1.25), height: Math.round(height) };
}

function cardPhoto(item: PickerItem, width: number): string {
  return pickPhotoUrl(item.card.photo.urls, PixelRatio.getPixelSizeForLayoutSize(width));
}

/**
 * The taste picker, shown once at the first open (skippable, under 30 s):
 * swipe about 10 looks, then tick styles (pre-ticked from the likes) and
 * favourite brands. The answers tune For You straight away; they reach the
 * server once there's a profile (see src/taste).
 */
export default function TasteScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  /** When the picker appeared (for the developer menu's timing). */
  const startedAt = useRef(0);
  const [step, setStep] = useState<'swipe' | 'chips'>('swipe');
  const [tooSlow, setTooSlow] = useState(false);
  const [styles, setStyles] = useState<Style[]>([]);
  const [brands, setBrands] = useState<BrandId[]>([]);

  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const looks = useQuery({
    queryKey: ['taste', 'picker'],
    queryFn: ({ signal }) => api.taste.picker(signal),
    staleTime: Infinity,
    retry: false,
  });
  const items = looks.data?.items ?? NO_ITEMS;

  // Every card's photo up front, so each next card shows at once.
  useEffect(() => {
    if (items.length === 0) return;
    const urls = items.map((item) => cardPhoto(item, cardSize(screenWidth, screenHeight).width));
    void Image.prefetch(urls, 'memory-disk');
  }, [items, screenWidth, screenHeight]);

  useEffect(() => {
    startedAt.current = Date.now();
  }, []);

  useEffect(() => {
    if (!looks.isPending) return;
    const timer = setTimeout(() => {
      setTooSlow(true);
    }, LOOKS_WAIT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [looks.isPending]);
  // Offline, slow or nothing to show: straight to the chips.
  const swiping =
    step === 'swipe' && !tooSlow && !looks.isError && !(looks.isSuccess && items.length === 0);

  /** Done or Skip happened (a quick second tap mustn't queue the answers twice). */
  const finished = useRef(false);
  const finish = (answers: Parameters<typeof finishPicker>[0]) => {
    if (finished.current) return;
    finished.current = true;
    finishPicker(answers, Date.now() - startedAt.current);
  };
  const skip = () => {
    finish(null);
  };

  return (
    <Screen
      testID="screen-taste"
      style={{ paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.md }}
    >
      <View style={layout.topBar}>
        <Pressable
          testID="taste-skip"
          accessibilityRole="button"
          accessibilityLabel={t('taste.skip')}
          hitSlop={spacing.sm}
          onPress={skip}
        >
          <ThemedText variant="bodyStrong" tone="muted">
            {t('taste.skip')}
          </ThemedText>
        </Pressable>
      </View>
      {swiping ? (
        <SwipeStep
          items={items}
          loading={looks.isPending}
          onDone={(liked) => {
            setStyles(preselectStyles(liked));
            setStep('chips');
          }}
        />
      ) : (
        <ChipsStep
          styles={styles}
          brands={brands}
          onStyle={(style) => {
            setStyles((current) => toggle(current, style));
          }}
          onBrand={(brand) => {
            setBrands((current) => toggle(current, brand));
          }}
          onDone={() => {
            finish({ styles, brands });
          }}
        />
      )}
    </Screen>
  );
}

function SwipeStep({
  items,
  loading,
  onDone,
}: {
  items: readonly PickerItem[];
  loading: boolean;
  onDone: (liked: PickerItem[]) => void;
}) {
  const { t } = useTranslation();
  const colors = useColors();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const liked = useRef<PickerItem[]>([]);
  const top = useRef<SwipeCardHandle>(null);
  /** How far the top card is on its way out; the card behind rises with it. */
  const leaving = useSharedValue(0);

  const size = cardSize(screenWidth, screenHeight);
  const uriOf = (item: PickerItem) => cardPhoto(item, size.width);

  // Dragged off or thrown by a button: a like gets a tap of the phone as it goes.
  const onPick = (direction: SwipeDirection) => {
    if (direction === 'like') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    }
  };
  // Out of sight: the card behind (already risen into place) becomes the top card.
  const onSwiped = (direction: SwipeDirection) => {
    const item = items[index];
    if (item && direction === 'like') liked.current.push(item);
    if (index + 1 >= items.length) onDone(liked.current);
    else setIndex(index + 1);
  };
  const press = (direction: SwipeDirection) => {
    top.current?.swipe(direction);
  };

  const current = items[index];
  const next = items[index + 1];
  return (
    <View style={layout.fill}>
      <View style={layout.texts}>
        <ThemedText variant="headline" accessibilityRole="header">
          {t('taste.swipeTitle')}
        </ThemedText>
        <ThemedText tone="muted">{t('taste.swipeHint')}</ThemedText>
      </View>
      <View style={layout.stack}>
        {/* The card behind first (drawn underneath), then the top one. Keyed by look, so the
            card behind stays the same view when it moves up. */}
        {[next, current].map((item) =>
          item ? (
            <SwipeCard
              key={item.card.id}
              {...(item === current ? { ref: top } : {})}
              card={item.card}
              uri={uriOf(item)}
              {...size}
              isTop={item === current}
              leaving={leaving}
              label={t('taste.lookLabel', { index: index + 1, total: items.length })}
              onPick={onPick}
              onSwiped={onSwiped}
            />
          ) : null,
        )}
        {!current && loading ? (
          <View style={[layout.placeholder, size, { backgroundColor: colors.surfaceMuted }]} />
        ) : null}
      </View>
      <View style={layout.buttons}>
        <RoundButton
          testID="taste-pass"
          icon="close"
          label={t('taste.pass')}
          color={colors.text}
          disabled={!current}
          onPress={() => {
            press('pass');
          }}
        />
        <ThemedText tone="muted" style={layout.progress}>
          {current ? t('taste.progress', { current: index + 1, total: items.length }) : ''}
        </ThemedText>
        <RoundButton
          testID="taste-like"
          icon="heart"
          label={t('taste.like')}
          color={colors.accent}
          disabled={!current}
          onPress={() => {
            press('like');
          }}
        />
      </View>
    </View>
  );
}

function RoundButton({
  testID,
  icon,
  label,
  color,
  disabled,
  onPress,
}: {
  testID: string;
  icon: 'close' | 'heart';
  label: string;
  color: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        layout.round,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        },
      ]}
    >
      <Ionicons name={icon} size={28} color={color} />
    </Pressable>
  );
}

function ChipsStep({
  styles,
  brands,
  onStyle,
  onBrand,
  onDone,
}: {
  styles: readonly Style[];
  brands: readonly BrandId[];
  onStyle: (style: Style) => void;
  onBrand: (brand: BrandId) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Animated.View entering={FadeIn.duration(250)} style={layout.fill}>
      <ScrollView contentContainerStyle={layout.chipsContent}>
        <View style={layout.texts}>
          <ThemedText variant="headline" accessibilityRole="header">
            {t('taste.chipsTitle')}
          </ThemedText>
          <ThemedText tone="muted">{t('taste.chipsHint')}</ThemedText>
        </View>
        <ThemedText variant="title" accessibilityRole="header" style={layout.heading}>
          {t('taste.stylesHeading')}
        </ThemedText>
        <View style={layout.chips}>
          {STYLES.map((style) => (
            <Chip
              key={style}
              testID={`taste-style-${style}`}
              label={t(`styles.${style}`)}
              selected={styles.includes(style)}
              onPress={() => {
                onStyle(style);
              }}
            />
          ))}
        </View>
        <ThemedText variant="title" accessibilityRole="header" style={layout.heading}>
          {t('taste.brandsHeading')}
        </ThemedText>
        <View style={layout.chips}>
          {BRANDS.map((brand) => (
            <Chip
              key={brand.id}
              testID={`taste-brand-${brand.id}`}
              label={brand.name}
              selected={brands.includes(brand.id)}
              onPress={() => {
                onBrand(brand.id);
              }}
            />
          ))}
        </View>
      </ScrollView>
      <Button testID="taste-done" label={t('taste.done')} onPress={onDone} style={layout.done} />
    </Animated.View>
  );
}

const layout = StyleSheet.create({
  fill: { flex: 1 },
  topBar: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: spacing.xl },
  texts: { gap: spacing.xs, paddingHorizontal: spacing.xl, paddingVertical: spacing.md },
  stack: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  placeholder: { borderRadius: radii.lg },
  heading: { paddingHorizontal: spacing.xl },
  buttons: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xxl,
    paddingTop: spacing.md,
  },
  progress: { minWidth: 48, textAlign: 'center' },
  round: {
    width: 64,
    height: 64,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipsContent: { paddingBottom: spacing.xl, gap: spacing.md },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.md,
  },
  done: { marginHorizontal: spacing.xl },
});
