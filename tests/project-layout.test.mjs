import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
async function sourceText(directory, recursive = false) {
  let result = '';
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (recursive && entry.isDirectory()) result += await sourceText(file, true);
    else if (entry.isFile() && /\.(?:html|css|js|mjs|php|json)$/.test(entry.name)) result += '\n' + await readFile(file, 'utf8');
  }
  return result;
}
const sources = await sourceText(root) + await sourceText(path.join(root, 'hosting'), true) + await sourceText(path.join(root, 'server'), true);

test('tracked source files contain no unresolved merge markers', async () => {
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  assert.equal(tracked.status, 0, tracked.stderr);
  const conflicts = [];
  for (const file of tracked.stdout.split('\0').filter(Boolean)) {
    if (!/\.(?:html|css|js|mjs|php|json|md|txt|yml|yaml)$/.test(file) && !/(?:^|\/)\.[^/]+$/.test(file)) continue;
    if (/^(?:<{7} .+|={7}|>{7} .+|\|{7} .+)\r?$/m.test(await readFile(path.join(root, file), 'utf8'))) conflicts.push(file);
  }
  assert.deepEqual(conflicts, [], 'Resolve both versions before committing');
});

test('all stable image and font references resolve after cleanup', async () => {
  const references = new Set([...sources.matchAll(/\bassets\/([A-Za-z0-9_.-]+\.(?:svg|webp|png|jpg|woff2|ttf))/g)].map(match => match[1]));
  assert.ok(references.size >= 18, 'Check actual source references, not an empty list');
  for (const name of references) assert.ok((await stat(path.join(root, 'assets', name))).isFile(), name);
});

test('assets contains used web resources, reproducible font sources and license notices only', async () => {
  const fontSources = new Set(['Lato-Regular.ttf', 'Lato-Medium.ttf', 'Lato-Italic.ttf', 'Lato-OFL.txt', 'Lato-WOFF2.txt']);
  for (const name of await readdir(path.join(root, 'assets'))) {
    assert.ok(fontSources.has(name) || sources.includes(name), `Unused asset: ${name}`);
  }
});

test('private data and cleanup archives stay out of Git', () => {
  const privateFiles = ['.env.local', '.data/php-runtime/admin-config.php', '.data/local-php/php.ini',
    '.data/private-backups/check.cafebackup', '.data/transfer-keys/check.key',
    'dist-reg/site/app.php', '_archive/old-site/index.html', 'old-release.zip',
    'vosem-utra-private/loyalty.php', 'orders-data/orders.sqlite'];
  const ignored = spawnSync('git', ['check-ignore', '--no-index', ...privateFiles], { cwd: root, encoding: 'utf8' });
  assert.equal(ignored.status, 0, ignored.stderr);
  assert.deepEqual(new Set(ignored.stdout.trim().split(/\r?\n/)), new Set(privateFiles));
  const tracked = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  assert.equal(tracked.status, 0, tracked.stderr);
  for (const file of tracked.stdout.trim().split(/\r?\n/)) {
    assert.doesNotMatch(file, /^(?:\.data|_archive|dist(?:-reg|-hosting)?|node_modules|vosem-utra-private)\//, file);
    assert.doesNotMatch(file, /(?:^|\/)(?:admin-config\.php|orders-config\.php|admin-access(?:-[^/]+)?\.txt)$|\.(?:cafebackup|key|sqlite(?:-wal|-shm|-journal)?|zip)$/, file);
  }
});
