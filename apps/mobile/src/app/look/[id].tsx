import Ionicons from '@expo/vector-icons/Ionicons';
import type { FeedCard, LookDetail } from '@outfitly/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ApiRequestError } from '../../api';
import { ActivityIndicator, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AuthorRow } from '../../components/author-row';
import { FeedMessage } from '../../components/feed-message';
import { LookGrid } from '../../components/look-grid';
import { LookPhotos } from '../../components/look-photos';
import { SaveButton } from '../../components/save-button';
import { ShopPlaceholder } from '../../components/shop-placeholder';
import { markLookShown } from '../../looks/open-timing';
import { useLookDetail, useSimilarLooks } from '../../looks/queries';
import { findCard } from '../../saves';
import { grid, radii, Screen, spacing, ThemedText, useColors } from '../../theme';

/** The look as a grid card (to save it), when it isn't in any cached list. */
function cardOf(look: LookDetail): FeedCard | undefined {
  const [cover] = look.photos;
  if (!cover) return undefined;
  return {
    id: look.id,
    authorId: look.author.id,
    photo: cover,
    itemCount: look.itemCount,
    saved: look.saved,
  };
}

/**
 * A look: its photos (the grid card zooms into the first), who posted it with
 * a Follow button, the caption, where the pieces will be listed (Phase 3), and
 * "More like this" underneath. The screen it was opened from stays as it was,
 * so Back lands on the same spot.
 */
export default function LookScreen() {
  const { t } = useTranslation();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { id } = useLocalSearchParams<{ id: string }>();
  const detail = useLookDetail(id);
  const similar = useSimilarLooks(id);
  // The card from the grid shows at once; the look's own data fills in the rest.
  const card = findCard(id) ?? (detail.data ? cardOf(detail.data) : undefined);
  // Removed or hidden since (404), versus no connection or a server problem (worth a retry).
  const gone = detail.error instanceof ApiRequestError && detail.error.status === 404;
  const retry = { label: t('errors.retry'), onPress: () => void detail.refetch() };

  let body = <ActivityIndicator style={styles.loading} color={colors.textMuted} />;
  if (detail.data) {
    body = (
      <>
        <AuthorRow author={detail.data.author} />
        {detail.data.caption ? (
          <ThemedText testID="look-caption">{detail.data.caption}</ThemedText>
        ) : null}
      </>
    );
  } else if (gone) {
    body = <FeedMessage body={t('look.notFound')} />;
  } else if (detail.isError) {
    body = <FeedMessage body={t('look.loadFailed')} action={retry} />;
  }

  const header = card ? (
    <View style={styles.header}>
      <LookPhotos
        card={card}
        photos={detail.data?.photos ?? [card.photo]}
        width={width}
        onCoverShown={markLookShown}
      />
      <View style={styles.body}>
        {body}
        <ShopPlaceholder />
        <ThemedText variant="title" accessibilityRole="header" style={styles.more}>
          {t('look.moreLikeThis')}
        </ThemedText>
      </View>
    </View>
  ) : null;

  const roundButton = { top: insets.top + spacing.sm, backgroundColor: colors.surface };
  return (
    <Screen testID="screen-look" style={{ paddingTop: insets.top }}>
      {card ? (
        <LookGrid
          list={similar}
          testID="look-page"
          cardTestID="similar-card"
          header={header}
          endMessage={null}
          refreshable={false}
          empty={
            <ThemedText tone="muted" style={styles.none}>
              {t('look.noSimilar')}
            </ThemedText>
          }
        />
      ) : gone ? (
        <FeedMessage body={t('look.notFound')} />
      ) : detail.isError ? (
        <FeedMessage body={t('look.loadFailed')} action={retry} />
      ) : (
        <ActivityIndicator style={styles.loading} color={colors.textMuted} />
      )}
      <Pressable
        testID="look-back"
        accessibilityRole="button"
        accessibilityLabel={t('look.back')}
        hitSlop={spacing.sm}
        onPress={() => {
          router.back();
        }}
        style={[styles.round, styles.back, roundButton]}
      >
        <Ionicons name="chevron-back" size={22} color={colors.text} />
      </Pressable>
      {card ? (
        <View style={[styles.save, { top: insets.top + spacing.sm }]}>
          <SaveButton card={card} size={40} testID="look-save" />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  // The grid pads its content; the photos go edge to edge.
  header: {
    marginHorizontal: -(grid.inset - grid.gap / 2),
    marginTop: -grid.inset,
    marginBottom: spacing.sm,
  },
  body: { padding: spacing.lg, gap: spacing.lg },
  more: { marginTop: spacing.sm },
  loading: { paddingVertical: spacing.xl },
  none: { textAlign: 'center', padding: spacing.xl },
  round: {
    position: 'absolute',
    width: 40,
    height: 40,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  back: { left: spacing.md },
  save: { position: 'absolute', right: spacing.md },
});
