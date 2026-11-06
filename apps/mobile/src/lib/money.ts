import { getLocales } from 'expo-localization';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { moneyLocale } from '../looks/shop';

/** The locale prices are written in (the app's language, the phone's region). */
export function useMoneyLocale(): string {
  const { i18n } = useTranslation();
  return useMemo(() => moneyLocale(i18n.language, getLocales().at(0)?.regionCode), [i18n.language]);
}
