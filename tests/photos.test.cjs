const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

function webpSize(file) {
  const data = fs.readFileSync(path.join(root, file));
  assert.equal(data.toString('ascii', 0, 4), 'RIFF');
  assert.equal(data.toString('ascii', 8, 12), 'WEBP');
  for (let offset = 12; offset + 8 < data.length;) {
    const type = data.toString('ascii', offset, offset + 4);
    const length = data.readUInt32LE(offset + 4), start = offset + 8;
    if (type === 'VP8X') return [data.readUIntLE(start + 4, 3) + 1, data.readUIntLE(start + 7, 3) + 1];
    if (type === 'VP8 ') return [data.readUInt16LE(start + 6) & 0x3fff, data.readUInt16LE(start + 8) & 0x3fff];
    offset = start + length + (length % 2);
  }
  throw new Error('Missing WebP dimensions: ' + file);
}

for (const [file, width, height] of [
  ['hero-two-cups-720.webp', 720, 720], ['hero-two-cups-1254.webp', 1254, 1254],
  ['coffee-soft-720.webp', 720, 1080], ['coffee-soft-853.webp', 853, 1280],
  ['breakfast-wide-720.webp', 720, 720], ['breakfast-wide-1254.webp', 1254, 1254],
  ['syrniki-wide-720.webp', 720, 720], ['syrniki-wide-1254.webp', 1254, 1254],
  ['cafe-barista-large-640.webp', 640, 843], ['cafe-barista-large-972.webp', 972, 1280],
]) {
  assert.deepEqual(webpSize('assets/' + file), [width, height]);
  assert.ok(fs.statSync(path.join(root, 'assets', file)).size < 450 * 1024, 'Photo weight is bounded');
}
// The former coffee/breakfast/pastry cards were replaced by the workshop.
const updatedImages = [...html.matchAll(/<img[^>]+src="assets\/cafe-barista-large[^>]+>/g)].map(m => m[0]);
assert.equal(updatedImages.length, 1);
assert.doesNotMatch(html, /src="assets\/brand-pastry.jpg"/, 'Former pastry image is no longer displayed');
for (const img of updatedImages) {
  assert.match(img, /loading="lazy"/);
  assert.match(img, /decoding="async"/);
  assert.match(img, /sizes="[^"]+"/);
  const candidates = img.match(/srcset="([^"]+)"/)[1].split(',');
  assert.equal(candidates.length, 2);
  for (const candidate of candidates) {
    const [, file, width] = candidate.trim().match(/^(\S+) (\d+)w$/);
    assert.equal(webpSize(file)[0], Number(width));
  }
}
const about = html.match(/<section[^>]+id="about"[\s\S]*?<\/section>/)[0];
assert.equal((about.match(/<img /g) || []).length, 1, 'One prominent barista, not overlapping illustrations');
assert.match(about, /cafe-barista-large-972.webp/);
assert.match(about, /<figcaption class="about-caption"/);
assert.doesNotMatch(about, /cafe-friends|about-detail|about-images|data-depth/);
assert.doesNotMatch(css, /\.about-detail|\.about-images/, 'No leftover offsets for the removed inset');
const hero = html.match(/<img class="hero-photo"[^>]+>/)[0];
assert.match(hero, /src="assets\/hero-two-cups-1254.webp"/);
assert.doesNotMatch(hero, /data-depth|loading="lazy"/, 'Hero remains prioritized and without parallax');
assert.match(css, /\.hero-photo\{object-position:50% 75%;transform:none\}/,
  'Two-cup hero is not tilted');
assert.doesNotMatch(css, /\.hero-visual \.hours-note/, 'Original overlaid hours card is retained');
const preload = html.match(/<link rel="preload" as="image"[^>]+>/)[0];
assert.equal(preload.match(/imagesrcset="([^"]+)"/)[1], hero.match(/srcset="([^"]+)"/)[1]);
assert.equal(preload.match(/imagesizes="([^"]+)"/)[1], hero.match(/sizes="([^"]+)"/)[1]);
// Workshop art now occupies the former intro cards; validate its actual image sources.
const workshop = html.match(/<section[^>]+id="morning"[\s\S]*?<\/section>/)[0];
const workshopCss = fs.readFileSync(path.join(root, 'workshop.css'), 'utf8');
assert.match(workshop, /class="workshop-section section wrap"/);
assert.doesNotMatch(workshop, /coffee-soft|breakfast-wide|syrniki-wide/);
assert.match(workshopCss, /url\(['"]?\.\/assets\/workshop-gingerbread\.png['"]?\)/);
const gift = workshop.match(/<img[^>]+src="assets\/workshop-gift\.png"[^>]+>/)[0];
assert.match(gift, /loading="lazy"/);
assert.match(gift, /decoding="async"/);
for (const [file, width, height] of [
  ['workshop-gingerbread.png', 1774, 887], ['workshop-gift.png', 1536, 1024],
]) {
  const png = fs.readFileSync(path.join(root, 'assets', file));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [width, height]);
  if (file === 'workshop-gift.png') {
    assert.equal(Number(gift.match(/width="(\d+)"/)[1]), width);
    assert.equal(Number(gift.match(/height="(\d+)"/)[1]), height);
  }
}
console.log('PASS: photo asset dimensions/weights, responsive barista, prioritized hero/preload, and current workshop artwork.');
