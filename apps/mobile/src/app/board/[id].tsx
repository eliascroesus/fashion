import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FeedMessage } from '../../components/feed-message';
import { LookGrid } from '../../components/look-grid';
import { showToast } from '../../components/toast';
import { useBoardLooks, useBoardMutations, useBoards } from '../../saves/queries';
import { radii, Screen, spacing, ThemedText, useColors } from '../../theme';

/** One board: its looks, newest first, and the options to rename or delete it. */
export default function BoardScreen() {
  const { t } = useTranslation();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const board = useBoards().boards.find((b) => b.id === id);
  const looks = useBoardLooks(id);
  const { remove } = useBoardMutations();

  function confirmDelete(name: string) {
    Alert.alert(t('board.deleteTitle', { name }), t('board.deleteBody'), [
      { text: t('board.cancel'), style: 'cancel' },
      {
        text: t('board.deleteConfirm'),
        style: 'destructive',
        onPress: () => {
          remove.mutate(id, {
            onSuccess: () => {
              router.back();
            },
            onError: () => {
              showToast(t('board.failed'));
            },
          });
        },
      },
    ]);
  }

  function openOptions() {
    if (!board) return;
    Alert.alert(board.name, undefined, [
      {
        text: t('board.rename'),
        onPress: () => {
          router.push({ pathname: '/board-name', params: { boardId: id, name: board.name } });
        },
      },
      {
        text: t('board.delete'),
        style: 'destructive',
        onPress: () => {
          confirmDelete(board.name);
        },
      },
      { text: t('board.cancel'), style: 'cancel' },
    ]);
  }

  const roundButton = [styles.round, { backgroundColor: colors.surface }];
  return (
    <Screen testID="screen-board" style={{ paddingTop: insets.top }}>
      <View style={styles.header}>
        <Pressable
          testID="board-back"
          accessibilityRole="button"
          accessibilityLabel={t('look.back')}
          hitSlop={spacing.sm}
          onPress={() => {
            router.back();
          }}
          style={roundButton}
        >
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </Pressable>
        <ThemedText
          variant="title"
          accessibilityRole="header"
          numberOfLines={1}
          style={styles.title}
        >
          {board?.name ?? ''}
        </ThemedText>
        <Pressable
          testID="board-options"
          accessibilityRole="button"
          accessibilityLabel={t('board.options')}
          hitSlop={spacing.sm}
          disabled={!board || remove.isPending}
          onPress={openOptions}
          style={roundButton}
        >
          <Ionicons name="ellipsis-horizontal" size={20} color={colors.text} />
        </Pressable>
      </View>
      <LookGrid
        list={looks}
        testID="board-looks"
        cardTestID="board-card"
        endMessage={null}
        empty={<FeedMessage title={t('board.emptyTitle')} body={t('board.empty')} />}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  title: { flex: 1, textAlign: 'center' },
  round: {
    width: 40,
    height: 40,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
