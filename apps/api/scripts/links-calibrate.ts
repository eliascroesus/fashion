// The link check's thresholds from labelled pairs (Step 3.5). From the repo root:
//   pnpm links:calibrate --make-page            a page of garment + product pairs to label
//        [--count 150] [--author outfitly.picks] [--out ./somewhere]
//                                              (default ~/Downloads/outfitly-link-pairs)
//   pnpm links:calibrate --file pairs.csv       what the check does with the labelled pairs: wrong
//                                              items auto-verified (goal under 5%), good links
//                                              rejected, share sent to the AI, and suggested
//                                              thresholds
//        [--ai]                                also ask Gemini about the pairs in between, as the
//                                              check would (costs a little; logged)
//   pnpm links:calibrate --set 0.82 0.6         sets verifyAt and rejectBelow in the database
// Pairs on the page: links on looks (look items), plus each seed garment's most alike products.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDb, eq, settings, sql } from '@outfitly/db';
import { photoAiClients } from '../src/ai/clients.ts';
import { loadConfig, r2Config } from '../src/config.ts';
import type { GarmentCategory } from '@outfitly/shared';
import {
  chooseGarment,
  compareWithAi,
  decideByScore,
  garmentCandidates,
  linkCheckThresholds,
  THRESHOLDS_SETTING,
} from '../src/links/check.ts';
import { R2Storage } from '../src/storage.ts';
import {
  evaluate,
  type LabelledPair,
  MAX_WRONG_VERIFIED,
  MIN_LABELLED_PAIRS,
  parsePairsCsv,
  parseThresholdArgs,
  suggest,
} from './link-pairs/calibrate.ts';
import { type PagePair, renderPairPage } from './link-pairs/page.ts';

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}
const here = (path: string) => resolve(process.env['INIT_CWD'] ?? process.cwd(), path);

const config = loadConfig();
const db = createDb(config.DATABASE_URL, { caCert: config.DATABASE_CA_CERT });
const storage = new R2Storage(r2Config(config));
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

type PairRow = {
  garment_id: string;
  product_id: string;
  similarity: number;
  source: 'linked' | 'nearest';
};

