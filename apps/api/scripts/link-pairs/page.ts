// The link pair page (`pnpm links:calibrate --make-page`): a garment next to a product, same or not.

export interface PagePair {
  garmentId: string;
  productId: string;
  /** Cosine similarity of their fingerprints (shown only after labelling, so it doesn't sway). */
  similarity: number;
  /** `linked`: a link someone put on the look; `nearest`: the most alike product we have. */
  source: 'linked' | 'nearest';
  look: { url: string; width: number; height: number };
  /** The garment's box in fractions of the look photo: left, top, right, bottom. */
  box: [number, number, number, number];
  category: string;
  product: { name: string; brand: string | null; url: string; width: number; height: number };
}

export interface PairPageData {
  createdAt: string;
  fingerprintModel: string;
  thresholds: { verifyAt: number; rejectBelow: number };
  pairs: PagePair[];
}

/**
 * One self-contained page. Product names come from shop pages: data, never
 * HTML (textContent only). Answers are kept in the browser (localStorage);
 * "Copy CSV" gives the lines for `pnpm links:calibrate --file pairs.csv`.
 */
export function renderPairPage(data: PairPageData): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link check pairs</title>
<style>
  :root { color-scheme: light dark; --bg: #faf7f2; --fg: #2b2622; --muted: #7a7068; --card: #fff; --line: #e5ddd3; --ok: #2f7d4f; --bad: #b3412c; --box: #ff5a36; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1d1a17; --fg: #f1ebe4; --muted: #a59b91; --card: #29241f; --line: #3b342d; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; font: 15px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  header { position: sticky; top: 0; z-index: 2; background: var(--bg); padding: 8px 0 12px; border-bottom: 1px solid var(--line); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .muted { color: var(--muted); font-size: 13px; }
  .score { font-size: 18px; font-weight: 600; margin: 6px 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; margin-top: 16px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 10px; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; align-items: start; }
  .crop { position: relative; overflow: hidden; border-radius: 8px; background: var(--line); }
  .crop img { position: absolute; max-width: none; }
  .product img { display: block; width: 100%; height: auto; border-radius: 8px; }
  .label { font-size: 12px; color: var(--muted); margin: 4px 0 0; }
  .name { font-size: 13px; margin-top: 4px; }
  .answers { display: flex; gap: 6px; margin-top: 8px; }
  button { font: inherit; font-size: 13px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; }
  button.on.yes { background: var(--ok); color: #fff; border-color: var(--ok); }
  button.on.no { background: var(--bad); color: #fff; border-color: var(--bad); }
  button.on.skip { background: var(--muted); color: #fff; border-color: var(--muted); }
  .score-line { font-size: 12px; color: var(--muted); margin-top: 6px; }
</style>
</head>
<body>
<header>
  <h1>Link check pairs</h1>
  <div class="muted" id="meta"></div>
  <div class="muted">Left: a piece cut from a look photo. Right: a shop's product photo. Is it the <b>same product</b> (same item, brand and colour)? <b>Same</b>, <b>Different</b>, or <b>Can't tell</b> (left out). Your answers stay in this browser. When done, press "Copy CSV" and paste it into a file called pairs.csv.</div>
  <div class="score" id="score"></div>
  <button id="copy">Copy CSV</button>
</header>
<div class="grid" id="grid"></div>
<script>
const data = ${json};
const KEY = 'link-pairs:' + data.fingerprintModel;
let answers = {};
try { answers = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(answers)); } catch {} };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const keyOf = (p) => p.garmentId + ',' + p.productId;

document.getElementById('meta').textContent =
  data.pairs.length + ' pairs · fingerprints ' + data.fingerprintModel + ' · now: verified from ' +
  data.thresholds.verifyAt + ', rejected below ' + data.thresholds.rejectBelow;

function score() {
  let same = 0, different = 0, skipped = 0;
  for (const p of data.pairs) {
    const a = answers[keyOf(p)];
    if (a === 'yes') same++; else if (a === 'no') different++; else if (a === 'skip') skipped++;
  }
  document.getElementById('score').textContent =
    (same + different) + ' labelled (goal 100) · ' + same + ' same · ' + different + ' different · ' + skipped + ' can\\'t tell';
}

const painters = [];
for (const p of data.pairs) {
  const card = el('div', 'card');
  const pair = el('div', 'pair');

  // The piece: the look photo shown so that only the box (with a little room) fills the frame.
  const [l, t, r, b] = p.box;
  const pad = 0.06;
  const bl = Math.max(0, l - (r - l) * pad), bt = Math.max(0, t - (b - t) * pad);
  const br = Math.min(1, r + (r - l) * pad), bb = Math.min(1, b + (b - t) * pad);
  const crop = el('div', 'crop');
  crop.style.width = '100%';
  crop.style.aspectRatio = ((br - bl) * p.look.width) + ' / ' + ((bb - bt) * p.look.height);
  const img = el('img');
  img.src = p.look.url; img.loading = 'lazy'; img.alt = '';
  const place = () => {
    const w = crop.clientWidth || 160;
    const s = w / ((br - bl) * p.look.width);
    Object.assign(img.style, { width: p.look.width * s + 'px', height: p.look.height * s + 'px', left: -bl * p.look.width * s + 'px', top: -bt * p.look.height * s + 'px' });
  };
  img.onload = place; window.addEventListener('resize', place);
  crop.append(img);
  const left = el('div');
  left.append(crop, el('div', 'label', p.category.replaceAll('_', '-') + (p.source === 'linked' ? ' · linked on the look' : '')));

  const right = el('div', 'product');
  const pimg = el('img');
  pimg.src = p.product.url; pimg.width = p.product.width; pimg.height = p.product.height; pimg.loading = 'lazy'; pimg.alt = '';
  right.append(pimg, el('div', 'name', [p.product.brand, p.product.name].filter(Boolean).join(' · ')));
  pair.append(left, right);

  const row = el('div', 'answers');
  const buttons = [['yes', 'Same'], ['no', 'Different'], ['skip', "Can't tell"]].map(([v, label]) => {
    const btn = el('button', v, label);
    btn.onclick = () => { answers[keyOf(p)] = answers[keyOf(p)] === v ? undefined : v; save(); paint(); };
    return btn;
  });
  row.append(...buttons);
  const line = el('div', 'score-line');
  card.append(pair, row, line);
  painters.push(() => {
    const a = answers[keyOf(p)];
    buttons.forEach((btn, j) => btn.classList.toggle('on', a === ['yes', 'no', 'skip'][j]));
    // The score only after answering, so it doesn't sway the answer.
    line.textContent = a ? 'Fingerprint score ' + p.similarity.toFixed(3) : '';
  });
  document.getElementById('grid').append(card);
}
function paint() { painters.forEach((f) => f()); score(); }
paint();

document.getElementById('copy').onclick = async () => {
  const lines = ['garment_id,product_id,same'];
  for (const p of data.pairs) {
    const a = answers[keyOf(p)];
    if (a === 'yes' || a === 'no') lines.push(keyOf(p) + ',' + a);
  }
  const text = lines.join('\\n') + '\\n';
  try { await navigator.clipboard.writeText(text); document.getElementById('copy').textContent = 'Copied ' + (lines.length - 1) + ' pairs'; } catch { prompt('Copy this:', text); }
};
</script>
</body>
</html>
`;
}
