const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const css = read('style.css');
const names = ['Lato-Regular', 'Lato-Medium', 'Lato-Italic'];
for (const name of names) {
  const packed = fs.readFileSync(path.join(root, 'assets', `${name}.woff2`));
  const source = fs.statSync(path.join(root, 'assets', `${name}.ttf`));
  assert.equal(packed.toString('ascii', 0, 4), 'wOF2', `${name}: WOFF2 signature`);
  assert.equal(packed.readUInt32BE(8), packed.length, `${name}: complete font file`);
  assert.ok(packed.length < source.size / 2, `${name}: worthwhile size reduction`);
  assert.ok(css.includes(`url('assets/${name}.woff2') format('woff2')`));
}
assert.ok(!css.includes('.ttf'), 'No TTF downloads from the shared stylesheet');
assert.equal((css.match(/font-display:swap/g) || []).length, 3);
for (const name of ['index', 'registration']) {
  const html = read(`${name}.html`);
  assert.match(html, /href="assets\/Lato-Regular\.woff2" as="font" type="font\/woff2" crossorigin/);
  assert.ok(!html.includes('.ttf'), `${name}: no duplicate TTF preload`);
}
assert.match(read('legal.css'), /@import[^;]+style\.css/);
assert.match(read('assets/Lato-OFL.txt'), /SIL OPEN FONT LICENSE/);
assert.match(read('registration.html'), /data-preview="true"/);
console.log('PASS: WOFF2 files, size savings, shared font sources, matching preloads and retained license.');
