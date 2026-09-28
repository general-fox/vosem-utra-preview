import { appendFile, unlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicAuthWrite, withAccountLock } from './auth.mjs';

export function promptLine(prompt, { hidden = false } = {}) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error('Запустите настройку в интерактивном терминале.');
  process.stdout.write(prompt);
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') return finish(new Error('Отменено. Доступ не изменён.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') { if (value && !hidden) process.stdout.write('\b \b'); value = value.slice(0, -1); }
        else if (character >= ' ') { value += character; if (!hidden) process.stdout.write(character); }
      }
    };
    process.stdin.on('data', onData);
  });
}

export async function saveAccount(dataDir, accountOrUpdate, event) {
  return withAccountLock(dataDir, async () => {
    let current;
    try { current = JSON.parse(await readFile(path.join(dataDir, 'admin-auth.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const account = typeof accountOrUpdate === 'function' ? await accountOrUpdate(current) : accountOrUpdate;
    await atomicAuthWrite(path.join(dataDir, 'admin-auth.json'), account);
    await unlink(path.join(dataDir, 'admin-password.json')).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await appendFile(path.join(dataDir, 'security-audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), event, username: account.username }) + '\n', { mode: 0o600 });
    return account;
  });
}
