import Ionicons from '@expo/vector-icons/Ionicons';
import type { LookAuthor } from '@outfitly/shared';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { useMe } from '../auth/store';
import { spacing, ThemedText, useColors } from '../theme';
import { Avatar, nameOf } from './avatar';
import { FollowButton } from './follow-button';

const AVATAR = 40;

/**
 * Who posted the look: their photo (or first letter), name and @handle
 * (tap for their profile), and a Follow button.
 */
export function AuthorRow({ author }: { author: LookAuthor }) {
  const { t } = useTranslation();
  const colors = useColors();
  const me = useMe();
  const name = nameOf(author);
  const isMe = me?.profiles.some((p) => p.id === author.id) ?? false;

  return (
    <View style={styles.row} testID="look-author">
      <Pressable
        testID="look-author-open"
        style={({ pressed }) => [styles.who, { opacity: pressed ? 0.7 : 1 }]}
        accessibilityRole="button"
        accessibilityLabel={t('look.authorLabel', { name })}
        accessibilityHint={t('profilePage.openLabel', { name })}
        onPress={() => {
          router.push({ pathname: '/profile/[id]', params: { id: author.id } });
        }}
      >
        <Avatar photo={author.avatar} name={name} size={AVATAR} />
        <View style={styles.names}>
          <View style={styles.nameLine}>
            <ThemedText variant="bodyStrong" numberOfLines={1}>
              {name}
            </ThemedText>
            {author.isVerified ? (
              <Ionicons name="checkmark-circle" size={14} color={colors.accent} />
            ) : null}
          </View>
          {name !== author.handle ? (
            <ThemedText variant="caption" tone="muted" numberOfLines={1}>
              {t('profile.handle', { handle: author.handle })}
            </ThemedText>
          ) : null}
        </View>
      </Pressable>
      {isMe ? null : (
        <FollowButton
          profileId={author.id}
          name={name}
          isFollowing={author.isFollowing}
          testID="look-follow"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  who: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  names: { flex: 1, gap: spacing.xxs },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
});
