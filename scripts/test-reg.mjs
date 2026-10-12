import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { phpBinary, phpEnvironment } from './php-runtime.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
function run(command, args, quiet = false) {
  const result = spawnSync(command, args, { cwd: root, env: phpEnvironment, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' });
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
run(phpBinary, ['tests/php-loyalty-phone.php']);
run(phpBinary, ['hosting/tests/menu-drinks-test.php']);
for (const file of ['tests/php-auth.php', 'tests/php-password-reset.php', 'tests/php-admin-invitations.php', 'tests/php-ira-password-reset.php', 'hosting/tests/menu-site-test.php', 'hosting/tests/menu-categories-test.php', 'tests/php-orders.php', 'tests/php-staff-orders.php', 'tests/php-telegram.php', 'tests/php-kds-client.php', 'tests/php-kds-delivery.php', 'tests/php-menu-availability.php']) run(phpBinary, [file]);
run(process.execPath, ['--test', 'tests/php-http.test-reg.mjs', 'tests/orders-http.test-reg.mjs', 'tests/php-local.test-reg.mjs', 'tests/staff-http.test-reg.mjs']);
