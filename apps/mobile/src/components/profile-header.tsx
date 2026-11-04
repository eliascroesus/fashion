import Ionicons from '@expo/vector-icons/Ionicons';
import type { ProfilePage } from '@outfitly/shared';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { useIsFollowing } from '../saves';
import { spacing, ThemedText, useColors } from '../theme';
import { Avatar, nameOf } from './avatar';
import { FollowButton } from './follow-button';

const AVATAR = 88;

function Count({ value, label, testID }: { value: number; label: string; testID: string }) {
  const { t } = useTranslation();
  return (
    <View
      style={styles.count}
      testID={testID}
      accessible
      accessibilityLabel={t('profilePage.countLabel', { count: value, label })}
    >
      <ThemedText variant="title">{value}</ThemedText>
      <ThemedText variant="caption" tone="muted">
        {label}
      </ThemedText>
    </View>
  );
}

interface ProfileHeaderProps {
  profile: ProfilePage;
  /** The viewer's own profile: no Follow button. */
  isMe: boolean;
  /** Own Profile tab: long-pressing the name shows the developer menu. */
  onLongPressName?: () => void;
}

/**
 * The top of a profile: photo, name, @handle, looks / followers / following,
 * and Follow. A follow still on its way already counts.
 */
export function ProfileHeader({ profile, isMe, onLongPressName }: ProfileHeaderProps) {
  const { t } = useTranslation();
  const colors = useColors();
  const name = nameOf(profile);
  const following = useIsFollowing(profile.id, profile.isFollowing);
  const pending = following === profile.isFollowing ? 0 : following ? 1 : -1;
  const followers = Math.max(0, profile.counts.followers + pending);

  const title = (
    <View style={styles.nameLine}>
      <ThemedText variant="headline" accessibilityRole="header" numberOfLines={1}>
        {name}
      </ThemedText>
      {profile.isVerified ? (
        <Ionicons name="checkmark-circle" size={20} color={colors.accent} />
      ) : null}
    </View>
  );

  return (
    <View style={styles.header} testID="profile-header">
      <Avatar photo={profile.avatar} name={name} size={AVATAR} />
      {onLongPressName ? (
        <Pressable testID="profile-title" delayLongPress={800} onLongPress={onLongPressName}>
          {title}
        </Pressable>
      ) : (
        title
      )}
      {name !== profile.handle ? (
        <ThemedText tone="muted" testID="profile-handle">
          {t('profile.handle', { handle: profile.handle })}
        </ThemedText>
      ) : null}
      <View style={styles.counts}>
        <Count
          value={profile.counts.looks}
          label={t('profilePage.looks', { count: profile.counts.looks })}
          testID="profile-count-looks"
        />
        <Count
          value={followers}
          label={t('profilePage.followers', { count: followers })}
          testID="profile-count-followers"
        />
        <Count
          value={profile.counts.following}
          label={t('profilePage.following')}
          testID="profile-count-following"
        />
      </View>
      {isMe ? null : (
        <FollowButton
          profileId={profile.id}
          name={name}
          isFollowing={profile.isFollowing}
          testID="profile-follow"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.lg },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  counts: { flexDirection: 'row', gap: spacing.xxl, marginVertical: spacing.sm },
  count: { alignItems: 'center', minWidth: 64 },
});
