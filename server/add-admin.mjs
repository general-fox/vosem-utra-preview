import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { additionalAccountFile, makePasswordRecord, normalizeUsername, withAccountLock, atomicAuthWrite } from './auth.mjs';

/** Offline provisioning only. Never exposed through HTTP or included in a public build. */
export async function addAdministrator({ dataDir, username, now = Date.now() }) {
  username = normalizeUsername(username);
  if (!username.includes('@')) throw new Error('Укажите почту нового сотрудника.');
  return withAccountLock(dataDir, async () => {
    let primary;
    try { primary = JSON.parse(await readFile(path.join(dataDir, 'admin-auth.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const bootstrapUsername = normalizeUsername(process.env.ADMIN_USERNAME || 'admin');
    if (primary?.username === username || (!primary && bootstrapUsername === username)) throw new Error('Эта почта принадлежит основному аккаунту. Его данные не изменены.');
    const accountFile = additionalAccountFile(dataDir, username);
    try { await readFile(accountFile); throw new Error('Аккаунт уже существует. Его данные не изменены.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const password = randomBytes(24).toString('base64url');
    const initialExpiresAt = now + 7 * 24 * 60 * 60 * 1000;
    const account = { version: 2, secondary: true, username, credentialVersion: randomUUID(),
      password: await makePasswordRecord(password), totp: null, recovery: [], temporaryPassword: true, initialExpiresAt };
    const accessFile = path.join(dataDir, `admin-access-${randomBytes(6).toString('hex')}.txt`);
    await mkdir(path.dirname(accountFile), { recursive: true });
    await writeFile(accessFile, [
      'ЛОКАЛЬНЫЙ ДОСТУП — НЕ ПУБЛИКОВАТЬ И НЕ ДОБАВЛЯТЬ В GIT',
      `Почта: ${username}`, `Временный пароль: ${password}`,
      `Первый вход до: ${new Date(initialExpiresAt).toISOString()}`,
      'Откройте /admin.html на локальном сайте. Введите почту и временный пароль.',
      'Задайте новый отдельный пароль админки от 8 символов (не пароль от почты).',
      'Отсканируйте свой QR-код в Яндекс ID (Ключ), подтвердите код и сохраните резервные коды.',
      'После пароля и кода браузер автоматически запоминается на 30 дней. На чужом устройстве нажмите «Выйти» после работы.',
      'После успешной настройки временный пароль больше не работает.',
      'Этот файл содержит секрет. Передавайте лично, сохраните нужное в менеджере паролей и удалите файл вручную.',
      'GitHub Pages не выполняет серверный вход. Для REG.RU создаётся отдельный доступ по инструкции docs/admin-security.md.',
    ].join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    await atomicAuthWrite(accountFile, account);
    return { username, accessFile, initialExpiresAt };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const username = process.argv[2];
  if (!username || process.argv.length !== 3) { console.error('Использование: node server/add-admin.mjs email'); process.exitCode = 1; }
  else {
    try {
      const result = await addAdministrator({ dataDir: fileURLToPath(new URL('../.data/', import.meta.url)), username });
      console.log(`Добавлен отдельный локальный доступ: ${result.username}\nДанные первого входа (приватный файл): ${result.accessFile}`);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
