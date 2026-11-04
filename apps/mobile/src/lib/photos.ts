import { Platform } from 'react-native';

/**
 * expo-image's `allowDownscaling` for our photos, which come in fixed sizes
 * (300/600/1080) close to the size they're shown at. On iOS a slightly bigger
 * photo would be redrawn smaller on the main thread each time it's shown
 * (dropped frames while scrolling and zooming), so the GPU scales it instead.
 * Android shrinks it while decoding, off the main thread, and keeps the
 * smaller copy in memory: leave that on.
 */
export const DOWNSCALE_PHOTOS = Platform.OS !== 'ios';
