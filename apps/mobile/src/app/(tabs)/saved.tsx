import Ionicons from '@expo/vector-icons/Ionicons';
import type { Board } from '@outfitly/shared';
import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMe } from '../../auth/store';
import { BoardCover } from '../../components/board-cover';
import { Button } from '../../components/button';
import { FeedMessage } from '../../components/feed-message';
import { LookGrid } from '../../components/look-grid';
import { SegmentedSwitch } from '../../components/segmented-switch';
import { useBoards, useSaves } from '../../saves/queries';
import { grid, radii, Screen, spacing, ThemedText, useColors } from '../../theme';

type Part = 'saves' | 'boards';

/** A guest's saves live only on this phone's guest account until they sign up. */
function GuestNote() {
  const { t } = useTranslation();
  const colors = useColors();
  return (
    <View style={[styles.note, { backgroundColor: colors.surfaceMuted }]} testID="saved-guest-note">
      <ThemedText style={styles.noteText}>{t('screens.saved.guest')}</ThemedText>
      <Button
        label={t('screens.saved.guestAction')}
        onPress={() => {
          router.push('/sign-up');
        }}
      />
    </View>
  );
}

function SavesPart({ guest }: { guest: boolean }) {
  const { t } = useTranslation();
  const loggedIn = useMe() !== null;
  const saves = useSaves();
  return (
    <LookGrid
      list={saves}
      testID="saved-looks"
      cardTestID="saved-card"
      endMessage={null}
      header={guest ? <GuestNote /> : null}
      empty={
        loggedIn ? (
          <FeedMessage
            testID="saved-empty"
            title={t('screens.saved.emptyTitle')}
            body={t('screens.saved.empty')}
          />
        ) : (
          <FeedMessage
            testID="saved-empty"
            title={t('screens.saved.loggedOutTitle')}
            body={t('screens.saved.loggedOut')}
          />
        )
      }
    />
  );
}

type Tile = { kind: 'new' } | { kind: 'board'; board: Board };

function BoardsPart({ guest }: { guest: boolean }) {
  const { t } = useTranslation();
  const colors = useColors();
  const { width } = useWindowDimensions();
  const loggedIn = useMe() !== null;
  const { boards, query } = useBoards();
  const tileWidth = (width - grid.inset * 2 - spacing.md) / 2;
  const tiles: Tile[] = [
    { kind: 'new' },
    ...boards.map((board) => ({ kind: 'board' as const, board })),
  ];

  if (!loggedIn) {
    return (
      <View style={styles.center}>
        <FeedMessage
          title={t('screens.saved.loggedOutTitle')}
          body={t('screens.saved.loggedOut')}
        />
      </View>
    );
  }

  return (
    <FlashList
      testID="saved-boards"
      data={tiles}
      numColumns={2}
      keyExtractor={(tile) => (tile.kind === 'new' ? 'new' : tile.board.id)}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.boards}
      ListHeaderComponent={guest ? <GuestNote /> : null}
      renderItem={({ item }) =>
        item.kind === 'new' ? (
          <Pressable
            testID="saved-new-board"
            accessibilityRole="button"
            accessibilityLabel={t('screens.saved.newBoard')}
            onPress={() => {
              router.push('/board-name');
            }}
            style={styles.tile}
          >
            <View
              style={[
                styles.newBoard,
                { width: tileWidth, height: (tileWidth * 2) / 3, borderColor: colors.border },
              ]}
            >
              <Ionicons name="add" size={32} color={colors.text} />
            </View>
            <ThemedText variant="bodyStrong">{t('screens.saved.newBoard')}</ThemedText>
          </Pressable>
        ) : (
          <Pressable
            testID="saved-board"
            accessibilityRole="button"
            accessibilityLabel={t('screens.saved.boardLabel', {
              name: item.board.name,
              count: item.board.lookCount,
            })}
            onPress={() => {
              router.push({ pathname: '/board/[id]', params: { id: item.board.id } });
            }}
            style={styles.tile}
          >
            <BoardCover covers={item.board.covers} size={tileWidth} />
            <ThemedText variant="bodyStrong" numberOfLines={1}>
              {item.board.name}
            </ThemedText>
            <ThemedText variant="caption" tone="muted">
              {t('screens.saved.lookCount', { count: item.board.lookCount })}
            </ThemedText>
          </Pressable>
        )
      }
      ListFooterComponent={
        query.isPending ? (
          <ActivityIndicator style={styles.loading} color={colors.textMuted} />
        ) : query.isError ? (
          <FeedMessage
            body={t('screens.saved.boardsLoadFailed')}
            action={{ label: t('errors.retry'), onPress: () => void query.refetch() }}
          />
        ) : boards.length === 0 ? (
          <ThemedText tone="muted" style={styles.hint}>
            {t('screens.saved.boardsEmpty')}
          </ThemedText>
        ) : null
      }
    />
  );
}

/** Saved: everything saved (newest first), and boards. */
export default function SavedScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const guest = useMe()?.isAnonymous ?? false;
  const [part, setPart] = useState<Part>('saves');
  return (
    <Screen testID="screen-saved" style={{ paddingTop: insets.top }}>
      <SegmentedSwitch
        options={[
          { value: 'saves', label: t('screens.saved.saves') },
          { value: 'boards', label: t('screens.saved.boards') },
        ]}
        value={part}
        onChange={setPart}
        testIDPrefix="saved-switch"
      />
      {part === 'saves' ? <SavesPart guest={guest} /> : <BoardsPart guest={guest} />}
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center' },
  note: {
    margin: grid.gap / 2,
    marginBottom: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.md,
    gap: spacing.md,
  },
  noteText: { textAlign: 'center' },
  boards: { paddingHorizontal: grid.inset, paddingTop: spacing.md, paddingBottom: spacing.xxxl },
  tile: { padding: spacing.md / 2, gap: spacing.xs, marginBottom: spacing.md },
  newBoard: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loading: { paddingVertical: spacing.xxxl },
  hint: { textAlign: 'center', padding: spacing.xl },
});
