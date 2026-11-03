import Ionicons from '@expo/vector-icons/Ionicons';
import type { LookAuthor } from '@outfitly/shared';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { useMe } from '../auth/store';
import { setFollowing, useIsFollowing } from '../saves';
import { radii, spacing, ThemedText, useColors } from '../theme';

const AVATAR = 40;

/**
 * Who posted the look: their photo (or first letter), name and @handle, and
 * a Follow button. Logged out, Follow opens the sign-up sheet (following
 * never makes a guest account; only the first save does).
 */
export function AuthorRow({ author }: { author: LookAuthor }) {
  const { t } = useTranslation();
  const colors = useColors();
  const me = useMe();
  const following = useIsFollowing(author.id, author.isFollowing);
  const name = author.displayName ?? author.handle;
  const isMe = me?.profiles.some((p) => p.id === author.id) ?? false;

  return (
    <View style={styles.row} testID="look-author">
      <View style={[styles.avatar, { backgroundColor: colors.surfaceMuted }]} accessible={false}>
        {author.avatar ? (
          <Image
            source={{ uri: author.avatar.urls[300] }}
            placeholder={{ thumbhash: author.avatar.thumbhash }}
            contentFit="cover"
            cachePolicy="memory-disk"
            style={StyleSheet.absoluteFill}
            accessible={false}
          />
        ) : (
          <ThemedText variant="bodyStrong">{name.charAt(0).toUpperCase()}</ThemedText>
        )}
      </View>
      <View style={styles.names} accessible accessibilityLabel={t('look.authorLabel', { name })}>
        <View style={styles.nameLine}>
          <ThemedText variant="bodyStrong" numberOfLines={1}>
            {name}
          </ThemedText>
          {author.isVerified ? (
            <Ionicons name="checkmark-circle" size={14} color={colors.accent} />
          ) : null}
        </View>
        {author.displayName ? (
          <ThemedText variant="caption" tone="muted" numberOfLines={1}>
            {t('profile.handle', { handle: author.handle })}
          </ThemedText>
        ) : null}
      </View>
      {isMe ? null : (
        <Pressable
          testID="look-follow"
          accessibilityRole="button"
          accessibilityLabel={
            following ? t('look.unfollowLabel', { name }) : t('look.followLabel', { name })
          }
          accessibilityState={{ selected: following }}
          hitSlop={spacing.sm}
          onPress={() => {
            if (!me) {
              router.push('/sign-up');
              return;
            }
            setFollowing(author.id, !following);
          }}
          style={({ pressed }) => [
            styles.follow,
            following
              ? { backgroundColor: colors.surface, borderColor: colors.border }
              : { backgroundColor: colors.text, borderColor: colors.text },
            { opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <ThemedText
            variant="bodyStrong"
            style={{ color: following ? colors.text : colors.background }}
          >
            {following ? t('look.following') : t('look.follow')}
          </ThemedText>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatar: {
    width: AVATAR,
    height: AVATAR,
    borderRadius: radii.pill,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  names: { flex: 1, gap: spacing.xxs },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  follow: {
    minHeight: 36,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
