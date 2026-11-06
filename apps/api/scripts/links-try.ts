// Reads shop links the way `POST /v1/links/resolve` does and prints what came out, to check by
// eye (is the name, price and photo right?) and to measure the success rate. From the repo root:
//   pnpm links:try https://www.zalando.se/... https://www2.hm.com/...
//   pnpm links:try --file links.txt            one link per line (# starts a comment)
//   pnpm links:try --file links.txt --save     also save products and offers in the database in
//                                              .env, copy their photos and fingerprint them
//   pnpm links:try --file links.txt --out report.md   also a report with a "Right?" column to
//                                              fill in by eye
//   --microlink                                ask Microlink about pages without product data
// "OK" only means a name and a price came out: whether they're the right ones needs an eye.
// Without --save nothing is written and no database is needed. Requests go one at a time.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDb } from '@outfitly/db';
import { photoAiClients } from '../src/ai/clients.ts';
import { loadConfig, r2Config } from '../src/config.ts';
import { LinkFetchError } from '../src/links/fetch.ts';
import { readWithMicrolink } from '../src/links/microlink.ts';
import { minorDigits } from '../src/links/parse.ts';
import { copyProductPhoto, fingerprintProduct } from '../src/links/product-photos.ts';
import { type LinkRead, parseLink, readShopLink, saveLinkRead } from '../src/links/resolve.ts';
import { R2Storage } from '../src/storage.ts';

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}
const here = (path: string) => resolve(process.env['INIT_CWD'] ?? process.cwd(), path);
const save = args.includes('--save');
const microlink = args.includes('--microlink');
const file = option('file');
const out = option('out');
const valued = new Set([file, out].filter(Boolean));
const links = args.filter((a) => !a.startsWith('--') && !valued.has(a));
if (file) {
  const text = await readFile(here(file), 'utf8');
  links.push(
    ...text
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter(Boolean),
  );
}
if (links.length === 0) {
  console.error('Give links, or --file links.txt with one link per line.');
  process.exit(1);
}

const saving = save
  ? (() => {
      const config = loadConfig();
      const db = createDb(config.DATABASE_URL, { caCert: config.DATABASE_CA_CERT });
      return {
        db,
        photos: {
          db,
          storage: new R2Storage(r2Config(config)),
          embedder: photoAiClients(config).embedder,
        },
      };
    })()
  : null;

interface Row {
  link: string;
  shop: string;
  ok: boolean;
  problem: string;
  read: LinkRead | null;
  ms: number;
  photo: string;
}

function money(minor: number | null, currency: string | null): string {
  if (minor === null || currency === null) return '—';
  const digits = minorDigits(currency) ?? 2;
  return `${(minor / 10 ** digits).toFixed(digits)} ${currency}`;
}

const rows: Row[] = [];
for (const [i, link] of links.entries()) {
  const started = Date.now();
  let shop = '?';
  try {
    const url = parseLink(link);
    shop = url.hostname.replace(/^www\d?\./, '');
    const read = await readShopLink(url, {
      fallback: microlink ? (pageUrl) => readWithMicrolink(pageUrl) : null,
    });
    let photo = read.product.imageUrl ? 'shop photo found' : 'no photo';
    if (saving) {
      const saved = await saveLinkRead(saving.db, read);
      const copied = await copyProductPhoto(saving.photos, saved.productId);
      photo =
        copied.outcome === 'refused'
          ? `photo refused: ${copied.reason}`
          : `photo ${copied.outcome}`;
      if (copied.outcome !== 'refused') {
        const fp = await fingerprintProduct(saving.photos, saved.productId).catch((e: unknown) => ({
          outcome: `fingerprint failed: ${e instanceof Error ? e.message : String(e)}`,
        }));
        photo += `, fingerprint ${fp.outcome}`;
      }
    }
    // "Resolved" = a name and a price; the photo is reported separately.
    const ok = read.product.priceMinor !== null;
    rows.push({
      link,
      shop,
      ok,
      problem: ok ? '' : 'no price',
      read,
      ms: Date.now() - started,
      photo,
    });
  } catch (error) {
    const problem =
      error instanceof LinkFetchError ? `${error.problem}: ${error.message}` : String(error);
    rows.push({ link, shop, ok: false, problem, read: null, ms: Date.now() - started, photo: '' });
  }
  const row = rows.at(-1);
  if (!row) continue;
  const p = row.read?.product;
  console.log(
    `${String(i + 1).padStart(2)}. ${row.ok ? 'OK  ' : 'FAIL'} ${row.shop.padEnd(18)} ${String(row.ms).padStart(5)} ms  ` +
      (p
        ? `${p.name.slice(0, 50)} | ${p.brand ?? '—'} | ${money(p.priceMinor, p.currency)} | ${p.stock} | gtin ${p.gtin ?? '—'} | ${p.source}${row.read?.truncated ? ' | page cut at 3 MB' : ''} | ${row.photo}`
        : row.problem),
  );
}

const okCount = rows.filter((r) => r.ok).length;
const rate = Math.round((okCount / rows.length) * 100);
console.log(
  `\n${String(okCount)} of ${String(rows.length)} links gave a product with a price (${String(rate)}%).`,
);
const byShop = new Map<string, { ok: number; all: number }>();
for (const r of rows) {
  const s = byShop.get(r.shop) ?? { ok: 0, all: 0 };
  s.all += 1;
  if (r.ok) s.ok += 1;
  byShop.set(r.shop, s);
}
for (const [shop, s] of [...byShop.entries()].sort()) {
  console.log(`  ${shop.padEnd(20)} ${String(s.ok)}/${String(s.all)}`);
}

/** A link that survives a Markdown link and a table cell. */
function mdUrl(url: string): string {
  return url.replace(
    /[()|\s]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

if (out) {
  const lines = [
    `# Link check — ${new Date().toISOString().slice(0, 10)}`,
    '',
    `${String(okCount)} of ${String(rows.length)} links gave a product with a price (${String(rate)}%).`,
    '',
    'Fill in **Right?** by eye: yes only if the name, price and photo match the shop page (the shop and photo cells are links).',
    '',
    '| # | Shop | Result | Name | Brand | Price | Stock | Photo | Source | Right? |',
    '| - | - | - | - | - | - | - | - | - | - |',
    ...rows.map((r, i) => {
      const p = r.read?.product;
      const cells = p
        ? [
            p.name,
            p.brand ?? '—',
            money(p.priceMinor, p.currency),
            p.stock,
            p.imageUrl ? `[photo](${mdUrl(p.imageUrl)})` : 'no',
            p.source,
          ]
        : [r.problem, '', '', '', '', ''];
      return `| ${String(i + 1)} | [${r.shop}](${mdUrl(r.link)}) | ${r.ok ? 'OK' : 'FAIL'} | ${cells.map((c) => c.replace(/\|/g, '/')).join(' | ')} | |`;
    }),
  ];
  await writeFile(here(out), `${lines.join('\n')}\n`);
  console.log(`\nReport: ${here(out)}`);
}
if (saving) await saving.db.$client.end();
