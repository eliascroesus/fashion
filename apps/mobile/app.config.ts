import { themes } from '@outfitly/ui-tokens';
import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Development builds get their own app id and name, so they can sit next to
 * the store app on the same phone. APP_VARIANT is set per EAS build profile.
 */
const IS_DEV = process.env['APP_VARIANT'] === 'development';
const APP_ID = IS_DEV ? 'com.outfitly.app.dev' : 'com.outfitly.app';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: IS_DEV ? 'Outfitly (Dev)' : 'Outfitly',
  slug: 'outfitly',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  scheme: IS_DEV ? 'outfitly-dev' : 'outfitly',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: APP_ID,
    icon: './assets/expo.icon',
    supportsTablet: false,
    usesAppleSignIn: true,
  },
  android: {
    package: APP_ID,
    adaptiveIcon: {
      backgroundColor: themes.light.background,
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    'expo-router',
    'expo-apple-authentication',
    'expo-web-browser',
    ['expo-localization', { supportedLocales: { ios: ['en', 'sv'], android: ['en', 'sv'] } }],
    [
      'expo-splash-screen',
      {
        backgroundColor: themes.light.background,
        image: './assets/images/splash-icon.png',
        imageWidth: 76,
        dark: { backgroundColor: themes.dark.background },
      },
    ],
    [
      '@sentry/react-native/expo',
      {
        organization: process.env['SENTRY_ORG'],
        project: process.env['SENTRY_PROJECT'],
        url: 'https://de.sentry.io/',
        // Release builds upload source maps only once a Sentry token exists (an EAS secret).
        disableAutoUpload: !process.env['SENTRY_AUTH_TOKEN'],
      },
    ],
  ],
  experiments: {
    reactCompiler: true,
  },
  extra: {
    // Filled in once Elias runs `eas init` (see docs/PROGRESS.md).
    eas: { projectId: process.env['EAS_PROJECT_ID'] },
  },
});
