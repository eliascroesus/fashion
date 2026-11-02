import { NativeTabs } from 'expo-router/native-tabs';
import { useTranslation } from 'react-i18next';
import { useColors } from '../../theme';

/** Five icon-only tabs; the icon fills in when its tab is active. */
export default function TabsLayout() {
  const { t } = useTranslation();
  const colors = useColors();
  return (
    <NativeTabs
      backgroundColor={colors.surface}
      iconColor={{ default: colors.tabInactive, selected: colors.tabActive }}
      indicatorColor={colors.surfaceMuted}
      labelVisibilityMode="unlabeled"
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label hidden>{t('tabs.home')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'house', selected: 'house.fill' }}
          md={{ default: 'home', selected: 'home_filled' }}
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="search">
        <NativeTabs.Trigger.Label hidden>{t('tabs.search')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'magnifyingglass', selected: 'magnifyingglass' }}
          md={{ default: 'search', selected: 'search' }}
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="create">
        <NativeTabs.Trigger.Label hidden>{t('tabs.create')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'plus.circle', selected: 'plus.circle.fill' }}
          md={{ default: 'add_circle_outline', selected: 'add_circle' }}
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="saved">
        <NativeTabs.Trigger.Label hidden>{t('tabs.saved')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'bookmark', selected: 'bookmark.fill' }}
          md={{ default: 'bookmark_border', selected: 'bookmark' }}
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="profile">
        <NativeTabs.Trigger.Label hidden>{t('tabs.profile')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'person', selected: 'person.fill' }}
          md={{ default: 'person_outline', selected: 'person' }}
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
