import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { radii, spacing, ThemedText, useColors } from '../theme';

/** Where the look's pieces (brand, price, Shop) will be listed; products arrive in Phase 3. */
export function ShopPlaceholder() {
  const { t } = useTranslation();
  const colors = useColors();
  return (
    <View style={[styles.box, { backgroundColor: colors.surfaceMuted }]} testID="shop-placeholder">
      <Ionicons name="pricetags-outline" size={20} color={colors.textMuted} />
      <View style={styles.text}>
        <ThemedText variant="bodyStrong">{t('look.shopTitle')}</ThemedText>
        <ThemedText tone="muted">{t('look.shopSoon')}</ThemedText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.md,
    alignItems: 'flex-start',
  },
  text: { flex: 1, gap: spacing.xxs },
});
