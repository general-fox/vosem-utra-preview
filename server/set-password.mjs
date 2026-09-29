import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makePasswordRecord } from './auth.mjs';
import { promptLine, saveAccount } from './auth-cli.mjs';

const dataDir = fileURLToPath(new URL('../.data/', import.meta.url));
try {
  const generated = process.argv.includes('--generate');
  const password = generated ? randomBytes(24).toString('base64url') : await promptLine('Новый пароль администратора (не менее 8 символов): ', { hidden: true });
  if (!generated && password !== await promptLine('Повторите пароль: ', { hidden: true })) throw new Error('Пароли не совпадают.');
  const passwordRecord = await makePasswordRecord(password);
  const account = await saveAccount(dataDir, (current) => ({ version: 2, username: current?.username ?? 'admin', credentialVersion: randomUUID(), password: passwordRecord, totp: current?.totp ?? null, recovery: current?.recovery ?? [] }), 'credentials.password_changed');
  console.log('Пароль сохранён в виде scrypt-хеша. Прежние сессии будут отклонены. Настроенный MFA сохранён.');
  if (generated) console.log(`Сохраните пароль в менеджере паролей: ${password}`);
  if (!account.totp) console.log('Приложение ещё не подключено. Войдите на /admin.html с этим паролем и завершите подключение по QR на странице.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
