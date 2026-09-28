import { fileURLToPath } from 'node:url';
import { createTotpSecret, getEncryptionKey, makeEnrolledAccount, normalizeUsername } from './auth.mjs';
import { promptLine, saveAccount } from './auth-cli.mjs';

const dataDir = fileURLToPath(new URL('../.data/', import.meta.url));
try {
  console.log('Настройка одного администратора. Новый пароль и MFA заменят прежний доступ и завершат старые сессии.');
  const username = normalizeUsername((await promptLine('Почта администратора [v.utra@yandex.ru]: ')).trim() || 'v.utra@yandex.ru');
  const password = await promptLine('Новый пароль админ-панели (не пароль от почты, минимум 15 символов): ', { hidden: true });
  if (password.length < 15 || password.length > 1024) throw new Error('Пароль должен содержать от 15 до 1024 символов.');
  if (password !== await promptLine('Повторите пароль: ', { hidden: true })) throw new Error('Пароли не совпадают.');
  const key = await getEncryptionKey({ dataDir, production: process.env.NODE_ENV === 'production', create: true });
  const secret = createTotpSecret();
  console.log('\nОткройте Яндекс ID (Ключ): «+» → «Добавить вручную». Создайте отдельную запись для сайта.');
  console.log('Название сервиса: Восемь утра');
  console.log(`Логин на сервисе: ${username}`);
  console.log('Параметры: TOTP, 6 цифр, 30 секунд, SHA-1.');
  console.log(`Секрет для ручного ввода: ${secret}`);
  console.log(`URI: otpauth://totp/${encodeURIComponent(`Восемь утра:${username}`)}?secret=${secret}&issuer=${encodeURIComponent('Восемь утра')}&algorithm=SHA1&digits=6&period=30`);
  const code = await promptLine('Введите код записи «Восемь утра» из Яндекс ID (Ключ): ', { hidden: true });
  const { account, recoveryCodes } = await makeEnrolledAccount({ username, password, secret, code, key });
  await saveAccount(dataDir, account, 'credentials.mfa_enrolled');
  console.log('\nДоступ настроен. Резервные коды показываются только сейчас; каждый действует один раз после пароля:');
  for (const recoveryCode of recoveryCodes) console.log(recoveryCode);
  console.log('Сохраните коды в менеджере паролей отдельно от приложения-аутентификатора. Не отправляйте их в чат.');
  console.log(`Обычный вход: ${username} + пароль админ-панели + код записи «Восемь утра» в Яндекс ID (Ключ).`);
  console.log('Для production также обязательны HTTPS PUBLIC_ORIGIN и AUTH_ENCRYPTION_KEY.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
