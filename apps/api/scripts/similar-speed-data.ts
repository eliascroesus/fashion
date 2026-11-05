// A local database for timing "More like this", similar pieces and search at catalogue size. From
// the repo root (needs TEST_DATABASE_URL on this computer, like the tests):
//   pnpm similar:speed-data                 10,000 looks, 3,000 products
//   pnpm similar:speed-data --looks 50000
// Reads the seed looks' real cover fingerprints from DATABASE_URL (read only: fingerprint them first
// with `pnpm ai:fingerprint`) and spreads them over the new looks and products, each a mix of two
// seed fingerprints plus a little noise, so nearest-neighbour search works on realistic data. Writes
// only to a new database on the local test server and prints its address for `pnpm similar:speed`.
import { createDb, type SQL, sql } from '@outfitly/db';
import { createMigratedTestDatabase } from '@outfitly/db/testing';
import { GARMENT_CATEGORIES, OCCASIONS, SEASONS, STYLES } from '@outfitly/shared';
import { loadConfig } from '../src/config.ts';

const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const lookCount = Number(option('--looks') ?? 10_000);
const productCount = Number(option('--products') ?? 3_000);
if (!Number.isInteger(lookCount) || lookCount < 100 || !Number.isInteger(productCount)) {
  console.error('Usage: pnpm similar:speed-data [--looks N (≥ 100)] [--products N]');
  process.exit(1);
}

const config = loadConfig();
const source = createDb(config.DATABASE_URL, { caCert: config.DATABASE_CA_CERT });
const { rows: seeds } = await source.execute<{
  embedding: string;
  model: string;
  caption: string | null;
}>(sql`
  SELECT m.embedding::text AS embedding, m.embedding_model AS model, l.caption
    FROM looks l JOIN look_media lm ON lm.look_id = l.id AND lm.position = 0
    JOIN media m ON m.id = lm.media_id
   WHERE m.embedding IS NOT NULL AND l.deleted_at IS NULL
   ORDER BY l.created_at, l.id`);
await source.$client.end();
const model = seeds[0]?.model;
if (!model || seeds.length < 10) {
  console.error(
    'Fewer than 10 fingerprinted looks in DATABASE_URL: run pnpm ai:fingerprint first.',
  );
  process.exit(1);
}

