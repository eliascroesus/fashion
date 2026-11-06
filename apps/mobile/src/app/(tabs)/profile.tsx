import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../auth/AuthProvider';
import { useMe } from '../../auth/store';
import { Button } from '../../components/button';
import { FeedMessage } from '../../components/feed-message';
import { LookGrid } from '../../components/look-grid';
import { ProfileHeader } from '../../components/profile-header';
import {
  DEV_TOOLS,
  setDevMenu,
  setPretendOffline,
  useDevMenu,
  usePretendOffline,
} from '../../lib/dev';
import { useLastLookOpenMs } from '../../looks/open-timing';
import { useProfile, useProfileLooks } from '../../profiles/queries';
import { outbox, sendWaiting, useWaitingCount } from '../../saves';
import { useLastSuggestMs } from '../../search';
import { showPickerAgain, usePickerTime } from '../../taste';
import { Screen, spacing, ThemedText, useColors } from '../../theme';

/** Before signing out, saves still on the phone get this long to reach the server. */
const SEND_BEFORE_SIGN_OUT_MS = 3_000;

/**
 * Your profile: who you are with your counts, sign in / out, and the looks
 * you post (Phase 4). Long-press your name for the developer menu.
 */
export default function ProfileScreen() {
  const { t } = useTranslation();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const auth = useAuth();
  const devMenu = useDevMenu();
  const pretendOffline = usePretendOffline();
  const waiting = useWaitingCount();
  const lastLookOpenMs = useLastLookOpenMs();
  const lastSuggestMs = useLastSuggestMs();
  const pickerMs = usePickerTime();
  const [busy, setBusy] = useState(false);
  const profile = me?.profiles.find((p) => p.id === me.activeProfileId);
  const profileId = profile?.id ?? null;
  const page = useProfile(profileId);
  const looks = useProfileLooks(profileId);
  const toggleDevMenu = () => {
    setDevMenu(!devMenu);
  };

  const top = page.data ? (
    <ProfileHeader profile={page.data} isMe onLongPressName={toggleDevMenu} />
  ) : (
    // Logged out, or the profile still loading.
    <Pressable testID="profile-title" delayLongPress={800} onLongPress={toggleDevMenu}>
      <ThemedText variant="headline" accessibilityRole="header">
        {profile ? t('profile.handle', { handle: profile.handle }) : t('screens.profile.title')}
      </ThemedText>
    </Pressable>
  );

  const header = (
    <View style={styles.top}>
      {top}
      <ThemedText
        tone="muted"
        testID="profile-status"
        style={page.data ? styles.centered : undefined}
      >
        {!me
          ? t('profile.notSignedIn')
          : me.isAnonymous
            ? t('profile.guest')
            : t('profile.signedIn')}
      </ThemedText>

      <View style={styles.actions}>
        {!me || me.isAnonymous ? (
          <Button
            label={t('profile.signIn')}
            testID="profile-sign-in"
            onPress={() => {
              router.push('/sign-up');
            }}
          />
        ) : null}
        {/* Guests can't sign back in to a guest account, so they get no sign-out button. */}
        {me && !me.isAnonymous && auth ? (
          <Button
            variant="secondary"
            label={t('profile.signOut')}
            testID="profile-sign-out"
            loading={busy}
            onPress={() => {
              setBusy(true);
              const signOut = () => {
                // Local state is cleared even when offline; nothing else to show.
                void auth
                  .signOut()
                  .catch(() => undefined)
                  .finally(() => {
                    setBusy(false);
                  });
              };
              void sendWaiting(SEND_BEFORE_SIGN_OUT_MS).then(() => {
                if (outbox.size === 0) {
                  signOut();
                  return;
                }
                // Offline: what hasn't reached the server would be lost.
                Alert.alert(
                  t('profile.unsyncedTitle'),
                  t('profile.unsyncedBody', { count: outbox.size }),
                  [
                    {
                      text: t('board.cancel'),
                      style: 'cancel',
                      onPress: () => {
                        setBusy(false);
                      },
                    },
                    { text: t('profile.signOut'), style: 'destructive', onPress: signOut },
                  ],
                );
              });
            }}
          />
        ) : null}
      </View>

      {devMenu ? (
        <View style={styles.actions} testID="dev-menu">
          <ThemedText variant="title">{t('profile.devMenu')}</ThemedText>
          <ThemedText tone="muted" testID="dev-waiting">
            {t('profile.waiting', { count: waiting })}
          </ThemedText>
          {lastLookOpenMs === null ? null : (
            <ThemedText tone="muted" testID="dev-look-open">
              {t('profile.lastLookOpen', { ms: lastLookOpenMs })}
            </ThemedText>
          )}
          {lastSuggestMs === null ? null : (
            <ThemedText tone="muted" testID="dev-suggest">
              {t('profile.lastSuggest', { ms: lastSuggestMs })}
            </ThemedText>
          )}
          {pickerMs === undefined ? null : (
            <ThemedText tone="muted" testID="dev-taste-time">
              {t('profile.tasteTime', { seconds: (pickerMs / 1000).toFixed(1) })}
            </ThemedText>
          )}
          {DEV_TOOLS ? (
            <Button
              testID="dev-taste-again"
              variant="secondary"
              label={t('profile.tasteAgain')}
              onPress={showPickerAgain}
            />
          ) : null}
          {DEV_TOOLS ? (
            <View style={styles.row}>
              <ThemedText nativeID="pretend-offline-label">
                {t('profile.pretendOffline')}
              </ThemedText>
              <Switch
                testID="dev-pretend-offline"
                accessibilityLabelledBy="pretend-offline-label"
                value={pretendOffline}
                onValueChange={setPretendOffline}
                trackColor={{ false: colors.surfaceMuted, true: colors.accent }}
                thumbColor={colors.surface}
              />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );

  return (
    <Screen testID="screen-profile" style={{ paddingTop: insets.top }}>
      {profileId ? (
        <LookGrid
          list={looks}
          origin="profile"
          testID="profile-own-looks"
          cardTestID="profile-card"
          header={header}
          endMessage={null}
          empty={
            <FeedMessage title={t('profilePage.noLooksTitle')} body={t('profilePage.ownNoLooks')} />
          }
        />
      ) : (
        <View style={styles.loggedOut}>{header}</View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  top: { paddingHorizontal: spacing.md, paddingTop: spacing.xl, gap: spacing.md },
  loggedOut: { padding: spacing.md },
  centered: { textAlign: 'center' },
  actions: { gap: spacing.md, marginTop: spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
