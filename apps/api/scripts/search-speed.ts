// Search speed check (target: suggestions while typing in under 300 ms). From the repo root:
//   pnpm search:speed            logged out, over HTTP against the staging API
//   --url <api base>  (default https://outfitly-api-staging.fly.dev)   --runs N  (default 5)
// Types each word letter by letter (a suggestion request per letter, like the app), then searches
// it and reads two more pages. Words with typos are included. Requests start at least PACE_MS
// apart, which keeps under the API's rate limit (300 a minute per address).
import { feedPageSchema, suggestionsSchema } from '@outfitly/shared';

const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const runs = Number(option('--runs') ?? 5);
const baseUrl = option('--url') ?? 'https://outfitly-api-staging.fly.dev';
const SEARCHES = ['linnen', 'black coat', 'trousers', 'minimel', 'sommar', 'sneakers'];
const NEXT_PAGES = 2;
const PACE_MS = 220;
let lastStart = 0;

async function timedGet(path: string, params: Record<string, string>): Promise<[number, unknown]> {
  const url = new URL(path, baseUrl);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const wait = lastStart + PACE_MS - performance.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  const started = performance.now();
  lastStart = started;
  const res = await fetch(url);
  const body: unknown = await res.json();
  if (!res.ok) throw new Error(`${url.toString()} → ${String(res.status)} ${JSON.stringify(body)}`);
  return [performance.now() - started, body];
}

function report(label: string, samples: number[]): void {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  const ms = (v: number | undefined) => `${String(Math.round(v ?? 0))} ms`;
  console.log(
    `${label.padEnd(22)} p50 ${ms(at(0.5))} · p95 ${ms(at(0.95))} · max ${ms(sorted.at(-1))} (${String(sorted.length)} requests)`,
  );
}

// Wake a sleeping staging machine and warm its connections first.
const health = await fetch(new URL('/v1/health', baseUrl));
if (!health.ok) throw new Error(`API not healthy: ${String(health.status)}`);
for (let i = 0; i < 3; i++) await timedGet('/v1/search/suggest', { q: 'warm' });

const suggest: number[] = [];
const first: number[] = [];
const later: number[] = [];
const results = new Map<string, number>();
for (let run = 0; run < runs; run++) {
  for (const search of SEARCHES) {
    for (let end = 1; end <= search.length; end++) {
      const [ms, body] = await timedGet('/v1/search/suggest', { q: search.slice(0, end) });
      suggestionsSchema.parse(body);
      suggest.push(ms);
    }
    let cursor: string | undefined;
    let count = 0;
    for (let page = 0; page <= NEXT_PAGES; page++) {
      const [ms, body] = await timedGet('/v1/search/looks', {
        q: search,
        ...(cursor ? { cursor } : {}),
      });
      const result = feedPageSchema.parse(body);
      (page === 0 ? first : later).push(ms);
      count += result.items.length;
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    results.set(search, count);
  }
}
console.log(`Logged out, over HTTP from this computer to ${baseUrl}:`);
report('Suggestions', suggest);
report('Search, page 1', first);
if (later.length > 0) report('Search, next pages', later);
console.log(
  `Looks found (first ${String(NEXT_PAGES + 1)} pages): ${[...results].map(([q, n]) => `"${q}" ${String(n)}`).join(', ')}`,
);
