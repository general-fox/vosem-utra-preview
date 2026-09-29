import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const portable = fileURLToPath(new URL('../../.tools/php/php.exe', import.meta.url));
export const phpBinary = process.env.PHP_BIN || (process.platform === 'win32' && existsSync(portable) ? portable : 'php');
