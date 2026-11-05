// Reads looks' photos with Gemini (garments, sentence, search words, safety flags), fingerprints
// them, and writes a page that draws the boxes on each photo, to check by eye. From the repo root:
//   pnpm ai:spot-check                          50 of @outfitly.picks' looks
//   pnpm ai:spot-check --count 125 --author outfitly.picks
//   pnpm ai:spot-check --again                  read them again (costs again)
//   pnpm ai:spot-check --out ./somewhere        page folder (default ~/Downloads/outfitly-spot-check)
// Photos already read are not sent again, so running it twice only redraws the page.
// Needs GEMINI_API_KEY (and EMBEDDER_URL + EMBEDDER_SECRET for fingerprints) in .env.
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  aiCalls,
  and,
  asc,
  createDb,
  type Db,
  desc,
  eq,
  garments,
  inArray,
  isNull,
  lookMedia,
  looks,
  media,
  profiles,
} from '@outfitly/db';
import { photoAiClients } from '../src/ai/clients.ts';
import { EmbedderError } from '../src/ai/embedder.ts';
import { GeminiError } from '../src/ai/gemini.ts';
import {
  fingerprintPhoto,
  type PhotoAiDeps,
  SpendCapReachedError,
  SpotAnswerError,
  spotPhoto,
} from '../src/ai/photos.ts';
import { SPOT_PROMPT_VERSION } from '../src/ai/spot.ts';
import { loadConfig, r2Config } from '../src/config.ts';
import { R2Storage } from '../src/storage.ts';
import { type PageData, type PagePhoto, renderPage } from './spot-check/page.ts';

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}
const count = Number(option('count') ?? 50);
const handle = (option('author') ?? 'outfitly.picks').replace(/^@/, '');
const again = args.includes('--again');
const outDir = option('out')
  ? resolve(process.env['INIT_CWD'] ?? process.cwd(), option('out') ?? '')
  : join(homedir(), 'Downloads', 'outfitly-spot-check');
if (!Number.isInteger(count) || count < 1) {
  console.error('--count must be a whole number of photos.');
  process.exit(1);
}

const config = loadConfig();
const ai = photoAiClients(config);
if (!ai.gemini) {
  console.error(
    'No GEMINI_API_KEY in .env: add the key from Google AI Studio (billing on), then run again.',
  );
  process.exit(1);
}
if (!ai.embedder) console.log('No EMBEDDER_URL / EMBEDDER_SECRET: reading only, no fingerprints.');

const db = createDb(config.DATABASE_URL, { caCert: config.DATABASE_CA_CERT });
const storage = new R2Storage(r2Config(config));
const deps: PhotoAiDeps = { db, storage, ...ai };

/** Tries again (after 5 s, then 10 s) when the error says it's worth it. */
async function withRetries<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      const retryable =
        error instanceof SpotAnswerError ||
        ((error instanceof GeminiError || error instanceof EmbedderError) && error.retryable);
      if (!retryable || attempt >= 3) throw error;
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}

async function coverPhotos(database: Db): Promise<{ lookId: string; mediaId: string }[]> {
  return database
    .select({ lookId: looks.id, mediaId: lookMedia.mediaId })
    .from(looks)
    .innerJoin(profiles, eq(profiles.id, looks.authorProfileId))
    .innerJoin(lookMedia, and(eq(lookMedia.lookId, looks.id), eq(lookMedia.position, 0)))
    .innerJoin(media, eq(media.id, lookMedia.mediaId))
    .where(
      and(
        eq(profiles.handle, handle),
        eq(looks.status, 'published'),
        isNull(looks.deletedAt),
        eq(media.status, 'ready'),
      ),
    )
    .orderBy(asc(looks.publishedAt), asc(looks.id))
    .limit(count);
}

