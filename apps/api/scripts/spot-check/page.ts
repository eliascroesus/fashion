// The spot-check page (`pnpm ai:spot-check`): photos with the AI's boxes drawn, and ticks to count.

export interface PagePhoto {
  mediaId: string;
  url: string;
  width: number;
  height: number;
  status: string | null;
  /** When this reading was made: ticks belong to one reading (`--again` starts fresh). */
  readAt: string | null;
  description: string | null;
  tags: string[];
  flags: string[];
  garments: {
    id: string;
    category: string;
    color: string | null;
    attributes: Record<string, unknown>;
    box: [number, number, number, number];
    fingerprinted: boolean;
  }[];
}

export interface PageData {
  model: string;
  promptVersion: string;
  createdAt: string;
  photos: PagePhoto[];
  cost: {
    /** Calls made by this run, and what they cost. */
    runCalls: number;
    runMicros: number;
    /** Every call for these photos ever (retries, failures, estimates) and the readings bought. */
    calls: number;
    readings: number;
    totalMicros: number;
    /** totalMicros ÷ readings: the honest cost of reading one photo. */
    perPhotoMicros: number;
    /** What a successful call alone costs, on average. */
    perSuccessMicros: number;
    averageInput: number;
    averageOutput: number;
  };
}

/**
 * One self-contained page. The AI's words are data, never HTML: the page puts
 * them in with textContent. Ticks are kept in the browser (localStorage).
 */
