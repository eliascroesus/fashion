import type { ProfileBrief } from '@outfitly/shared';
import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';
import { radii, ThemedText, useColors } from '../theme';

/** The name people see: the display name, or the handle when there's none. */
export function nameOf(profile: Pick<ProfileBrief, 'displayName' | 'handle'>): string {
  return profile.displayName?.trim() ? profile.displayName : profile.handle;
}

/** A profile photo in a circle, or the name's first letter when there is none. */
export function Avatar({
  photo,
  name,
  size,
}: {
  photo: ProfileBrief['avatar'];
  name: string;
  size: number;
}) {
  const colors = useColors();
  // The first character as people see it (an emoji is one, not half of one).
  const initial = (Array.from(name)[0] ?? '').toUpperCase();
  return (
    <View
      style={[styles.avatar, { width: size, height: size, backgroundColor: colors.surfaceMuted }]}
      accessible={false}
    >
      {photo ? (
        <Image
          source={{ uri: photo.urls[300] }}
          placeholder={{ thumbhash: photo.thumbhash }}
          contentFit="cover"
          cachePolicy="memory-disk"
          style={StyleSheet.absoluteFill}
          accessible={false}
        />
      ) : (
        <ThemedText variant={size >= 64 ? 'headline' : 'bodyStrong'}>{initial}</ThemedText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    borderRadius: radii.pill,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
