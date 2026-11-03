import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMe } from '../../auth/store';
import { SheetRow } from '../../components/sheet-row';
import { showToast } from '../../components/toast';
import { findCard, seeLess, setSaved } from '../../saves';
import { Screen, spacing } from '../../theme';

/** Press and hold a card: save it to a board, or see less like it. */
export default function LookMenuSheet() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const hasLogin = useMe() !== null;
  const { id } = useLocalSearchParams<{ id: string }>();

  return (
    <Screen
      style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]}
      testID="look-menu"
    >
      <SheetRow
        icon="albums-outline"
        label={t('lookMenu.saveToBoard')}
        testID="look-menu-save-to-board"
        onPress={() => {
          const card = findCard(id);
          if (!card) {
            router.back();
          } else if (!hasLogin) {
            // The first save while logged out is the sign-up moment, not a board picker.
            setSaved(card, true, (href) => {
              router.replace(href);
            });
          } else {
            router.replace({ pathname: '/save-to-board/[id]', params: { id } });
          }
        }}
      />
      <SheetRow
        icon="eye-off-outline"
        label={t('lookMenu.seeLess')}
        testID="look-menu-see-less"
        onPress={() => {
          seeLess(id);
          router.back();
          showToast(t('lookMenu.seeLessDone'));
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 0, paddingTop: spacing.xl, gap: spacing.xs },
});
