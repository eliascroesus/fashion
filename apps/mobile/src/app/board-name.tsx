import { BOARD_NAME_MAX, boardNameSchema } from '@outfitly/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApiRequestError } from '../api';
import { Button } from '../components/button';
import { showToast } from '../components/toast';
import { addToBoard, findCard } from '../saves';
import { useBoardMutations } from '../saves/queries';
import { radii, Screen, spacing, ThemedText, typography, useColors } from '../theme';

type Params = {
  /** Rename this board (otherwise a new one is made). */
  boardId?: string;
  /** The current name, when renaming. */
  name?: string;
  /** Put this look on the new board (from "Save to board"). */
  lookId?: string;
};

/** Name a new board, or rename one. Needs a connection; the error says so. */
export default function BoardNameSheet() {
  const { t } = useTranslation();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<Params>();
  const renaming = Boolean(params.boardId);
  const [name, setName] = useState(params.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const { create, rename } = useBoardMutations();
  const busy = create.isPending || rename.isPending;
  const valid = boardNameSchema.safeParse(name).success;

  function failed(e: unknown) {
    const tooMany = e instanceof ApiRequestError && e.code === 'conflict';
    setError(tooMany ? t('boardName.tooMany') : t('boardName.failed'));
  }

  function submit() {
    const parsed = boardNameSchema.safeParse(name);
    if (!parsed.success || busy) return;
    setError(null);
    if (params.boardId) {
      rename.mutate(
        { boardId: params.boardId, name: parsed.data },
        {
          onSuccess: () => {
            router.back();
          },
          onError: failed,
        },
      );
      return;
    }
    create.mutate(parsed.data, {
      onSuccess: (board) => {
        const card = params.lookId ? findCard(params.lookId) : undefined;
        if (card) {
          addToBoard(card, board.id);
          showToast(t('saveToBoard.savedTo', { name: board.name }));
        }
        router.back();
      },
      onError: failed,
    });
  }

  return (
    <Screen
      style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]}
      testID="board-name"
    >
      <ThemedText variant="title" accessibilityRole="header">
        {renaming ? t('boardName.renameTitle') : t('boardName.createTitle')}
      </ThemedText>
      <ThemedText variant="bodyStrong" nativeID="board-name-label">
        {t('boardName.label')}
      </ThemedText>
      <TextInput
        testID="board-name-input"
        accessibilityLabelledBy="board-name-label"
        style={[
          styles.input,
          { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface },
        ]}
        value={name}
        onChangeText={setName}
        placeholder={t('boardName.placeholder')}
        placeholderTextColor={colors.textMuted}
        maxLength={BOARD_NAME_MAX}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={submit}
      />
      {error ? (
        <ThemedText accessibilityLiveRegion="polite" style={{ color: colors.danger }}>
          {error}
        </ThemedText>
      ) : null}
      <Button
        testID="board-name-submit"
        label={renaming ? t('boardName.save') : t('boardName.create')}
        loading={busy}
        disabled={!valid}
        onPress={submit}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 0, padding: spacing.xl, gap: spacing.md },
  input: {
    ...typography.body,
    minHeight: 48,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
  },
});
