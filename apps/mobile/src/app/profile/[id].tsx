import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApiRequestError } from '../../api';
import { useMe } from '../../auth/store';
import { FeedMessage } from '../../components/feed-message';
import { LookGrid } from '../../components/look-grid';
import { ProfileHeader } from '../../components/profile-header';
import { useImpressions } from '../../feed/use-impressions';
import { useProfile, useProfileLooks } from '../../profiles/queries';
import { radii, Screen, spacing, ThemedText, useColors } from '../../theme';

/** Someone's profile: who they are, their counts, Follow, and their looks as a grid. */
export default function ProfileScreen() {
  const { t } = useTranslation();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const profile = useProfile(id);
  const looks = useProfileLooks(id);
  const isMe = useMe()?.profiles.some((p) => p.id === id) ?? false;
  // Your own looks seen on your own profile don't count (feeds never show them to you either).
  const impressions = useImpressions('profile', !isMe);
  // Deleted (404), versus no connection or a server problem (worth a retry).
  const gone = profile.error instanceof ApiRequestError && profile.error.status === 404;

  let content;
  if (profile.data) {
    const handle = profile.data.handle;
    content = (
      <LookGrid
        list={looks}
        testID="profile-looks"
        cardTestID="profile-card"
        header={<ProfileHeader profile={profile.data} isMe={isMe} />}
        onVisibleChange={impressions.onVisibleChange}
        endMessage={null}
        empty={
          <FeedMessage
            title={t('profilePage.noLooksTitle')}
            body={isMe ? t('profilePage.ownNoLooks') : t('profilePage.noLooks', { handle })}
          />
        }
      />
    );
  } else if (gone) {
    content = <FeedMessage body={t('profilePage.notFound')} />;
  } else if (profile.isError) {
    content = (
      <FeedMessage
        title={t('feed.loadFailedTitle')}
        body={t('feed.loadFailed')}
        action={{ label: t('errors.retry'), onPress: () => void profile.refetch() }}
      />
    );
  } else {
    content = <ActivityIndicator style={styles.loading} color={colors.textMuted} />;
  }

  return (
    <Screen testID="screen-profile-page" style={{ paddingTop: insets.top }}>
      <View style={styles.bar}>
        <Pressable
          testID="profile-back"
          accessibilityRole="button"
          accessibilityLabel={t('look.back')}
          hitSlop={spacing.sm}
          onPress={() => {
            router.back();
          }}
          style={[styles.back, { backgroundColor: colors.surface }]}
        >
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </Pressable>
        {profile.data ? (
          <ThemedText variant="bodyStrong" numberOfLines={1} style={styles.barTitle}>
            {t('profile.handle', { handle: profile.data.handle })}
          </ThemedText>
        ) : null}
        <View style={styles.back} />
      </View>
      <View style={styles.content}>{content}</View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.md,
  },
  back: {
    width: 40,
    height: 40,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  barTitle: { flex: 1, textAlign: 'center' },
  content: { flex: 1, justifyContent: 'center' },
  loading: { paddingVertical: spacing.xl },
});
