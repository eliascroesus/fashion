import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { useAuth } from '../../auth/AuthProvider';
import { useMe } from '../../auth/store';
import { Button } from '../../components/button';
import { storage } from '../../lib/storage';
import { Screen, spacing, ThemedText } from '../../theme';

const DEV_MENU_KEY = 'dev.menu';

export default function ProfileScreen() {
  const { t } = useTranslation();
  const me = useMe();
  const auth = useAuth();
  const [devMenu, setDevMenu] = useState(() => storage.getBoolean(DEV_MENU_KEY) ?? false);
  const [busy, setBusy] = useState(false);
  const profile = me?.profiles.find((p) => p.id === me.activeProfileId);

  return (
    <Screen style={styles.screen} testID="screen-profile">
      {/* Long-press the title to show the hidden developer menu. */}
      <Pressable
        delayLongPress={800}
        onLongPress={() => {
          storage.set(DEV_MENU_KEY, !devMenu);
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
            onPress={() => {
              router.push('/sign-up');
            }}
          />
        ) : null}
        {me && auth ? (
          <Button
            variant="secondary"
            label={t('profile.signOut')}
            loading={busy}
            onPress={() => {
              setBusy(true);
              void auth.signOut().finally(() => {
                setBusy(false);
              });
            }}
          />
        ) : null}
      </View>

      {devMenu ? (
        <View style={styles.actions} testID="dev-menu">
          <ThemedText variant="title">{t('profile.devMenu')}</ThemedText>
          {/* What the first save will do in Phase 2: make a guest session, then offer sign-up. */}
          <Button
            variant="secondary"
            label={t('profile.testSave')}
            testID="dev-test-save"
            onPress={() => {
              void (auth?.ensureSession() ?? Promise.resolve()).finally(() => {
                router.push('/sign-up');
              });
            }}
          />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { padding: spacing.xl, paddingTop: spacing.xxxl, gap: spacing.md },
  actions: { gap: spacing.md, marginTop: spacing.lg },
});
