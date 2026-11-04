import Ionicons from '@expo/vector-icons/Ionicons';
import { MAX_SEARCH_LENGTH } from '@outfitly/shared';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, TextInput, type TextInputInstance, View } from 'react-native';
import { radii, spacing, ThemedText, typography, useColors } from '../theme';

interface SearchBarProps {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  onFocus: () => void;
  onBlur: () => void;
  /** Shown while typing: leave the field and go back to what showed before. */
  onCancel: (() => void) | null;
  inputRef: RefObject<TextInputInstance | null>;
}

/** The search field: a magnifier, what's typed, ✕ to clear it, and Cancel while typing. */
export function SearchBar({
  value,
  onChangeText,
  onSubmit,
  onFocus,
  onBlur,
  onCancel,
  inputRef,
}: SearchBarProps) {
  const { t } = useTranslation();
  const colors = useColors();
  return (
    <View style={styles.row}>
      <View style={[styles.field, { backgroundColor: colors.surfaceMuted }]}>
        <Ionicons name="search" size={18} color={colors.textMuted} />
        <TextInput
          ref={inputRef}
          testID="search-input"
          value={value}
          onChangeText={onChangeText}
          onSubmitEditing={onSubmit}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder={t('search.placeholder')}
          placeholderTextColor={colors.textMuted}
          accessibilityLabel={t('search.placeholder')}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={MAX_SEARCH_LENGTH}
          style={[typography.body, styles.input, { color: colors.text }]}
        />
        {value ? (
          <Pressable
            testID="search-clear"
            accessibilityRole="button"
            accessibilityLabel={t('search.clear')}
            hitSlop={spacing.sm}
            onPress={() => {
              onChangeText('');
              inputRef.current?.focus();
            }}
          >
            <Ionicons name="close-circle" size={18} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>
      {onCancel ? (
        <Pressable
          testID="search-cancel"
          accessibilityRole="button"
          hitSlop={spacing.sm}
          onPress={onCancel}
        >
          <ThemedText variant="bodyStrong">{t('search.cancel')}</ThemedText>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
  },
  // Vertical padding 0: Android adds its own around the text.
  input: { flex: 1, paddingVertical: 0 },
});
