import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { phpBinary, phpEnvironment } from './php-runtime.mjs';
const directory = fileURLToPath(new URL('../.data/php-runtime', import.meta.url));
if (process.argv.length !== 3) { console.error('Использование: npm run admin:add -- email'); process.exitCode = 1; }
else {
  const result = spawnSync(phpBinary, [fileURLToPath(new URL('../hosting/php/add-admin.php', import.meta.url)), directory, process.argv[2]], { env: phpEnvironment, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) process.exitCode = 1;
}
