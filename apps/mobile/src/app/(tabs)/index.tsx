import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMe } from '../../auth/store';
import { FeedGrid } from '../../components/feed-grid';
import { FeedMessage } from '../../components/feed-message';
import { FeedSwitch } from '../../components/feed-switch';
import type { FeedKind } from '../../feed/keys';
import { Screen } from '../../theme';

/**
 * Home: For You or Following. Following is only made once it's opened, and
 * both then stay mounted (one hidden) so each keeps its scroll position.
 */
export default function HomeScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const hasProfile = Boolean(useMe()?.activeProfileId);
  const [kind, setKind] = useState<FeedKind>('for-you');
  const [followingOpened, setFollowingOpened] = useState(false);

  return (
    <Screen testID="screen-home" style={{ paddingTop: insets.top }}>
      <FeedSwitch
        value={kind}
        onChange={(next) => {
          setKind(next);
          if (next === 'following') setFollowingOpened(true);
        }}
      />
      <View style={[styles.feed, kind !== 'for-you' && styles.hidden]}>
        <FeedGrid
          kind="for-you"
          active={kind === 'for-you'}
          testID="feed-for-you"
          empty={<FeedMessage title={t('feed.emptyTitle')} body={t('feed.empty')} />}
        />
      </View>
      {followingOpened ? (
        <View style={[styles.feed, kind !== 'following' && styles.hidden]}>
          {hasProfile ? (
            <FeedGrid
              kind="following"
              active={kind === 'following'}
              testID="feed-following"
              empty={
                <FeedMessage
                  title={t('feed.followingEmptyTitle')}
                  body={t('feed.followingEmpty')}
                />
              }
            />
          ) : (
            <View style={styles.center}>
              <FeedMessage
                testID="following-log-in"
                title={t('feed.followingLoggedOutTitle')}
                body={t('feed.followingLoggedOut')}
                action={{
                  label: t('profile.signIn'),
                  onPress: () => {
                    router.push('/sign-up');
                  },
                }}
              />
            </View>
          )}
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  feed: { flex: 1 },
  hidden: { display: 'none' },
  center: { flex: 1, justifyContent: 'center' },
});