async function makePage(): Promise<void> {
  const count = Number(option('count') ?? 150);
  const handle = (option('author') ?? 'outfitly.picks').replace(/^@/, '');
  const outDir = option('out')
    ? here(option('out') ?? '')
    : join(homedir(), 'Downloads', 'outfitly-link-pairs');
  const thresholds = await linkCheckThresholds(db);

  // Links on looks, with the piece the check compares them with (the poster's pick, the piece it
  // matched, else the one it would choose: under the dot, or the look's most alike piece).
  const { rows: items } = await db.execute<{
    id: string;
    look_id: string;
    garment_id: string | null;
    matched_garment_id: string | null;
    media_id: string | null;
    dot_x: number | null;
    dot_y: number | null;
    product_id: string;
    category: GarmentCategory | null;
    model: string | null;
  }>(
    sql`SELECT li.id, li.look_id, li.garment_id, li.matched_garment_id, li.media_id, li.dot_x,
               li.dot_y, o.product_id, p.category, p.embedding_model AS model
          FROM look_items li
          JOIN offers o ON o.id = li.offer_id
          JOIN products p ON p.id = o.product_id
         WHERE li.deleted_at IS NULL AND p.deleted_at IS NULL AND p.embedding IS NOT NULL
         ORDER BY li.created_at`,
  );
  const linked: PairRow[] = [];
  for (const item of items) {
    const { candidates } = await garmentCandidates(
      db,
      { lookId: item.look_id, garmentId: item.garment_id, mediaId: item.media_id },
      item.id,
      item.product_id,
    );
    const usable = candidates.filter(
      (c) => c.similarity !== null && c.embeddingModel === item.model,
    );
    const matched = usable.find((c) => c.id === item.matched_garment_id);
    const garment =
      matched ??
      chooseGarment(
        usable,
        { garmentId: item.garment_id, mediaId: item.media_id, dotX: item.dot_x, dotY: item.dot_y },
        item.category,
      )?.garment;
    if (garment?.similarity == null) continue;
    linked.push({
      garment_id: garment.id,
      product_id: item.product_id,
      similarity: garment.similarity,
      source: 'linked',
    });
  }
  // Each seed garment's two most alike products: the hard cases for the "verified" threshold.
  const { rows: nearest } = await db.execute<PairRow>(
    sql`SELECT g.id AS garment_id, n.id AS product_id, 'nearest' AS source, n.similarity
          FROM garments g
          JOIN look_media lm ON lm.media_id = g.media_id
          JOIN looks l ON l.id = lm.look_id AND l.deleted_at IS NULL
          JOIN profiles pr ON pr.id = l.author_profile_id AND pr.handle = ${handle}
          CROSS JOIN LATERAL (
            SELECT p.id, 1 - (p.embedding OPERATOR(extensions.<=>) g.embedding) AS similarity
              FROM products p
             WHERE p.deleted_at IS NULL AND p.embedding IS NOT NULL
               AND p.embedding_model = g.embedding_model
             ORDER BY p.embedding OPERATOR(extensions.<=>) g.embedding
             LIMIT 2) n
         WHERE g.deleted_at IS NULL AND g.embedding IS NOT NULL
         ORDER BY n.similarity DESC`,
  );
  const seen = new Set<string>();
  const chosen: PairRow[] = [];
  for (const row of [...linked, ...nearest]) {
    const key = `${row.garment_id},${row.product_id}`;
    if (seen.has(key) || chosen.length >= count) continue;
    seen.add(key);
    chosen.push(row);
  }
  if (chosen.length === 0) {
    console.error(
      'No pairs yet: the seed looks need AI garments with fingerprints (pnpm ai:spot-check --all)' +
        ' and products with fingerprints (pnpm seed:items or pnpm links:try --save).',
    );
    process.exitCode = 1;
    return;
  }

  const pairs: PagePair[] = [];
  let model = '';
  for (const row of chosen) {
    const { rows } = await db.execute<{
      category: string;
      box_left: number;
      box_top: number;
      box_right: number;
      box_bottom: number;
      look_key: string;
      look_width: number;
      look_height: number;
      model: string;
      name: string;
      brand: string | null;
      product_key: string;
      product_width: number;
      product_height: number;
    }>(
      sql`SELECT g.category, g.box_left, g.box_top, g.box_right, g.box_bottom, g.embedding_model AS model,
                 lm.key_1080 AS look_key, lm.width AS look_width, lm.height AS look_height,
                 p.name, p.brand, pm.key_1080 AS product_key, pm.width AS product_width,
                 pm.height AS product_height
            FROM garments g
            JOIN media lm ON lm.id = g.media_id
            JOIN products p ON p.id = ${row.product_id}
            JOIN media pm ON pm.id = p.image_media_id
           WHERE g.id = ${row.garment_id} AND lm.key_1080 IS NOT NULL AND pm.key_1080 IS NOT NULL`,
    );
    const r = rows[0];
    if (!r) continue;
    model = r.model;
    pairs.push({
      garmentId: row.garment_id,
      productId: row.product_id,
      similarity: row.similarity,
      source: row.source,
      look: { url: storage.publicUrl(r.look_key), width: r.look_width, height: r.look_height },
      box: [r.box_left, r.box_top, r.box_right, r.box_bottom],
      category: r.category,
      product: {
        name: r.name,
        brand: r.brand,
        url: storage.publicUrl(r.product_key),
        width: r.product_width,
        height: r.product_height,
      },
    });
  }
  await mkdir(outDir, { recursive: true });
  const page = join(outDir, 'index.html');
  await writeFile(
    page,
    renderPairPage({
      createdAt: new Date().toISOString(),
      fingerprintModel: model,
      thresholds,
      pairs,
    }),
  );
  console.log(
    `${String(pairs.length)} pairs (${String(linked.length)} linked on looks, the rest most alike):`,
  );
  console.log(`  open ${page}`);
}

