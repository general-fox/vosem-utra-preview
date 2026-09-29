import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { phpBinary, phpEnvironment } from './php-runtime.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const data = path.join(root, '.data');
const mode = process.argv[2];
try {
  let args;
  if (mode === 'backup' || mode === 'export') {
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const bundle = path.join(data, mode === 'backup' ? 'private-backups' : 'private-exports', `${id}.cafebackup`);
    const key = path.join(data, 'transfer-keys', `${id}.key`);
    await mkdir(path.dirname(bundle), { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(key), { recursive: true, mode: 0o700 });
    args = ['export', path.join(data, 'php-runtime'), bundle, key, ...(mode === 'backup' ? ['--include-orders'] : [])];
    console.log(`Зашифрованный пакет: ${bundle}\nОтдельный ключ: ${key}`);
  } else if (mode === 'restore' && process.argv.length === 7) {
    args = ['import', ...process.argv.slice(3)];
  } else throw new Error('Use private:backup, private:export or private:restore -- BUNDLE KEY NEW_DIRECTORY ORIGIN');
  const result = spawnSync(phpBinary, [path.join(root, 'hosting/php/private-data.php'), ...args], { env: phpEnvironment, windowsHide: true, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Private data operation failed; existing data was not replaced.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