const started = performance.now();
const target = await createMigratedTestDatabase();
const db = createDb(target.url);
const list = (values: readonly string[]) => `{${values.join(',')}}`;
let made = false;
try {
  await db.execute(
    sql`CREATE TABLE seed_vectors (i int PRIMARY KEY, v real[] NOT NULL, caption text)`,
  );
  for (const [i, seed] of seeds.entries()) {
    await db.execute(sql`INSERT INTO seed_vectors VALUES
      (${i}, ${seed.embedding}::extensions.vector::real[], ${seed.caption})`);
  }
  const n = seeds.length;
  // A fingerprint near seed `a`, pulled a little towards seed `b`, with noise (cosine to `a` ≈ 0.9).
  const mixed = (i: SQL, salt: number) => sql`(
    SELECT extensions.l2_normalize(array_agg((w * x + (1 - w) * y + (random() - 0.5) * 0.06) ORDER BY k)::extensions.vector)::extensions.halfvec
      FROM (SELECT 0.55 + 0.45 * ((${i} * 7919 + ${salt}) % 1000) / 1000.0 AS w) weight,
           unnest((SELECT v FROM seed_vectors WHERE i = ${i} % ${n}),
                  (SELECT v FROM seed_vectors WHERE i = (${i} * 31 + ${salt}) % ${n}))
             WITH ORDINALITY AS t(x, y, k))`;

  await db.execute(sql`
    INSERT INTO profiles (id, handle, account_type)
    SELECT ('00000000-0000-4000-8000-' || lpad(a::text, 12, '0'))::uuid, 'speed.' || a, 'creator'
      FROM generate_series(1, 20) a`);
  const author = sql`('00000000-0000-4000-8000-' || lpad((1 + g % 20)::text, 12, '0'))::uuid`;
  const photo = (prefix: string) => sql`
    'ready', 'originals/${sql.raw(prefix)}/' || g, '${sql.raw(prefix)}/' || g || '/1080.webp',
    '${sql.raw(prefix)}/' || g || '/600.webp', '${sql.raw(prefix)}/' || g || '/300.webp',
    1080, 1350 + (g % 5) * 90, 'k0oGLQaSVsN0BVhn2oq2Z5SQUQcZ', '#a08870'`;

  for (let from = 0; from < lookCount; from += 2000) {
    const to = Math.min(lookCount, from + 2000) - 1;
    await db.execute(sql`
      INSERT INTO media (id, owner_profile_id, status, original_key, key_1080, key_600, key_300,
                         width, height, thumbhash, dominant_color, embedding, embedding_model)
      SELECT ('10000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, ${author}, ${photo('look')},
             ${mixed(sql`g`, 11)}, ${model}
        FROM generate_series(${from}::int, ${to}::int) g`);
    await db.execute(sql`
      INSERT INTO looks (id, author_profile_id, caption, slug, status, occasion_tags, season_tags,
                         style_tags, popularity_score, published_at, created_at)
      SELECT ('20000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, ${author},
             (SELECT caption FROM seed_vectors WHERE i = g % ${n}), 'speed-look-' || g, 'published',
             ARRAY[(${list(OCCASIONS)}::text[])[1 + g % ${OCCASIONS.length}]]::look_occasion[],
             ARRAY[(${list(SEASONS)}::text[])[1 + g % ${SEASONS.length}]]::look_season[],
             ARRAY[(${list(STYLES)}::text[])[1 + (g / 3) % ${STYLES.length}]]::look_style[],
             round((random() * 0.2)::numeric, 4)::float8,
             now() - make_interval(mins => g * 13), now() - make_interval(mins => g * 13)
        FROM generate_series(${from}::int, ${to}::int) g`);
    await db.execute(sql`
      INSERT INTO look_media (look_id, media_id, position)
      SELECT ('20000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
             ('10000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 0
        FROM generate_series(${from}::int, ${to}::int) g`);
    console.log(`  looks ${String(to + 1)}/${String(lookCount)}`);
  }

  // Products: a shop photo (fingerprinted), one shop link, a verified piece on a look, and the
  // garment it was matched with (fingerprinted too, like Step 3.3 would).
  for (let from = 0; from < productCount; from += 1000) {
    const to = Math.min(productCount, from + 1000) - 1;
    const look = sql`('20000000-0000-4000-8000-' || lpad(((g * 3) % ${lookCount})::text, 12, '0'))::uuid`;
    const lookPhoto = sql`('10000000-0000-4000-8000-' || lpad(((g * 3) % ${lookCount})::text, 12, '0'))::uuid`;
    const category = sql`(${list(GARMENT_CATEGORIES)}::text[])[1 + g % 6]::garment_category`;
    await db.execute(sql`
      INSERT INTO media (id, owner_profile_id, status, original_key, key_1080, key_600, key_300,
                         width, height, thumbhash, dominant_color, source_url)
      SELECT ('30000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, NULL, ${photo('product')},
             'https://shop.test/p/' || g || '.jpg'
        FROM generate_series(${from}::int, ${to}::int) g`);
    await db.execute(sql`
      INSERT INTO products (id, name, brand, category, image_media_id, embedding, embedding_model)
      SELECT ('40000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'Speed piece ' || g,
             'Brand ' || (g % 40), CASE WHEN g % 2 = 0 THEN ${category} END,
             ('30000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, ${mixed(sql`g`, 23)}, ${model}
        FROM generate_series(${from}::int, ${to}::int) g`);
    await db.execute(sql`
      INSERT INTO offers (id, product_id, url, page_url, price_minor, currency, stock, last_checked_at)
      SELECT ('50000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
             ('40000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
             'https://shop.test/p/' || g || '?aff=speed', 'https://shop.test/p/' || g,
             19900 + (g * 7919 % 200) * 1000, CASE WHEN g % 10 = 0 THEN 'EUR' ELSE 'SEK' END,
             CASE WHEN g % 17 = 0 THEN 'out_of_stock' ELSE 'in_stock' END::offer_stock, now()
        FROM generate_series(${from}::int, ${to}::int) g`);
    await db.execute(sql`
      INSERT INTO garments (id, media_id, category, color, box_left, box_top, box_right, box_bottom,
                            embedding, embedding_model)
      SELECT ('60000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, ${lookPhoto}, ${category},
             'beige', 0.2, 0.2, 0.8, 0.8, ${mixed(sql`g`, 37)}, ${model}
        FROM generate_series(${from}::int, ${to}::int) g`);
    await db.execute(sql`
      INSERT INTO look_items (id, look_id, offer_id, matched_garment_id, status)
      SELECT ('70000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, ${look},
             ('50000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
             ('60000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'verified'
        FROM generate_series(${from}::int, ${to}::int) g
      ON CONFLICT DO NOTHING`);
    console.log(`  products ${String(to + 1)}/${String(productCount)}`);
  }
  await db.execute(sql`DROP TABLE seed_vectors`);
  await db.execute(sql`ANALYZE`);
  const seconds = ((performance.now() - started) / 1000).toFixed(0);
  console.log(`Made in ${seconds} s from ${String(n)} seed fingerprints (${model}).`);
  console.log(`Time it:  pnpm similar:speed --direct --database ${target.url}`);
  console.log(`Remove it: dropdb ${new URL(target.url).pathname.slice(1)}`);
  made = true;
} finally {
  await db.$client.end();
  // A half-made database is no use for timing.
  if (!made) await target.drop();
}
