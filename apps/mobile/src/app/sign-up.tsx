import * as AppleAuthentication from 'expo-apple-authentication';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AccessibilityInfo,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { getAppleIdToken } from '../auth/apple';
import { useAuth } from '../auth/AuthProvider';
import type { EmailMode, SignInResult } from '../auth/flows';
import { Button } from '../components/button';
import { radii, Screen, spacing, ThemedText, typography, useColors, useThemeName } from '../theme';

type Step =
  { kind: 'choose' } | { kind: 'email' } | { kind: 'code'; email: string; mode: EmailMode };
type Action = 'apple' | 'google' | 'email' | 'verify';

/** Must match Supabase → Authentication → Email OTP length. */
const CODE_LENGTH = 6;
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
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appleAvailable, setAppleAvailable] = useState(false);

  useEffect(() => {
    void AppleAuthentication.isAvailableAsync().then(setAppleAvailable);
  }, []);

  // Screen readers announce errors as they appear.
  useEffect(() => {
    if (error) AccessibilityInfo.announceForAccessibility(error);
  }, [error]);

  async function run(
    name: Action,
    action: () => Promise<SignInResult | undefined>,
    errorText: string,
  ) {
    setBusy(name);
    setError(null);
    try {
      const result = await action();
      if (result && result !== 'cancelled') router.back();
    } catch {
      setError(errorText);
    } finally {
      setBusy(null);
    }
  }

  const inputStyle = [
    styles.input,
    { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface },
  ];

  function chooseStep() {
    if (!auth) return null;
    return (
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
            onPress={() => {
              if (busy) return;
              void run(
                'apple',
                async () => {
                  const apple = await getAppleIdToken();
                  if (!apple) return 'cancelled';
                  return auth.signInWithIdToken('apple', apple.token, apple.nonce);
                },
                t('auth.errorGeneric'),
              );
            }}
          />
        ) : null}
        <Button
          variant="secondary"
          label={t('auth.google')}
          loading={busy === 'google'}
          disabled={busy !== null}
          onPress={() => void run('google', () => auth.signInWithGoogle(), t('auth.errorGeneric'))}
        />
        <Button
          variant="secondary"
          label={t('auth.email')}
          disabled={busy !== null}
          onPress={() => {
            setStep({ kind: 'email' });
          }}
        />
      </View>
    );
  }

  function emailStep() {
    if (!auth) return null;
    return (
      <View style={styles.actions}>
        <ThemedText variant="bodyStrong" nativeID="email-label">
          {t('auth.emailLabel')}
        </ThemedText>
        <TextInput
          style={inputStyle}
          accessibilityLabelledBy="email-label"
          value={email}
          onChangeText={setEmail}
          placeholder={t('auth.emailPlaceholder')}
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          textContentType="emailAddress"
        />
        <Button
          label={t('auth.sendCode')}
          loading={busy === 'email'}
          disabled={busy !== null}
          onPress={() => {
            const address = email.trim().toLowerCase();
            if (!EMAIL.test(address)) {
              setError(t('auth.errorEmail'));
              return;
            }
            void run(
              'email',
              async () => {
                const mode = await auth.startEmail(address);
                setStep({ kind: 'code', email: address, mode });
                return undefined;
              },
              t('auth.errorGeneric'),
            );
          }}
        />
        <Button
          variant="secondary"
          label={t('auth.back')}
          disabled={busy !== null}
          onPress={() => {
            setError(null);
            setStep({ kind: 'choose' });
          }}
        />
      </View>
    );
  }

  function codeStep(sentTo: string, mode: EmailMode) {
    if (!auth) return null;
    return (
      <View style={styles.actions}>
        <ThemedText tone="muted">{t('auth.codeSent', { email: sentTo })}</ThemedText>
        <ThemedText variant="bodyStrong" nativeID="code-label">
          {t('auth.codeLabel')}
        </ThemedText>
        <TextInput
          style={inputStyle}
          accessibilityLabelledBy="code-label"
          value={code}
          onChangeText={(value) => {
            setCode(value.replace(/\D/g, '').slice(0, CODE_LENGTH));
          }}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          maxLength={CODE_LENGTH}
        />
        <Button
          label={t('auth.verify')}
          loading={busy === 'verify'}
          disabled={code.length !== CODE_LENGTH || busy !== null}
          onPress={() =>
            void run('verify', () => auth.verifyEmail(sentTo, code, mode), t('auth.errorCode'))
          }
        />
        <Button
          variant="secondary"
          label={t('auth.back')}
          disabled={busy !== null}
          onPress={() => {
            setCode('');
            setError(null);
            setStep({ kind: 'email' });
          }}
        />
      </View>
    );
  }

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

        {!auth ? <ThemedText tone="muted">{t('auth.notConfigured')}</ThemedText> : null}
        {step.kind === 'choose' ? chooseStep() : null}
        {step.kind === 'email' ? emailStep() : null}
        {step.kind === 'code' ? codeStep(step.email, step.mode) : null}

        {error ? (
          <ThemedText accessibilityLiveRegion="polite" style={{ color: colors.danger }}>
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
    ...typography.body,
    minHeight: 48,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
  },
});
