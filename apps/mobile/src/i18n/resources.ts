import en from './en.json';
import sv from './sv.json';

/** English first; Swedish ready. Every language must have exactly the English keys. */
export const resources = {
  en: { translation: en },
  sv: { translation: sv },
} as const;

export type Language = keyof typeof resources;
export const FALLBACK_LANGUAGE: Language = 'en';

export function pickLanguage(deviceLanguages: readonly (string | null)[]): Language {
  for (const code of deviceLanguages) {
    if (code && code in resources) return code as Language;
  }
  return FALLBACK_LANGUAGE;
}
