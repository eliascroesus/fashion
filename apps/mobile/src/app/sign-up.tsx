import * as AppleAuthentication from 'expo-apple-authentication';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyboardAvoidingView, Platform, StyleSheet, TextInput, View } from 'react-native';
import { getAppleIdToken } from '../auth/apple';
import { useAuth } from '../auth/AuthProvider';
import type { EmailMode, SignInResult } from '../auth/flows';
import { Button } from '../components/button';
import { radii, Screen, spacing, ThemedText, useColors, useThemeName } from '../theme';

type Step =
  { kind: 'choose' } | { kind: 'email' } | { kind: 'code'; email: string; mode: EmailMode };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The reusable "sign up to save" sheet: Apple, Google or an emailed code. */
export default function SignUpSheet() {
  const { t } = useTranslation();
  const colors = useColors();
  const themeName = useThemeName();
  const auth = useAuth();
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appleAvailable, setAppleAvailable] = useState(false);

  useEffect(() => {
    void AppleAuthentication.isAvailableAsync().then(setAppleAvailable);
  }, []);

  async function run(action: () => Promise<SignInResult | undefined>, errorText: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result && result !== 'cancelled') router.back();
    } catch {
      setError(errorText);
    } finally {
      setBusy(false);
    }
  }

  const inputStyle = [
    styles.input,
    { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface },
  ];

  return (
    <KeyboardAvoidingView
      style={styles.fill}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Screen style={styles.sheet} testID="sign-up-sheet">
        <ThemedText variant="headline" accessibilityRole="header">
          {t('auth.sheetTitle')}
        </ThemedText>
        <ThemedText tone="muted">{t('auth.sheetBody')}</ThemedText>

        {!auth ? (
          <ThemedText tone="muted">{t('auth.notConfigured')}</ThemedText>
        ) : step.kind === 'choose' ? (
          <View style={styles.actions}>
            {appleAvailable ? (
              <AppleAuthentication.AppleAuthenticationButton
                buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
                buttonStyle={
                  themeName === 'dark'
                    ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
                    : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
                }
                cornerRadius={radii.pill}
                style={styles.apple}
                onPress={() =>
                  void run(async () => {
                    const apple = await getAppleIdToken();
                    if (!apple) return 'cancelled';
                    return auth.signInWithIdToken('apple', apple.token, apple.nonce);
                  }, t('auth.errorGeneric'))
                }
              />
            ) : null}
            <Button
              variant="secondary"
              label={t('auth.google')}
              loading={busy}
              onPress={() => void run(() => auth.signInWithGoogle(), t('auth.errorGeneric'))}
            />
            <Button
              variant="secondary"
              label={t('auth.email')}
              disabled={busy}
              onPress={() => {
                setStep({ kind: 'email' });
              }}
            />
          </View>
        ) : step.kind === 'email' ? (
          <View style={styles.actions}>
            <TextInput
              style={inputStyle}
              value={email}
              onChangeText={setEmail}
              placeholder={t('auth.emailPlaceholder')}
              placeholderTextColor={colors.textMuted}
              accessibilityLabel={t('auth.emailLabel')}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              textContentType="emailAddress"
            />
            <Button
              label={t('auth.sendCode')}
              loading={busy}
              onPress={() => {
                const address = email.trim().toLowerCase();
                if (!EMAIL.test(address)) {
                  setError(t('auth.errorEmail'));
                  return;
                }
                void run(async () => {
                  const mode = await auth.startEmail(address);
                  setStep({ kind: 'code', email: address, mode });
                  return undefined;
                }, t('auth.errorGeneric'));
              }}
            />
            <Button
              variant="secondary"
              label={t('auth.back')}
              onPress={() => {
                setError(null);
                setStep({ kind: 'choose' });
              }}
            />
          </View>
        ) : (
          <View style={styles.actions}>
            <ThemedText tone="muted">{t('auth.codeSent', { email: step.email })}</ThemedText>
            <TextInput
              style={inputStyle}
              value={code}
              onChangeText={(value) => {
                setCode(value.replace(/\D/g, '').slice(0, 6));
              }}
              accessibilityLabel={t('auth.codeLabel')}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              maxLength={6}
            />
            <Button
              label={t('auth.verify')}
              loading={busy}
              disabled={code.length !== 6}
              onPress={() =>
                void run(() => auth.verifyEmail(step.email, code, step.mode), t('auth.errorCode'))
              }
            />
            <Button
              variant="secondary"
              label={t('auth.back')}
              onPress={() => {
                setCode('');
                setError(null);
                setStep({ kind: 'email' });
              }}
            />
          </View>
        )}

        {error ? (
          <ThemedText accessibilityRole="alert" style={{ color: colors.danger }}>
            {error}
          </ThemedText>
        ) : null}

        <Button
          variant="secondary"
          label={t('auth.close')}
          onPress={() => {
            router.back();
          }}
        />
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  sheet: { padding: spacing.xl, gap: spacing.lg },
  actions: { gap: spacing.md },
  apple: { height: 48 },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    fontSize: 17,
  },
});
