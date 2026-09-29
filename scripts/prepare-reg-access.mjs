import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { getEncryptionKey, withAccountLock } from '../server/auth.mjs';
import { phpBinary } from './php-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dataDir = path.join(root, '.data');
const destination = path.join(dataDir, 'php-deployment');
const migrate = process.argv.includes('--migrate-local');
let input = '';
if (migrate) {
  // Snapshot under the same lock as a real login/reset. Never change the local account.
  input = await withAccountLock(dataDir, async () => {
    const account = JSON.parse(await readFile(path.join(dataDir, 'admin-auth.json'), 'utf8'));
    const key = await getEncryptionKey({ dataDir, create: false });
    return JSON.stringify({ account, encryptionKey: key.toString('hex') });
  });
}
const result = spawnSync(phpBinary, [path.join(root, 'hosting/prepare-access.php'), destination, ...(migrate ? ['--import-node'] : [])], { input, encoding: 'utf8', cwd: root });
if (result.error || result.status !== 0) {
  // PHP exceptions never include account values; do not print the private input.
  process.stderr.write(result.stderr || 'Unable to prepare private settings.\n');
  process.exit(1);
}
console.log('Private REG.RU settings prepared in .data/php-deployment. Read admin-access.txt locally; never publish this file.');
console.log('Existing local password and MFA are unchanged. The hosting account has a separate new password.');
