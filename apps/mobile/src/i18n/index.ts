import { getLocales } from 'expo-localization';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { FALLBACK_LANGUAGE, pickLanguage, resources } from './resources';

void i18n.use(initReactI18next).init({
  resources,
  lng: pickLanguage(getLocales().map((l) => l.languageCode)),
  fallbackLng: FALLBACK_LANGUAGE,
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
