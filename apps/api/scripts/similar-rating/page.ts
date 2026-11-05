// The "More like this" rating page (`pnpm similar:rate`): looks with their nearest looks, to judge.

export interface RatingPhoto {
  url: string;
  width: number;
  height: number;
  caption: string | null;
}

export interface RatingLook extends RatingPhoto {
  id: string;
  /** Its "More like this" from the top, as a logged-out visitor gets it. */
  similar: RatingPhoto[];
}

export interface RatingData {
  createdAt: string;
  /** The fingerprint model the looks were compared with. */
  model: string;
  looks: RatingLook[];
}

/**
 * One self-contained page. Captions are data, never HTML: the page puts them
 * in with textContent. Ratings are kept in the browser (localStorage).
 */
export function renderRatingPage(data: RatingData): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>More like this check</title>
<style>
  :root { color-scheme: light dark; --bg: #faf7f2; --fg: #2b2622; --muted: #7a7068; --card: #fff; --line: #e5ddd3; --ok: #2f7d4f; --bad: #b3412c; --meh: #b08a2c; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1d1a17; --fg: #f1ebe4; --muted: #a59b91; --card: #29241f; --line: #3b342d; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; font: 15px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  header { position: sticky; top: 0; z-index: 2; background: var(--bg); padding: 8px 0 12px; border-bottom: 1px solid var(--line); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .muted { color: var(--muted); font-size: 13px; }
  .score { font-size: 18px; font-weight: 600; margin-top: 6px; }
  .look { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px; margin-top: 16px; }
  .row { display: flex; gap: 12px; align-items: flex-start; }
  .base { flex: 0 0 180px; }
  .base img { width: 180px; height: auto; border-radius: 8px; display: block; }
  .strip { flex: 1; display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 8px; }
  .strip img { width: 100%; height: auto; border-radius: 6px; display: block; }
  .cap { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .buttons { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
  button { font: inherit; font-size: 13px; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; }
  button.on.good { background: var(--ok); color: #fff; border-color: var(--ok); }
  button.on.okay { background: var(--meh); color: #fff; border-color: var(--meh); }
  button.on.bad { background: var(--bad); color: #fff; border-color: var(--bad); }
  input.note { flex: 1; font: inherit; font-size: 13px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: var(--fg); }
  @media (max-width: 600px) { .row { flex-direction: column; } .base, .base img { width: 100%; flex-basis: auto; } }
</style>
</head>
<body>
<header>
  <h1>"More like this" check</h1>
  <div class="muted" id="meta"></div>
  <div class="muted">For each look, judge the looks next to it, as a whole: <b>good</b> (you'd happily scroll these under it), <b>okay</b> (some fit, some don't) or <b>bad</b>. A short note helps. Your ratings stay in this browser.</div>
  <div class="score" id="score"></div>
  <button id="copy">Copy results for Claude</button>
</header>
<div id="looks"></div>
<script>
const data = ${json};
const KEY = 'similar-rating:' + data.createdAt;
let marks = {};
try { marks = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(marks)); } catch {} };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const image = (photo) => { const img = el('img'); img.src = photo.url; img.width = photo.width; img.height = photo.height; img.loading = 'lazy'; img.alt = photo.caption || ''; return img; };

document.getElementById('meta').textContent =
  data.looks.length + ' looks · compared with ' + data.model + ' · made ' + data.createdAt.slice(0, 16).replace('T', ' ');

function score() {
  const counts = { good: 0, okay: 0, bad: 0 };
  for (const look of data.looks) { const m = marks[look.id]; if (m && m.rating) counts[m.rating] += 1; }
  const rated = counts.good + counts.okay + counts.bad;
  document.getElementById('score').textContent =
    rated + ' of ' + data.looks.length + ' rated · good ' + counts.good + ' · okay ' + counts.okay + ' · bad ' + counts.bad;
  return { rated, ...counts };
}

const painters = [];
for (const look of data.looks) {
  const m = (marks[look.id] ||= {});
  const card = el('div', 'look');
  const row = el('div', 'row');
  const base = el('div', 'base');
  base.append(image(look), el('div', 'cap', look.caption || ''));
  const strip = el('div', 'strip');
  for (const near of look.similar) { const cell = el('div'); cell.append(image(near), el('div', 'cap', near.caption || '')); strip.append(cell); }
  row.append(base, strip);
  const buttons = el('div', 'buttons');
  const options = [['good', 'good'], ['okay', 'okay'], ['bad', 'bad']].map(([value, label]) => {
    const btn = el('button', value, label);
    btn.onclick = () => { m.rating = m.rating === value ? undefined : value; save(); paint(); };
    return btn;
  });
  const note = el('input', 'note'); note.placeholder = 'Note (optional)'; note.value = m.note || '';
  note.oninput = () => { m.note = note.value; save(); };
  buttons.append(...options, note);
  card.append(row, buttons);
  document.getElementById('looks').append(card);
  painters.push(() => options.forEach((btn, i) => btn.classList.toggle('on', m.rating === ['good', 'okay', 'bad'][i])));
}
function paint() { painters.forEach((f) => f()); score(); }
paint();

document.getElementById('copy').onclick = async () => {
  const s = score();
  const notes = data.looks.flatMap((look) => { const m = marks[look.id] || {}; return m.rating || m.note ? [{ look: look.id, rating: m.rating || null, note: m.note || '' }] : []; });
  const text = JSON.stringify({ model: data.model, createdAt: data.createdAt, looks: data.looks.length, ...s, notes });
  try { await navigator.clipboard.writeText(text); document.getElementById('copy').textContent = 'Copied'; } catch { prompt('Copy this:', text); }
};
</script>
</body>
</html>
`;
}