async function report(file: string): Promise<void> {
  const labels = parsePairsCsv(await readFile(here(file), 'utf8'));
  const askAi = args.includes('--ai');
  const thresholds = await linkCheckThresholds(db);
  const ai = photoAiClients(config);
  if (askAi && !ai.gemini) {
    console.error('--ai needs GEMINI_API_KEY in .env.');
    process.exitCode = 1;
    return;
  }

  const pairs: LabelledPair[] = [];
  let missing = 0;
  for (const label of labels) {
    const { rows } = await db.execute<{
      similarity: number;
      media_id: string;
      look_id: string | null;
      category: string;
      box_left: number;
      box_top: number;
      box_right: number;
      box_bottom: number;
      model: string;
      product_key: string | null;
    }>(
      sql`SELECT 1 - (g.embedding OPERATOR(extensions.<=>) p.embedding) AS similarity,
                 g.media_id, (SELECT look_id FROM look_media WHERE media_id = g.media_id LIMIT 1) AS look_id,
                 g.category, g.box_left, g.box_top, g.box_right, g.box_bottom, g.embedding_model AS model,
                 pm.key_1080 AS product_key
            FROM garments g, products p
            LEFT JOIN media pm ON pm.id = p.image_media_id
           WHERE g.id = ${label.garmentId} AND p.id = ${label.productId}
             AND g.embedding IS NOT NULL AND p.embedding IS NOT NULL
             AND g.embedding_model = p.embedding_model`,
    );
    const r = rows[0];
    if (!r) {
      missing += 1;
      continue;
    }
    const pair: LabelledPair = { ...label, similarity: r.similarity };
    const middle =
      pair.similarity >= thresholds.rejectBelow && pair.similarity < thresholds.verifyAt;
    if (askAi && middle && r.product_key && r.look_id) {
      const asked = await compareWithAi(
        { db, storage, gemini: ai.gemini, dailyCapMicros: ai.dailyCapMicros },
        {
          lookId: r.look_id,
          lookItemId: null,
          productPhotoKey: r.product_key,
          garment: {
            id: label.garmentId,
            mediaId: r.media_id,
            category: r.category as never,
            box: { left: r.box_left, top: r.box_top, right: r.box_right, bottom: r.box_bottom },
            embeddingModel: r.model,
            hasFingerprint: true,
            similarity: pair.similarity,
            taken: false,
          },
        },
      );
      // Refused counts as unsure (a person decides); no answer at all stays unknown.
      pair.ai = 'same' in asked ? asked.same : 'refusal' in asked ? 'unsure' : null;
    }
    pairs.push(pair);
  }

  const same = pairs.filter((p) => p.same).length;
  console.log(
    `${String(pairs.length)} labelled pairs: ${String(same)} same, ${String(pairs.length - same)} different` +
      (missing > 0 ? ` (${String(missing)} skipped: no fingerprint, or different models)` : ''),
  );
  const suggested = suggest(pairs);
  if (!suggested) {
    console.log('Too few pairs to suggest thresholds (needs 30 different and 10 same).');
  }
  const rows = [
    { name: 'now', ...thresholds },
    ...(suggested ? [{ name: 'suggested', ...suggested }] : []),
    ...[0.7, 0.75, 0.8, 0.85, 0.9].map((v) => ({
      name: '',
      verifyAt: v,
      rejectBelow: Math.min(thresholds.rejectBelow, v),
    })),
  ];
  console.table(
    rows.map(({ name, verifyAt, rejectBelow }) => {
      const e = evaluate(pairs, verifyAt, rejectBelow);
      return {
        thresholds: name,
        verifyAt,
        rejectBelow,
        'wrong auto-verified': `${String(e.wrongVerified)} (${pct(e.wrongVerifiedShare)})`,
        'good rejected': `${String(e.rightRejected)} (${pct(e.rightRejectedShare)})`,
        'to the AI': `${String(e.toAi)} (${pct(e.toAiShare)})`,
        ...(askAi ? { 'AI unsure → review': e.toReview } : {}),
      };
    }),
  );
  const now = evaluate(pairs, thresholds.verifyAt, thresholds.rejectBelow);
  // In between, the AI's answer counts: without it (no --ai, or no answer) nothing is measured.
  const unanswered = pairs.filter(
    (p) =>
      decideByScore(p.similarity, thresholds) === 'ask' && (p.ai === undefined || p.ai === null),
  ).length;
  const verdict =
    pairs.length < MIN_LABELLED_PAIRS
      ? `not measured yet (needs ${String(MIN_LABELLED_PAIRS)} labelled pairs)`
      : !askAi
        ? 'not measured yet (run with --ai: the AI decides the pairs in between)'
        : unanswered > 0
          ? `not measured yet (${String(unanswered)} pairs in between got no AI answer)`
          : now.wrongVerifiedShare < MAX_WRONG_VERIFIED
            ? 'PASS'
            : 'FAIL';
  console.log(
    `Done when (fewer than 5% of wrong items auto-verified, at least 100 pairs): ` +
      `${pct(now.wrongVerifiedShare)} of ${String(pairs.length - same)} different pairs → ${verdict}`,
  );
}

async function setThresholds(
  verifyAt: string | undefined,
  rejectBelow: string | undefined,
): Promise<void> {
  const value = parseThresholdArgs(verifyAt, rejectBelow);
  const updated = await db
    .update(settings)
    .set({ value })
    .where(eq(settings.key, THRESHOLDS_SETTING))
    .returning({ key: settings.key });
  if (updated.length === 0) throw new Error(`No "${THRESHOLDS_SETTING}" setting in this database.`);
  console.log(
    `Link check now verifies from ${String(value.verifyAt)} and rejects below ${String(value.rejectBelow)} ` +
      '(the API picks it up within a minute).',
  );
}

try {
  const set = args.indexOf('--set');
  const file = option('file');
  if (args.includes('--make-page')) await makePage();
  else if (file) await report(file);
  else if (set !== -1) await setThresholds(args[set + 1], args[set + 2]);
  else {
    console.error('Use --make-page, --file pairs.csv [--ai] or --set <verifyAt> <rejectBelow>.');
    process.exitCode = 1;
  }
} finally {
  await db.$client.end();
}
