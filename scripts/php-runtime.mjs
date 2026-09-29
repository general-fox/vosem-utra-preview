import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
const portable = fileURLToPath(new URL('../../.tools/php/php.exe', import.meta.url));
export const localRuntimeSettings = {};
for (const name of ['.env', '.env.local', '.env.development', '.env.development.local']) {
  try { Object.assign(localRuntimeSettings, parseEnv(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const settings = localRuntimeSettings;
export const phpBinary = process.env.PHP_BIN || settings.PHP_BIN || (process.platform === 'win32' && existsSync(portable) ? portable : 'php');
export const phpEnvironment = { ...(settings.PHPRC ? { PHPRC: settings.PHPRC } : {}), ...process.env };