export function renderPage(data: PageData): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Garment spotting check</title>
<style>
  :root { color-scheme: light dark; --bg: #faf7f2; --fg: #2b2622; --muted: #7a7068; --card: #fff; --line: #e5ddd3; --ok: #2f7d4f; --bad: #b3412c; --box: #ff5a36; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1d1a17; --fg: #f1ebe4; --muted: #a59b91; --card: #29241f; --line: #3b342d; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; font: 15px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  header { position: sticky; top: 0; z-index: 2; background: var(--bg); padding: 8px 0 12px; border-bottom: 1px solid var(--line); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .muted { color: var(--muted); font-size: 13px; }
  .score { font-size: 18px; font-weight: 600; margin-top: 6px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; margin-top: 16px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  .card.flagged { border-color: var(--bad); }
  .photo { position: relative; }
  .photo img { display: block; width: 100%; height: auto; }
  .box { position: absolute; border: 2px solid var(--box); border-radius: 3px; }
  .box span { position: absolute; left: -2px; top: -20px; background: var(--box); color: #fff; font-size: 11px; padding: 1px 5px; border-radius: 3px; white-space: nowrap; }
  .box.wrong { border-style: dashed; opacity: .6; }
  .body { padding: 10px 12px 12px; }
  .row { display: flex; align-items: center; gap: 6px; padding: 3px 0; font-size: 14px; }
  .row b { min-width: 18px; text-align: right; }
  .row .what { flex: 1; }
  button { font: inherit; font-size: 12px; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; }
  button.on.right { background: var(--ok); color: #fff; border-color: var(--ok); }
  button.on.wrong, button.on.not { background: var(--bad); color: #fff; border-color: var(--bad); }
  .missed { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 14px; }
  .missed input { width: 56px; font: inherit; }
  .tags { margin-top: 6px; font-size: 13px; color: var(--muted); }
  .flags { color: var(--bad); font-weight: 600; font-size: 13px; }
</style>
</head>
<body>
<header>
  <h1>Garment spotting check</h1>
  <div class="muted" id="meta"></div>
  <div class="muted">For each piece: <b>right</b> (right piece, box fits), <b>wrong box</b> (real piece, box or category off) or <b>not a piece</b>. Then type how many clearly visible pieces the AI missed. "All right" marks every piece of a photo right. Your ticks stay in this browser.</div>
  <div class="score" id="score"></div>
  <button id="copy">Copy results for Claude</button>
</header>
<div class="grid" id="grid"></div>
<script>
const data = ${json};
const KEY = 'spot-check:' + data.promptVersion;
let marks = {};
try { marks = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(marks)); } catch {} };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const c = data.cost;
document.getElementById('meta').textContent =
  data.photos.length + ' photos · ' + data.model + ' · prompt ' + data.promptVersion +
  ' · $' + (c.perPhotoMicros * 1000 / 1e6).toFixed(2) + ' per 1,000 photos (' + c.calls + ' calls for ' + c.readings +
  ' readings, retries included; a successful call alone $' + (c.perSuccessMicros / 1e6).toFixed(5) + ', ' +
  c.averageInput + ' in + ' + c.averageOutput + ' out tokens)';
// Ticks belong to one reading of a photo: reading it again (--again) starts fresh.
const readKey = (p) => p.mediaId + '@' + p.readAt;

function score() {
  let right = 0, wrong = 0, not = 0, missed = 0, checked = 0;
  for (const p of data.photos) {
    const m = marks[readKey(p)] || {};
    const pieces = p.garments.map((g) => (m.pieces || {})[g.id]);
    if (pieces.every(Boolean) && m.missed != null) checked += 1;
    for (const v of pieces) { if (v === 'right') right++; else if (v === 'wrong') wrong++; else if (v === 'not') not++; }
    missed += Number(m.missed || 0);
  }
  const visible = right + wrong + missed;
  const pct = visible ? Math.round((right / visible) * 1000) / 10 : 0;
  document.getElementById('score').textContent =
    checked + ' of ' + data.photos.length + ' photos checked · found right ' + right + ' of ' + visible +
    ' clearly visible pieces = ' + pct + '% (goal 90%) · wrong box ' + wrong + ' · not a piece ' + not + ' · missed ' + missed;
  return { checked, right, wrong, not, missed, visible, pct };
}

const painters = [];
for (const p of data.photos) {
  const m = (marks[readKey(p)] ||= { pieces: {} });
  m.pieces ||= {};
  const card = el('div', 'card' + (p.flags.length ? ' flagged' : ''));
  const photo = el('div', 'photo');
  const img = el('img');
  img.src = p.url; img.width = p.width; img.height = p.height; img.loading = 'lazy'; img.alt = p.description || '';
  photo.append(img);
  const body = el('div', 'body');
  if (p.flags.length) body.append(el('div', 'flags', 'Flagged: ' + p.flags.join(', ') + ' (look hidden, waiting for review)'));
  if (p.status === null) body.append(el('div', 'muted', 'Not read yet'));
  if (p.status === 'failed') body.append(el('div', 'flags', 'Reading failed'));
  body.append(el('div', null, p.description || ''));
  p.garments.forEach((g, i) => {
    const [l, t, r, b] = g.box;
    const box = el('div', 'box');
    Object.assign(box.style, { left: l * 100 + '%', top: t * 100 + '%', width: (r - l) * 100 + '%', height: (b - t) * 100 + '%' });
    box.append(el('span', null, (i + 1) + ' ' + g.category));
    photo.append(box);
    const row = el('div', 'row');
    const extras = [g.color, g.attributes.pattern, g.attributes.material, g.attributes.brandText].filter(Boolean).join(', ');
    row.append(el('b', null, String(i + 1)), el('span', 'what', g.category.replaceAll('_', '-') + (extras ? ' — ' + extras : '') + (g.fingerprinted ? '' : ' (no fingerprint)')));
    const buttons = [['right', 'right'], ['wrong', 'wrong box'], ['not', 'not a piece']].map(([v, label]) => {
      const btn = el('button', v, label);
      btn.onclick = () => { m.pieces[g.id] = m.pieces[g.id] === v ? undefined : v; save(); paint(); };
      return btn;
    });
    row.append(...buttons);
    body.append(row);
    const paintRow = () => {
      buttons.forEach((btn, j) => btn.classList.toggle('on', m.pieces[g.id] === ['right', 'wrong', 'not'][j]));
      box.classList.toggle('wrong', m.pieces[g.id] === 'wrong' || m.pieces[g.id] === 'not');
    };
    painters.push(paintRow);
  });
  const missed = el('div', 'missed');
  const input = el('input'); input.type = 'number'; input.min = '0'; input.value = m.missed ?? '';
  input.oninput = () => { m.missed = input.value === '' ? undefined : Math.max(0, Number(input.value)); save(); score(); };
  const all = el('button', null, 'All right');
  all.onclick = () => { for (const g of p.garments) m.pieces[g.id] = 'right'; if (m.missed == null) { m.missed = 0; input.value = '0'; } save(); paint(); };
  missed.append(el('span', null, 'Missed pieces:'), input, all);
  body.append(missed);
  if (p.tags.length) body.append(el('div', 'tags', p.tags.join(' · ')));
  card.append(photo, body);
  document.getElementById('grid').append(card);
}
function paint() { painters.forEach((f) => f()); score(); }
paint();

document.getElementById('copy').onclick = async () => {
  const s = score();
  const text = JSON.stringify({ promptVersion: data.promptVersion, model: data.model, photos: data.photos.length, ...s, costPer1000Usd: +(data.cost.perPhotoMicros / 1000).toFixed(2) });
  try { await navigator.clipboard.writeText(text); document.getElementById('copy').textContent = 'Copied'; } catch { prompt('Copy this:', text); }
};
</script>
</body>
</html>
`;
}
