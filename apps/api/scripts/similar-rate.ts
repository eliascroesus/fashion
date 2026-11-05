// Writes a page to judge "More like this" by eye: 20 seed looks, each with the 8 looks that come
// first under it (as a logged-out visitor gets them). From the repo root:
//   pnpm similar:rate                         20 of @outfitly.picks' looks
//   pnpm similar:rate --count 30 --author someone --out ./somewhere
// The page goes to ~/Downloads/outfitly-similar-rating/index.html by default. Needs the looks'
// fingerprints (`pnpm ai:fingerprint`). Reads only: nothing is saved in the database.
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDb, sql } from '@outfitly/db';
import { loadConfig, r2Config } from '../src/config.ts';
import { rankSimilarLooks } from '../src/similar-looks.ts';
import { R2Storage } from '../src/storage.ts';
import { type RatingPhoto, renderRatingPage } from './similar-rating/page.ts';

const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const count = Number(option('--count') ?? 20);
const handle = (option('--author') ?? 'outfitly.picks').replace(/^@/, '');
const outDir = option('--out')
  ? resolve(process.env['INIT_CWD'] ?? process.cwd(), option('--out') ?? '')
  : join(homedir(), 'Downloads', 'outfitly-similar-rating');
const SHOWN = 8;
if (!Number.isInteger(count) || count < 1) {
  console.error('--count must be a whole number of looks.');
  process.exit(1);
}

const config = loadConfig();
const db = createDb(config.DATABASE_URL, { caCert: config.DATABASE_CA_CERT });
const storage = new R2Storage(r2Config(config));

interface CoverRow extends Record<string, unknown> {
  id: string;
  caption: string | null;
  key_600: string;
  width: number;
  height: number;
  model: string | null;
}

/** Looks' covers by id (ready ones only). */
async function covers(ids: readonly string[]): Promise<Map<string, CoverRow>> {
  if (ids.length === 0) return new Map();
  const { rows } = await db.execute<CoverRow>(sql`
    SELECT l.id, l.caption, m.key_600, m.width, m.height, m.embedding_model AS model
      FROM looks l JOIN look_media lm ON lm.look_id = l.id AND lm.position = 0
      JOIN media m ON m.id = lm.media_id
     WHERE l.id = ANY(${`{${ids.join(',')}}`}::uuid[]) AND m.status = 'ready'`);
  return new Map(rows.map((r) => [r.id, r]));
}

const photo = (row: CoverRow): RatingPhoto => ({
  url: storage.publicUrl(row.key_600),
  width: row.width,
  height: row.height,
  caption: row.caption,
});

try {
  // A fixed sample (the same looks every run), spread over the poster's looks.
  const { rows: picked } = await db.execute<{ id: string }>(sql`
    SELECT l.id FROM looks l JOIN profiles p ON p.id = l.author_profile_id
      JOIN look_media lm ON lm.look_id = l.id AND lm.position = 0 JOIN media m ON m.id = lm.media_id
     WHERE p.handle = ${handle} AND l.status = 'published' AND l.deleted_at IS NULL
       AND m.embedding IS NOT NULL
     ORDER BY md5(l.id::text) LIMIT ${count}`);
  if (picked.length === 0) {
    console.error(`No fingerprinted looks by @${handle}: run pnpm ai:fingerprint first.`);
    process.exit(1);
  }
  const looks = [];
  let model = '';
  for (const { id } of picked) {
    const { lookIds } = await rankSimilarLooks(db, null, id);
    const top = lookIds.slice(0, SHOWN);
    const found = await covers([id, ...top]);
    const base = found.get(id);
    if (!base) continue;
    model ||= base.model ?? '';
    looks.push({
      id,
      ...photo(base),
      similar: top.flatMap((near) => {
        const row = found.get(near);
        return row ? [photo(row)] : [];
      }),
    });
  }
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, 'index.html');
  await writeFile(
    file,
    renderRatingPage({ createdAt: new Date().toISOString(), model, looks }),
    'utf8',
  );
  console.log(
    `${String(looks.length)} looks with their ${String(SHOWN)} nearest. Open:\n  ${file}`,
  );
} finally {
  await db.$client.end();
}
