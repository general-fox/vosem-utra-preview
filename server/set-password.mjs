import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { makePasswordRecord } from './menu-api.mjs';

const dataDir = fileURLToPath(new URL('../.data/', import.meta.url));

async function hiddenPassword(prompt) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error('Запустите команду в терминале или используйте флаг --generate.');
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') return finish(new Error('Отменено.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };
    process.stdin.on('data', onData);
  });
}

try {
  const generated = process.argv.includes('--generate');
  const password = generated ? randomBytes(24).toString('base64url') : await hiddenPassword('Новый пароль администратора (не менее 12 символов): ');
  if (!generated && password !== await hiddenPassword('Повторите пароль: ')) throw new Error('Пароли не совпадают.');
  const record = await makePasswordRecord(password);
  await mkdir(dataDir, { recursive: true });
  const temporary = path.join(dataDir, `admin-password.${randomBytes(8).toString('hex')}.tmp`);
  await writeFile(temporary, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path.join(dataDir, 'admin-password.json'));
  console.log('Пароль сохранён в виде хеша. Перезапустите сервер. ADMIN_PASSWORD в окружении имеет приоритет.');
  if (generated) console.log(`Сохраните пароль в менеджере паролей: ${password}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
