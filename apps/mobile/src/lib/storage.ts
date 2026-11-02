import { createMMKV } from 'react-native-mmkv';

/** Fast on-device key-value storage (cached feed, settings). */
export const storage = createMMKV({ id: 'outfitly' });
