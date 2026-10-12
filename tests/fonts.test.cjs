const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { brotliDecompressSync } = require('node:zlib');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const css = read('style.css');
const knownTags = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];

function ttfTables(data) {
  const tables = new Map();
  for (let offset = 12; offset < 12 + data.readUInt16BE(4) * 16; offset += 16) {
    const start = data.readUInt32BE(offset + 8);
    tables.set(data.toString('ascii', offset, offset + 4), data.subarray(start, start + data.readUInt32BE(offset + 12)));
  }
  return tables;
}

function woffTables(data) {
  let cursor = 48;
  const length = () => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = data[cursor++];
      value = value * 128 + (byte & 127);
      if (!(byte & 128)) return value;
    }
    assert.fail('Malformed WOFF2 Base128 length');
  };
  const entries = [];
  for (let i = 0; i < data.readUInt16BE(12); i++) {
    const flag = data[cursor++];
    const index = flag & 63;
    const tag = index === 63 ? data.toString('ascii', cursor, cursor += 4) : knownTags[index];
    assert.equal(flag >> 6, ['glyf', 'loca'].includes(tag) ? 3 : 0, `${tag}: no table transform`);
    entries.push([tag, length()]);
  }
  const decoded = brotliDecompressSync(data.subarray(cursor, cursor + data.readUInt32BE(20)));
  let offset = 0;
  const tables = new Map(entries.map(([tag, size]) => {
    const table = decoded.subarray(offset, offset += size);
    return [tag, table];
  }));
  assert.equal(offset, decoded.length);
  return tables;
}

function assertNoGlyphHints(tables, style) {
  const count = tables.get('maxp').readUInt16BE(4);
  const loca = tables.get('loca');
  const longOffsets = tables.get('head').readInt16BE(50) === 1;
  const offset = id => longOffsets ? loca.readUInt32BE(id * 4) : loca.readUInt16BE(id * 2) * 2;
  const glyf = tables.get('glyf');
  for (let id = 0; id < count; id++) {
    const start = offset(id);
    if (start === offset(id + 1)) continue;
    const contours = glyf.readInt16BE(start);
    if (contours >= 0) {
      assert.equal(glyf.readUInt16BE(start + 10 + contours * 2), 0, `${style}: glyph ${id} has no hint instructions`);
    } else {
      let cursor = start + 10;
      let flags;
      do {
        flags = glyf.readUInt16BE(cursor);
        assert.equal(flags & 0x100, 0, `${style}: composite glyph ${id} has no hint instructions`);
        cursor += 4 + ((flags & 1) ? 4 : 2);
        cursor += (flags & 0x80) ? 8 : (flags & 0x40) ? 4 : (flags & 8) ? 2 : 0;
      } while (flags & 0x20);
    }
  }
}

for (const style of ['Regular', 'Medium', 'Italic']) {
  const name = `VosemSans-${style}`;
  const packed = fs.readFileSync(path.join(root, 'assets', `${name}.woff2`));
  const original = fs.readFileSync(path.join(root, 'assets', `Lato-${style}.ttf`));
  assert.equal(packed.toString('ascii', 0, 4), 'wOF2', `${name}: WOFF2 signature`);
  assert.equal(packed.readUInt32BE(8), packed.length, `${name}: complete font file`);
  assert.ok(packed.length < original.length / 2, `${name}: worthwhile size reduction`);
  assert.ok(fs.existsSync(path.join(root, 'assets', `Lato-${style}.woff2`)), 'Retain original WOFF2');
  const source = ttfTables(original);
  const tables = woffTables(packed);
  for (const tag of ['cmap', 'hmtx', 'hhea', 'OS/2', 'GDEF', 'GPOS', 'GSUB', 'post']) {
    assert.deepEqual(tables.get(tag), source.get(tag), `${name}: preserve ${tag}`);
  }
  for (const tag of ['fpgm', 'prep', 'cvt ']) assert.ok(!tables.has(tag), `${name}: no ${tag} hint program`);
  assertNoGlyphHints(tables, style);
  const names = tables.get('name');
  for (let offset = 6; offset < 6 + names.readUInt16BE(2) * 12; offset += 12) {
    if (names.readUInt16BE(offset) !== 3) continue;
    const id = names.readUInt16BE(offset + 6);
    if (![1, 3, 4, 6, 16].includes(id)) continue;
    const start = names.readUInt16BE(4) + names.readUInt16BE(offset + 10);
    const value = names.subarray(start, start + names.readUInt16BE(offset + 8));
    const text = String.fromCharCode(...Array.from({ length: value.length / 2 }, (_, i) => value.readUInt16BE(i * 2)));
    assert.match(text, /Vosem/);
    assert.doesNotMatch(text, /Lato/, 'Respect original Reserved Font Name');
  }
  assert.ok(css.includes(`url('assets/${name}.woff2') format('woff2')`));
}
assert.ok(!css.includes('.ttf'), 'No TTF downloads from the shared stylesheet');
assert.equal((css.match(/font-display:swap/g) || []).length, 3);
for (const name of ['index', 'registration', 'admin', 'checkout', 'hosting/legacy-public/registration']) {
  const html = read(`${name}.html`);
  assert.match(html, /href="assets\/VosemSans-Regular\.woff2" as="font" type="font\/woff2" crossorigin/);
  assert.ok(!html.includes('.ttf'), `${name}: no duplicate TTF preload`);
}
assert.match(read('legal.css'), /@import[^;]+style\.css/);
assert.match(read('assets/Lato-OFL.txt'), /SIL OPEN FONT LICENSE/);
assert.match(read('assets/VosemSans-WOFF2.txt'), /unhinted derivative/i);
assert.match(read('registration.html'), /data-preview="true"/);
console.log('PASS: unhinted webfonts, unchanged metrics/coverage/shaping, renamed family, shared sources and retained OFL.');
