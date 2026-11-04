import type { Board } from '@outfitly/shared';
import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';
import { grid, radii, useColors } from '../theme';

type Photo = Board['covers'][number];

function Cover({
  photo,
  width,
  height,
}: {
  photo: Photo | undefined;
  width: number;
  height: number;
}) {
  const colors = useColors();
  return (
    <View style={{ width, height, backgroundColor: photo?.dominantColor ?? colors.surfaceMuted }}>
      {photo ? (
        <Image
          source={{ uri: photo.urls[300] }}
          placeholder={{ thumbhash: photo.thumbhash }}
          placeholderContentFit="cover"
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={120}
          style={StyleSheet.absoluteFill}
          accessible={false}
        />
      ) : null}
    </View>
  );
}

/**
 * A board's newest looks: one large photo and two small ones beside it
 * (`size` wide, 3:2), or just the newest as a square thumbnail (`compact`).
 */
export function BoardCover({
  covers,
  size,
  compact = false,
}: {
  covers: Board['covers'];
  size: number;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <View style={[styles.frame, { width: size, height: size }]}>
        <Cover photo={covers[0]} width={size} height={size} />
      </View>
    );
  }
  const height = Math.round((size * 2) / 3);
  const gap = grid.gap / 2;
  const small = Math.round((size - gap) / 3);
  const smallHeight = (height - gap) / 2;
  return (
    <View style={[styles.frame, styles.row, { width: size, height, gap }]}>
      <Cover photo={covers[0]} width={size - small - gap} height={height} />
      <View style={{ gap }}>
        <Cover photo={covers[1]} width={small} height={smallHeight} />
        <Cover photo={covers[2]} width={small} height={smallHeight} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { borderRadius: radii.md, overflow: 'hidden' },
  row: { flexDirection: 'row' },
});
