import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Switch, View } from 'react-native';
import { useAuth } from '../../auth/AuthProvider';
import { useMe } from '../../auth/store';
import { Button } from '../../components/button';
import {
  DEV_TOOLS,
  setDevMenu,
  setPretendOffline,
  useDevMenu,
  usePretendOffline,
} from '../../lib/dev';
import { sendWaiting, useWaitingCount } from '../../saves';
import { Screen, spacing, ThemedText, useColors } from '../../theme';

/** Before signing out, saves still on the phone get this long to reach the server. */
const SEND_BEFORE_SIGN_OUT_MS = 3_000;

export default function ProfileScreen() {
  const { t } = useTranslation();
  const colors = useColors();
  const me = useMe();
  const auth = useAuth();
  const devMenu = useDevMenu();
  const pretendOffline = usePretendOffline();
  const waiting = useWaitingCount();
  const [busy, setBusy] = useState(false);
  const profile = me?.profiles.find((p) => p.id === me.activeProfileId);

  return (
    <Screen style={styles.screen} testID="screen-profile">
      {/* Long-press the title to show the hidden developer menu. */}
      <Pressable
        testID="profile-title"
        delayLongPress={800}
        onLongPress={() => {
          setDevMenu(!devMenu);
        }}
      >
        <ThemedText variant="headline" accessibilityRole="header">
          {profile ? t('profile.handle', { handle: profile.handle }) : t('screens.profile.title')}
        </ThemedText>
      </Pressable>
      <ThemedText tone="muted" testID="profile-status">
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
              // Local state is cleared even when offline; nothing else to show.
              void sendWaiting(SEND_BEFORE_SIGN_OUT_MS)
                .then(() => auth.signOut())
                .catch(() => undefined)
                .finally(() => {
                  setBusy(false);
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
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { padding: spacing.xl, paddingTop: spacing.xxxl, gap: spacing.md },
  actions: { gap: spacing.md, marginTop: spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