const started = new Date();
// Set from the workers below (an object, so TypeScript sees it change).
const run = { stoppedByCap: false };
try {
  const photos = await coverPhotos(db);
  if (photos.length === 0) {
    console.error(`No published looks with a ready photo by @${handle}.`);
    process.exitCode = 1;
  } else {
    console.log(`Reading ${String(photos.length)} photos by @${handle}${again ? ' (again)' : ''}…`);
  }
  let next = 0;
  let done = 0;
  // Three at a time: well within Gemini's limits, and the page is ready in a few minutes.
  const workers = Array.from({ length: 3 }, async () => {
    while (!run.stoppedByCap && next < photos.length) {
      const photo = photos[next];
      next += 1;
      if (!photo) break;
      try {
        const read = await withRetries(() => spotPhoto(deps, photo.mediaId, { again }));
        const fp = ai.embedder
          ? await withRetries(() => fingerprintPhoto(deps, photo.mediaId))
          : null;
        done += 1;
        const detail =
          'reason' in read
            ? `${read.outcome} (${read.reason})`
            : `${read.outcome}, ${String(read.garments)} pieces, $${(read.costMicros / 1e6).toFixed(5)}`;
        const fpDetail = fp?.outcome === 'done' ? `, ${String(fp.fingerprints)} fingerprints` : '';
        console.log(
          `  ${String(done)}/${String(photos.length)} ${photo.mediaId}: ${detail}${fpDetail}`,
        );
      } catch (error) {
        if (error instanceof SpendCapReachedError) {
          run.stoppedByCap = true;
          console.error(error.message);
          break;
        }
        done += 1;
        console.error(
          `  ${photo.mediaId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  });
  await Promise.all(workers);

  const page = await pageData(
    db,
    photos.map((p) => p.mediaId),
  );
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, 'index.html');
  await writeFile(file, renderPage(page));

  const { cost } = page;
  console.log(
    `\nCost: ${String(cost.calls)} calls this run, $${(cost.runMicros / 1e6).toFixed(4)}. ` +
      `Average per photo read: $${(cost.averageMicros / 1e6).toFixed(5)} ` +
      `(${String(cost.averageInput)} input + ${String(cost.averageOutput)} output tokens) → ` +
      `$${((cost.averageMicros * 1000) / 1e6).toFixed(2)} per 1,000 photos.`,
  );
  console.log(`Open the check page: ${file}`);
  if (run.stoppedByCap) process.exitCode = 1;
} finally {
  await db.$client.end();
}

async function pageData(database: Db, mediaIds: string[]): Promise<PageData> {
  const photoRows =
    mediaIds.length === 0
      ? []
      : await database
          .select({
            id: media.id,
            key600: media.key600,
            width: media.width,
            height: media.height,
            status: media.spotStatus,
            description: media.aiDescription,
            tags: media.aiTags,
            flags: media.safetyFlags,
          })
          .from(media)
          .where(inArray(media.id, mediaIds));
  const garmentRows =
    mediaIds.length === 0
      ? []
      : await database
          .select()
          .from(garments)
          .where(and(inArray(garments.mediaId, mediaIds), isNull(garments.deletedAt)))
          .orderBy(asc(garments.boxTop), asc(garments.boxLeft), asc(garments.id));
  const byId = new Map(photoRows.map((r) => [r.id, r]));
  const photos: PagePhoto[] = [];
  for (const id of mediaIds) {
    const row = byId.get(id);
    if (!row?.key600) continue;
    photos.push({
      mediaId: id,
      url: storage.publicUrl(row.key600),
      width: row.width ?? 1,
      height: row.height ?? 1,
      status: row.status,
      description: row.description,
      tags: row.tags,
      flags: row.flags,
      garments: garmentRows
        .filter((g) => g.mediaId === id)
        .map((g) => ({
          id: g.id,
          category: g.category,
          color: g.color,
          attributes: g.attributes,
          box: [g.boxLeft, g.boxTop, g.boxRight, g.boxBottom],
          fingerprinted: g.embedding !== null,
        })),
    });
  }

  // The latest answered call per photo is what that photo's reading cost.
  const calls =
    mediaIds.length === 0
      ? []
      : await database
          .select({
            mediaId: aiCalls.mediaId,
            costMicros: aiCalls.costMicros,
            inputTokens: aiCalls.inputTokens,
            outputTokens: aiCalls.outputTokens,
            thinkingTokens: aiCalls.thinkingTokens,
            status: aiCalls.status,
            createdAt: aiCalls.createdAt,
          })
          .from(aiCalls)
          .where(inArray(aiCalls.mediaId, mediaIds))
          .orderBy(desc(aiCalls.createdAt));
  const latest = new Map<string, (typeof calls)[number]>();
  for (const call of calls) {
    if (call.mediaId && call.status !== 'failed' && !latest.has(call.mediaId)) {
      latest.set(call.mediaId, call);
    }
  }
  const answered = [...latest.values()];
  const average = (pick: (c: (typeof calls)[number]) => number) =>
    answered.length === 0 ? 0 : answered.reduce((sum, c) => sum + pick(c), 0) / answered.length;
  const thisRun = calls.filter((c) => c.createdAt >= started);
  return {
    model: ai.gemini?.model ?? '',
    promptVersion: SPOT_PROMPT_VERSION,
    createdAt: new Date().toISOString(),
    photos,
    cost: {
      calls: thisRun.length,
      runMicros: thisRun.reduce((sum, c) => sum + c.costMicros, 0),
      averageMicros: average((c) => c.costMicros),
      averageInput: Math.round(average((c) => c.inputTokens)),
      averageOutput: Math.round(average((c) => c.outputTokens + c.thinkingTokens)),
    },
  };
}
