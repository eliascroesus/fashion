import 'i18next';
import type en from './en.json';

// Typed keys: t('tabs.home') autocompletes, and a missing key fails typecheck.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en };
  }
}
