// Recreates the HEIC fixtures. Needs macOS (sips).
// - iphone-12mp-gps.heic: a 4032×3024 photo-like image with GPS and camera
//   EXIF, encoded as HEIC (HEVC) like an iPhone does.
// - p3-red.heic: pure red converted to Display P3 (the iPhone colour space).
//   node test/fixtures/make-iphone-fixture.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const W = 4032;
const H = 3024;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(W)}" height="${String(H)}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#c9b8a3"/><stop offset="1" stop-color="#5a4636"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<rect x="1300" y="500" width="1400" height="1800" rx="120" fill="#1f2a44"/>
<rect x="1450" y="2300" width="500" height="600" fill="#2b2b2b"/>
<rect x="2050" y="2300" width="500" height="600" fill="#2b2b2b"/>
<circle cx="2000" cy="420" r="260" fill="#e8c4a6"/>
<rect x="2600" y="1500" width="420" height="320" rx="40" fill="#8a3324"/>
</svg>`;

const base = await sharp(Buffer.from(svg)).png().toBuffer();
// Light grain so it compresses like a photo, not a flat drawing.
const grain = await sharp({
  create: {
    width: W,
    height: H,
    channels: 3,
    background: '#808080',
    noise: { type: 'gaussian', mean: 128, sigma: 12 },
  },
})
  .png()
  .toBuffer();

const jpeg = join(mkdtempSync(join(tmpdir(), 'fixture-')), 'iphone.jpg');
await sharp(base)
  .composite([{ input: grain, blend: 'overlay' }])
  .withExif({
    IFD0: { Make: 'Apple', Model: 'iPhone 15' },
    IFD3: {
      GPSLatitudeRef: 'N',
      GPSLatitude: '59/1 19/1 3000/100',
      GPSLongitudeRef: 'E',
      GPSLongitude: '18/1 4/1 1200/100',
    },
  })
  .jpeg({ quality: 88 })
  .toFile(jpeg);

const out = new URL('./iphone-12mp-gps.heic', import.meta.url).pathname;
execFileSync('sips', ['-s', 'format', 'heic', '-s', 'formatOptions', '70', jpeg, '--out', out]);
console.log(`Wrote ${out}`);

const redSrgb = join(mkdtempSync(join(tmpdir(), 'fixture-')), 'red.jpg');
const redP3 = redSrgb.replace('red.jpg', 'red-p3.jpg');
await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 255, g: 0, b: 0 } } })
  .jpeg({ quality: 100 })
  .toFile(redSrgb);
execFileSync('sips', [
  '--matchTo',
  '/System/Library/ColorSync/Profiles/Display P3.icc',
  redSrgb,
  '--out',
  redP3,
]);
const p3Out = new URL('./p3-red.heic', import.meta.url).pathname;
execFileSync('sips', ['-s', 'format', 'heic', redP3, '--out', p3Out]);
console.log(`Wrote ${p3Out}`);
