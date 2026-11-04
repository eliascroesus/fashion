import type { Board } from '@outfitly/shared';
import { FlashList } from '@shopify/flash-list';
import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BoardCover } from '../../components/board-cover';
import { Button } from '../../components/button';
import { FeedMessage } from '../../components/feed-message';
import { SHEET_ROW_ICON, SheetRow } from '../../components/sheet-row';
import { showToast } from '../../components/toast';
import { addToBoard, findCard, removeFromBoard } from '../../saves';
import { useBoards } from '../../saves/queries';
import { Screen, spacing, ThemedText, useColors } from '../../theme';

/**
 * Which boards a look is on: tap a board to put the look on it (that saves it
 * too) or take it off. Works offline; "New board" needs a connection.
 */
export default function SaveToBoardSheet() {
  const { t } = useTranslation();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { boards, query } = useBoards(id);

  function toggle(board: Board) {
    if (board.hasLook) {
      removeFromBoard(id, board.id);
      showToast(t('saveToBoard.removedFrom', { name: board.name }));
      return;
    }
    addToBoard(id, board.id, findCard(id));
    showToast(t('saveToBoard.savedTo', { name: board.name }));
  }

  let empty = (
    <ThemedText tone="muted" style={styles.note}>
      {t('saveToBoard.empty')}
    </ThemedText>
  );
  if (query.isPending) {
    empty = <ActivityIndicator style={styles.note} color={colors.textMuted} />;
  } else if (query.isError) {
    empty = (
      <FeedMessage
        body={t('saveToBoard.loadFailed')}
        action={{ label: t('errors.retry'), onPress: () => void query.refetch() }}
      />
    );
  }

  return (
    <Screen style={[styles.sheet, { paddingBottom: insets.bottom }]} testID="save-to-board">
      <View style={styles.header}>
        <ThemedText variant="title" accessibilityRole="header">
          {t('saveToBoard.title')}
        </ThemedText>
      </View>
      <SheetRow
        icon="add"
        label={t('saveToBoard.newBoard')}
        testID="save-to-board-new"
        onPress={() => {
          router.push({ pathname: '/board-name', params: { lookId: id } });
        }}
      />
      <FlashList
        data={boards}
        keyExtractor={(board) => board.id}
        renderItem={({ item }) => (
          <SheetRow
            label={item.name}
            detail={t('screens.saved.lookCount', { count: item.lookCount })}
            checked={item.hasLook ?? false}
            testID="save-to-board-row"
            leading={<BoardCover covers={item.covers} size={SHEET_ROW_ICON} compact />}
            onPress={() => {
              toggle(item);
            }}
          />
        )}
        ListEmptyComponent={empty}
      />
      <View style={styles.footer}>
        <Button
          variant="secondary"
          label={t('saveToBoard.done')}
          testID="save-to-board-done"
          onPress={() => {
            router.back();
          }}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  sheet: { paddingTop: spacing.xl },
  header: { paddingHorizontal: spacing.xl, paddingBottom: spacing.md },
  note: { padding: spacing.xl, textAlign: 'center' },
  footer: { paddingHorizontal: spacing.xl, paddingTop: spacing.md },
});
