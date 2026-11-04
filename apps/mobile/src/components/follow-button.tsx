import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet } from 'react-native';
import { useMe } from '../auth/store';
import { setFollowing, useIsFollowing } from '../saves';
import { radii, spacing, ThemedText, useColors } from '../theme';

interface FollowButtonProps {
  profileId: string;
  /** Their name, for screen readers. */
  name: string;
  /** Whether the server said the viewer follows them (a waiting follow/unfollow wins). */
  isFollowing: boolean;
  testID: string;
}

/**
 * Follow / Following. Logged out it opens the sign-up sheet (following never
 * makes a guest account; only the first save does).
 */
export function FollowButton({ profileId, name, isFollowing, testID }: FollowButtonProps) {
  const { t } = useTranslation();
  const colors = useColors();
  const me = useMe();
  const following = useIsFollowing(profileId, isFollowing);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      // One label; whether you follow is the "selected" state (announced once).
      accessibilityLabel={t('look.followLabel', { name })}
      accessibilityState={{ selected: following }}
      hitSlop={spacing.sm}
      onPress={() => {
        if (!me) {
          router.push('/sign-up');
          return;
        }
        setFollowing(profileId, !following);
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
  );
}

const styles = StyleSheet.create({
  follow: {
    minHeight: 36,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
