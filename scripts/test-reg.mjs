import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { phpBinary } from './php-runtime.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
function run(command, args, quiet = false) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' });
  if (result.error || result.status !== 0) {
    if (quiet) process.stderr.write(result.stdout + result.stderr);
    throw result.error || new Error(`${command} failed (${result.status})`);
  }
}
async function lint(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await lint(target);
    else if (entry.name.endsWith('.php')) run(phpBinary, ['-l', target], true);
  }
}
await lint(path.join(root, 'hosting'));
console.log('PHP syntax checks passed.');
for (const file of ['tests/php-auth.php', 'hosting/tests/menu-site-test.php', 'tests/php-orders.php']) run(phpBinary, [file]);
run(process.execPath, ['--test', 'tests/php-http.test-reg.mjs', 'tests/orders-http.test-reg.mjs']);
