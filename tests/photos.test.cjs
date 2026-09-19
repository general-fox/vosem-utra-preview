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
  ['coffee-menu-720.webp', 720, 720], ['coffee-menu-1254.webp', 1254, 1254],
  ['syrniki-800.webp', 800, 533], ['syrniki-1280.webp', 1280, 853],
  ['breakfast-plate-800.webp', 800, 533], ['breakfast-plate-1280.webp', 1280, 853],
  ['cafe-barista-large-640.webp', 640, 843], ['cafe-barista-large-972.webp', 972, 1280],
]) {
  assert.deepEqual(webpSize('assets/' + file), [width, height]);
  assert.ok(fs.statSync(path.join(root, 'assets', file)).size < 450 * 1024, 'Photo weight is bounded');
}
const updatedImages = [...html.matchAll(/<img[^>]+src="assets\/(?:coffee-menu|syrniki|breakfast-plate|cafe-barista-large)[^>]+>/g)].map(m => m[0]);
assert.equal(updatedImages.length, 4);
assert.match(html, /data-depth="breakfast" src="assets\/breakfast-plate-1280.webp"/, 'Breakfast uses the supplied breakfast plate');
assert.match(html, /data-depth="pastry" src="assets\/syrniki-1280.webp"/, 'Syrniki are in the tea card');
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
assert.match(html, /class="hero-photo" src="assets\/coffee.webp"/, 'Hero photo is unchanged');
assert.match(css, /\.coffee-image img\{object-position:50% 25%\}/);

// Measured safe box of the complete wordmark in the expanded 1254px photograph.
// Test the two scroll extremes while the whole card is visible, plus reduced motion.
for (const viewport of [320, 375, 390, 430, 650, 768, 900, 1024, 1150, 1280, 1440]) {
  const mobile = viewport <= 650, viewportHeight = mobile ? 844 : 900;
  const width = mobile ? viewport - 40 : viewport <= 900 ? (viewport - 96) / 3 :
    viewport <= 1150 ? (viewport - 112) / 3 : (Math.min(1200, viewport - 96) - 48) / 3;
  const height = mobile ? 310 : viewport <= 900 ? 265 : viewport <= 1150 ? 300 : 344;
  for (const motion of [false, true]) {
    const travel = motion ? Math.min(mobile ? 22 : 64, height * .18) : 0;
    const bleed = motion ? Math.ceil(travel + 3) : 0;
    const boxHeight = height + bleed * 2;
    const scale = Math.max(width, boxHeight) / 1254;
    const cropTop = (1254 * scale - boxHeight) * .25;
    for (const top of [0, viewportHeight - height]) {
      const offset = travel * (viewportHeight / 2 - top - height / 2) / ((viewportHeight + height) / 2);
      const wordmarkTop = 316 * scale - cropTop - bleed + offset;
      const wordmarkBottom = 470 * scale - cropTop - bleed + offset;
      assert.ok(wordmarkTop >= 8 && wordmarkBottom < height - 8,
        `Wordmark remains inside the photo: ${viewport}px, motion=${motion}, top=${top}`);
    }
  }
}
console.log('PASS: responsive photo assets, dimensions/weights, single high-resolution barista, unchanged hero, and coffee wordmark crop through visible scroll range.');
