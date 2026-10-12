import { readFile, readdir, mkdir, cp, rename, lstat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { verifyPassword, withAccountLock, getEncryptionKey, normalizeUsername } from '../server/auth.mjs';
import { promptLine } from '../server/auth-cli.mjs';
import { phpBinary, phpEnvironment, localRuntimeSettings } from './php-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const optional = (file) => readFile(file).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
async function updateDrinksTemplate(projectRoot, runtime) {
  const bytes = await optional(path.join(projectRoot, 'public/data/drinks.json'));
  if (!bytes) return;
  const directory = path.join(runtime, 'app/seed');
  await mkdir(directory, { recursive:true, mode:0o700 });
  const target = path.join(directory, 'drinks.json');
  const previous = await optional(target);
  if (previous?.equals(bytes)) return;
  const temporary = path.join(directory, `drinks-${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { flag:'wx', mode:0o600 });
  await rename(temporary, target);
}
async function safeCopy(source, target) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error('Symbolic links are not supported in private migration.');
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    for (const name of await readdir(source)) await safeCopy(path.join(source, name), path.join(target, name));
  } else if (info.isFile()) await cp(source, target, { errorOnExist: true, force: false });
  else throw new Error('Unsupported private file.');
}

export async function prepareLocalPhp({ projectRoot = root, passwordProvider, php = phpBinary } = {}) {
  const dataDir = path.join(projectRoot, '.data');
  const destination = path.join(dataDir, 'php-runtime');
  try {
    await lstat(destination);
    if (!await optional(path.join(destination, 'admin-config.php'))) throw new Error('PHP-хранилище неполное. Сохраните его для проверки; автоматическая замена запрещена.');
    // Refresh only the public import template; never replace accounts or saved menu.
    await updateDrinksTemplate(projectRoot, destination);
    return { existing: true, destination };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const check = spawnSync(php, ['-r', 'exit(extension_loaded("openssl") && extension_loaded("gd") && in_array("sqlite", PDO::getAvailableDrivers(), true) ? 0 : 1);'], { env: phpEnvironment, encoding: 'utf8', windowsHide: true });
  if (check.error || check.status !== 0) throw new Error('Нужен PHP 8.3+ с OpenSSL, GD и PDO SQLite. Укажите PHP_BIN и PHPRC в .env.local.');
  const sources = new Map();
  const accounts = [];
  for (const name of ['admin-auth.json', 'admin-password.json']) {
    const bytes = await optional(path.join(dataDir, name));
    if (!bytes) continue;
    sources.set(name, bytes);
    if (name === 'admin-auth.json') accounts.push(JSON.parse(bytes));
  }
  if (!accounts.length && sources.has('admin-password.json')) accounts.push({ version: 2, username: 'admin', password: JSON.parse(sources.get('admin-password.json')), totp: null, recovery: [] });
  const extraFiles = await readdir(path.join(dataDir, 'admin-users')).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
  for (const name of extraFiles.sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const bytes = await readFile(path.join(dataDir, 'admin-users', name)); sources.set(`admin-users/${name}`, bytes);
    const account = JSON.parse(bytes);
    if (account.secondary !== true) throw new Error('Invalid secondary account');
    accounts.push(account);
  }
  const accessNotes = [];
  for (const name of await readdir(dataDir).catch((error) => { if (error.code === 'ENOENT') return []; throw error; })) {
    if (/^admin-access(?:-[a-f0-9]+)?\.txt$/.test(name)) accessNotes.push(await readFile(path.join(dataDir, name), 'utf8'));
  }
  const prepared = [];
  for (const account of accounts) {
    if (normalizeUsername(account.username) !== account.username) throw new Error('Invalid stored identity');
    let password;
    // Preserve unused temporary credentials only after checking their actual hash.
    if (account.temporaryPassword === true) {
      for (const note of accessNotes) {
        if (note.match(/^Почта: (.+)$/m)?.[1]?.trim() !== account.username) continue;
        const candidate = note.match(/^Временный пароль: (.+)$/m)?.[1]?.trim();
        if (candidate && await verifyPassword(candidate, account.password)) { password = candidate; break; }
      }
    }
    password ??= await (passwordProvider ?? (async (username) => {
      if (!process.stdin.isTTY) throw new Error(`Для переноса ${username} запустите npm run local:prepare в терминале. Пароль вводится скрыто, не присылайте его в чат.`);
      return promptLine(`Текущий пароль ${username} (скрытый ввод): `, { hidden: true });
    }))(account.username);
    if (!await verifyPassword(password, account.password)) throw new Error('Пароль не подтверждён. Перенос отменён; старые данные не изменены.');
    prepared.push({ account, password });
  }
  const key = accounts.some((account) => account.totp)
    ? await getEncryptionKey({ dataDir, encryptionKey: process.env.AUTH_ENCRYPTION_KEY || localRuntimeSettings.AUTH_ENCRYPTION_KEY, create: false }) : randomBytes(32);
  return withAccountLock(dataDir, async () => {
    for (const [name, bytes] of sources) if (!bytes.equals(await readFile(path.join(dataDir, name)))) throw new Error('Доступ изменился во время переноса. Повторите подготовку.');
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const backup = path.join(dataDir, 'legacy-backups', stamp);
    await mkdir(backup, { recursive: true, mode: 0o700 });
    for (const name of ['admin-auth.json', 'admin-password.json', 'admin-users', 'auth-key', 'menu.json', 'uploads']) {
      try { await lstat(path.join(dataDir, name)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      await safeCopy(path.join(dataDir, name), path.join(backup, name));
    }
    const staging = path.join(dataDir, `php-import-${stamp}`);
    await mkdir(staging, { mode: 0o700 });
    const result = spawnSync(php, [path.join(root, 'hosting/php/import-node.php'), staging], {
      env: phpEnvironment, windowsHide: true, encoding: 'utf8', input: JSON.stringify({ accounts: prepared, encryptionKey: key.toString('hex') }),
    });
    if (result.error || result.status !== 0) throw new Error('Не удалось подготовить PHP-аккаунты. Исходные данные и резервная копия сохранены.');
    const menu = await optional(path.join(dataDir, 'menu.json')) ?? await readFile(path.join(projectRoot, 'public/data/menu.json'));
    const parsed = JSON.parse(menu);
    if (!Array.isArray(parsed.items)) throw new Error('Некорректное меню. Перенос остановлен.');
    parsed.revision ??= 1;
    await mkdir(path.join(staging, 'admin-data'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(staging, 'admin-data/menu.json'), JSON.stringify(parsed), { flag: 'wx', mode: 0o600 });
    await mkdir(path.join(staging, 'app/seed'), { recursive: true, mode: 0o700 });
    await cp(path.join(projectRoot, 'public/data/menu.json'), path.join(staging, 'app/seed/menu.json'));
    await updateDrinksTemplate(projectRoot, staging);
    await writeFile(path.join(staging, '.local-development'), 'Local test data; do not publish test orders.\n', { flag: 'wx', mode: 0o600 });
    try { await lstat(path.join(dataDir, 'uploads')); await safeCopy(path.join(dataDir, 'uploads'), path.join(staging, 'admin-data/uploads')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Destination is new and never overwritten. The old Node storage remains intact.
    await rename(staging, destination);
    return { existing: false, destination, backup, accounts: prepared.length, items: parsed.items.length };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await prepareLocalPhp();
    console.log(result.existing ? 'Локальное PHP-хранилище уже подготовлено; рабочие данные сохранены.' : `Перенесено аккаунтов: ${result.accounts}; блюд: ${result.items}. Пароли и подключённые аутентификаторы сохранены.`);
    console.log(`Приватное хранилище: ${result.destination}`);
    if (result.backup) console.log(`Резервная копия прежних данных: ${result.backup}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
