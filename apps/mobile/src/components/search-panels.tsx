import Ionicons from '@expo/vector-icons/Ionicons';
import { type LookTag, type Style, STYLES, type Suggestions } from '@outfitly/shared';
import type { ComponentProps, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { spacing, ThemedText, useColors } from '../theme';
import { Avatar, nameOf } from './avatar';
import { Chip } from './chip';

const STYLE_SET = new Set<string>(STYLES);
function isStyle(tag: LookTag): tag is Style {
  return STYLE_SET.has(tag);
}

/** Taps on a row don't first close the keyboard; dragging the list does. */
const LIST_PROPS = {
  keyboardShouldPersistTaps: 'handled',
  keyboardDismissMode: 'on-drag',
} as const;

function Row({
  icon,
  label,
  onPress,
  testID,
  accessibilityLabel,
  end,
}: {
  icon: ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
  testID: string;
  accessibilityLabel?: string;
  end?: ReactNode;
}) {
  const colors = useColors();
  return (
    <View style={styles.row}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        onPress={onPress}
        style={({ pressed }) => [styles.rowMain, { opacity: pressed ? 0.6 : 1 }]}
      >
        <Ionicons name={icon} size={18} color={colors.textMuted} />
        <ThemedText numberOfLines={1} style={styles.rowText}>
          {label}
        </ThemedText>
      </Pressable>
      {end}
    </View>
  );
}

interface IdlePanelProps {
  recent: readonly string[];
  popular: readonly LookTag[] | undefined;
  popularLoading: boolean;
  onSearch: (text: string) => void;
  onRemoveRecent: (text: string) => void;
  onClearRecent: () => void;
}

/** Before typing: recent searches on this phone, and the popular tags as chips. */
export function IdlePanel({
  recent,
  popular,
  popularLoading,
  onSearch,
  onRemoveRecent,
  onClearRecent,
}: IdlePanelProps) {
  const { t } = useTranslation();
  const colors = useColors();
  const label = (tag: LookTag) => (isStyle(tag) ? t(`styles.${tag}`) : t(`tags.${tag}`));
  return (
    <ScrollView {...LIST_PROPS} contentContainerStyle={styles.panel} testID="search-idle">
      {recent.length > 0 ? (
        <View style={styles.section}>
          <View style={styles.heading}>
            <ThemedText variant="title" accessibilityRole="header">
              {t('search.recent')}
            </ThemedText>
            <Pressable
              testID="search-recent-clear"
              accessibilityRole="button"
              hitSlop={spacing.sm}
              onPress={onClearRecent}
            >
              <ThemedText tone="muted">{t('search.clearRecent')}</ThemedText>
            </Pressable>
          </View>
          {recent.map((text) => (
            <Row
              key={text}
              icon="time-outline"
              label={text}
              testID="search-recent"
              onPress={() => {
                onSearch(text);
              }}
              end={
                <Pressable
                  testID="search-recent-remove"
                  accessibilityRole="button"
                  accessibilityLabel={t('search.removeRecent', { text })}
                  hitSlop={spacing.sm}
                  onPress={() => {
                    onRemoveRecent(text);
                  }}
                >
                  <Ionicons name="close" size={18} color={colors.textMuted} />
                </Pressable>
              }
            />
          ))}
        </View>
      ) : null}
      <View style={styles.section}>
        <ThemedText variant="title" accessibilityRole="header">
          {t('search.popular')}
        </ThemedText>
        {popularLoading ? <ActivityIndicator color={colors.textMuted} /> : null}
        <View style={styles.chips}>
          {(popular ?? []).map((tag) => (
            <Chip
              key={tag}
              label={label(tag)}
              testID="search-chip"
              onPress={() => {
                onSearch(label(tag));
              }}
            />
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

interface SuggestionsPanelProps {
  text: string;
  suggestions: Suggestions | undefined;
  failed: boolean;
  onSearch: (text: string) => void;
  onOpenProfile: (profileId: string) => void;
}

/** While typing: search for what's typed, completed searches, and people. */
export function SuggestionsPanel({
  text,
  suggestions,
  failed,
  onSearch,
  onOpenProfile,
}: SuggestionsPanelProps) {
  const { t } = useTranslation();
  const terms = (suggestions?.terms ?? []).filter((term) => term !== text.toLowerCase());
  const people = suggestions?.profiles ?? [];
  return (
    <ScrollView {...LIST_PROPS} contentContainerStyle={styles.panel} testID="search-suggestions">
      <Row
        icon="search"
        label={t('search.searchFor', { text })}
        testID="search-submit-row"
        onPress={() => {
          onSearch(text);
        }}
      />
      {terms.map((term) => (
        <Row
          key={term}
          icon="search"
          label={term}
          testID="search-suggestion"
          onPress={() => {
            onSearch(term);
          }}
        />
      ))}
      {failed ? (
        <ThemedText tone="muted" style={styles.note}>
          {t('search.loadFailed')}
        </ThemedText>
      ) : null}
      {people.length > 0 ? (
        <View style={styles.section}>
          <ThemedText variant="title" accessibilityRole="header">
            {t('search.people')}
          </ThemedText>
          {people.map((person) => {
            const name = nameOf(person);
            return (
              <Pressable
                key={person.id}
                testID="search-person"
                accessibilityRole="button"
                accessibilityLabel={t('profilePage.openLabel', { name })}
                onPress={() => {
                  onOpenProfile(person.id);
                }}
                style={({ pressed }) => [styles.person, { opacity: pressed ? 0.6 : 1 }]}
              >
                <Avatar photo={person.avatar} name={name} size={40} />
                <View style={styles.personNames}>
                  <ThemedText variant="bodyStrong" numberOfLines={1}>
                    {name}
                  </ThemedText>
                  <ThemedText variant="caption" tone="muted" numberOfLines={1}>
                    {t('profile.handle', { handle: person.handle })}
                  </ThemedText>
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  panel: { paddingHorizontal: spacing.md, paddingBottom: spacing.xxxl, gap: spacing.lg },
  section: { gap: spacing.sm },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 44 },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 44 },
  rowText: { flex: 1 },
  note: { paddingVertical: spacing.sm },
  person: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 52 },
  personNames: { flex: 1, gap: spacing.xxs },
});
