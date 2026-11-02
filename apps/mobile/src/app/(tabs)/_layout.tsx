import Ionicons from '@expo/vector-icons/Ionicons';
import { NativeTabs } from 'expo-router/native-tabs';
import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import type { SFSymbol } from 'expo-symbols';
import { useColors } from '../../theme';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

interface Tab {
  route: 'index' | 'search' | 'create' | 'saved' | 'profile';
  label: 'tabs.home' | 'tabs.search' | 'tabs.create' | 'tabs.saved' | 'tabs.profile';
  testID: string;
  /** iOS: SF Symbols, outline → filled. */
  sf: { default: SFSymbol; selected: SFSymbol };
  /** Android: Ionicons, which has real outline/filled pairs. */
  ionicon: { default: IoniconName; selected: IoniconName };
}

const TABS: Tab[] = [
  {
    route: 'index',
    label: 'tabs.home',
    testID: 'tab-home',
    sf: { default: 'house', selected: 'house.fill' },
    ionicon: { default: 'home-outline', selected: 'home' },
  },
  {
    route: 'search',
    label: 'tabs.search',
    testID: 'tab-search',
    sf: { default: 'magnifyingglass', selected: 'magnifyingglass' },
    ionicon: { default: 'search-outline', selected: 'search' },
  },
  {
    route: 'create',
    label: 'tabs.create',
    testID: 'tab-create',
    sf: { default: 'plus.circle', selected: 'plus.circle.fill' },
    ionicon: { default: 'add-circle-outline', selected: 'add-circle' },
  },
  {
    route: 'saved',
    label: 'tabs.saved',
    testID: 'tab-saved',
    sf: { default: 'bookmark', selected: 'bookmark.fill' },
    ionicon: { default: 'bookmark-outline', selected: 'bookmark' },
  },
  {
    route: 'profile',
    label: 'tabs.profile',
    testID: 'tab-profile',
    sf: { default: 'person', selected: 'person.fill' },
    ionicon: { default: 'person-outline', selected: 'person' },
  },
];

/**
 * Five icon-only tabs; the icon fills in when its tab is active. Labels are
 * hidden on screen but still read out by VoiceOver/TalkBack.
 */
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
      {TABS.map((tab) => (
        <NativeTabs.Trigger
          key={tab.route}
          name={tab.route}
          accessibilityLabel={t(tab.label)}
          testID={tab.testID}
        >
          <NativeTabs.Trigger.Label hidden>{t(tab.label)}</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon
            sf={tab.sf}
            src={{
              default: (
                <NativeTabs.Trigger.VectorIcon family={Ionicons} name={tab.ionicon.default} />
              ),
              selected: (
                <NativeTabs.Trigger.VectorIcon family={Ionicons} name={tab.ionicon.selected} />
              ),
            }}
          />
        </NativeTabs.Trigger>
      ))}
    </NativeTabs>
  );
}
