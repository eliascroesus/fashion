import type { Config } from '../config.ts';
import { EmbedderClient } from './embedder.ts';
import { GeminiClient } from './gemini.ts';
import type { PhotoAiDeps } from './photos.ts';

export type PhotoAiClients = Omit<PhotoAiDeps, 'db' | 'storage'>;

/** Gemini and the fingerprint service from the settings; each is off (null) without its key. */
export function photoAiClients(config: Config): PhotoAiClients {
  return {
    gemini: config.GEMINI_API_KEY
      ? new GeminiClient({
          apiKey: config.GEMINI_API_KEY,
          model: config.GEMINI_MODEL,
          thinkingLevel: config.GEMINI_THINKING_LEVEL,
          mediaResolution: config.GEMINI_MEDIA_RESOLUTION,
        })
      : null,
    embedder:
      config.EMBEDDER_URL && config.EMBEDDER_SECRET
        ? new EmbedderClient({ url: config.EMBEDDER_URL, secret: config.EMBEDDER_SECRET })
        : null,
    dailyCapMicros: Math.round(config.AI_DAILY_CAP_USD * 1_000_000),
  };
}
