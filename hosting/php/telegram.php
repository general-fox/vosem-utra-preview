<?php
declare(strict_types=1);

/** Telegram identity, durable bot jobs and notifications. No browser cookie auth. */
final class CafeTelegramException extends RuntimeException
{
    public array $details = [];
    public function __construct(public int $status, string $message, public string $errorCode, public ?int $retryAfter = null) { parent::__construct($message); }
}

final class CafeTelegram
{
    private Closure $configLoader;
    private ?Closure $transport;
    private ?Closure $snapshotLoader;
    private bool $migrated = false;
    private const SESSION_SECONDS = 7200;
    private const LEASE_SECONDS = 60;

    public function __construct(private string $privateDir, private array $site, private PDO $db, ?callable $transport = null, ?callable $configLoader = null, ?callable $snapshotLoader = null)
    {
        $this->transport = $transport ? Closure::fromCallable($transport) : null;
        $this->snapshotLoader = $snapshotLoader ? Closure::fromCallable($snapshotLoader) : null;
        $this->configLoader = $configLoader ? Closure::fromCallable($configLoader) : function (): array {
            $path = rtrim($this->privateDir, '/\\').'/telegram-config.php';
            if (!is_file($path)) return [];
            if (function_exists('opcache_invalidate')) @opcache_invalidate($path, true);
            $value = require $path;
            return is_array($value) ? $value : [];
        };
    }
    private function now(): int { return isset($this->site['telegram_clock']) ? (int)($this->site['telegram_clock'])() : time(); }
    private function environment(): string { return ($this->site['telegram_environment'] ?? 'production') === 'staging' ? 'staging' : 'production'; }
    private static function botHash(array $c): string { return hash('sha256',$c['botToken']."\0".$c['environment']); }
    private static function json(mixed $value): string { return json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR); }
    private static function iso(int $time): string { return gmdate('Y-m-d\TH:i:s\Z', $time); }
    private static function id(mixed $value, bool $group = false): ?string
    {
        if (!is_int($value) && !is_string($value)) return null;
        $value = (string)$value;
        if (!preg_match($group ? '/^-[1-9][0-9]{0,15}$/D' : '/^[1-9][0-9]{0,15}$/D', $value) || abs((int)$value) > 9007199254740991) return null;
        return $value;
    }
    private function config(bool $required = true): array
    {
        try { $c = ($this->configLoader)(); } catch (Throwable) { $c = []; }
        $valid = is_array($c) && ($c['enabled'] ?? false) === true
            && in_array($c['environment'] ?? null,['production','staging'],true) && $c['environment'] === $this->environment()
            && is_string($c['botToken'] ?? null) && preg_match('/^[1-9][0-9]{4,19}:[A-Za-z0-9_-]{30,100}$/D', $c['botToken'])
            && is_string($c['webhookSecret'] ?? null) && preg_match('/^[A-Za-z0-9_-]{32,256}$/D', $c['webhookSecret'])
            && !hash_equals(str_replace(':','',$c['botToken']), $c['webhookSecret'])
            && is_string($c['botUsername'] ?? null) && preg_match('/^[A-Za-z][A-Za-z0-9_]{4,31}$/D', $c['botUsername'])
            && is_string($c['webAppUrl'] ?? null) && self::httpsUrl($c['webAppUrl'])
            && is_array($c['staff'] ?? null) && count($c['staff']) <= 200
            && in_array($c['notifications']['mode'] ?? null, ['private','group'], true)
            && is_string($c['notifications']['miniAppName'] ?? null) && preg_match('/^[A-Za-z0-9_]{0,64}$/D', $c['notifications']['miniAppName'])
            && is_string($c['responsibleContact'] ?? null) && strlen($c['responsibleContact']) <= 1000;
        if ($valid && $c['notifications']['mode'] === 'group') $valid = self::id($c['notifications']['groupChatId'] ?? null, true) !== null;
        $ids = [];
        if ($valid) foreach ($c['staff'] as $person) {
            $id = is_array($person) ? self::id($person['id'] ?? null) : null;
            if ($id === null || isset($ids[$id]) || !is_string($person['name'] ?? null) || trim($person['name']) === '' || strlen($person['name']) > 400 || !preg_match('//u',$person['name']) || !in_array($person['role'] ?? null,['employee','manager'],true) || !is_bool($person['active'] ?? null)) { $valid = false; break; }
            $ids[$id] = true;
        }
        if (!$valid) {
            if ($required) throw new CafeTelegramException(503, 'Приложение сотрудников пока не подключено.', 'telegram_disabled');
            return [];
        }
        return $c;
    }
    private static function httpsUrl(string $url): bool
    {
        $p = parse_url($url);
        return strlen($url) <= 2048 && filter_var($url,FILTER_VALIDATE_URL) !== false && is_array($p) && ($p['scheme'] ?? '') === 'https' && !empty($p['host']) && !isset($p['user']) && !isset($p['pass']) && !isset($p['query']) && !isset($p['fragment']);
    }
    private static function member(array $config, string $id): ?array
    {
        foreach ($config['staff'] as $person) if ((string)$person['id'] === $id && $person['active'] === true) return ['id'=>$id,'name'=>$person['name'],'role'=>$person['role'],'active'=>true];
        return null;
    }
    public function staffMember(string $id): ?array { $c = $this->config(false); return $c ? self::member($c,$id) : null; }
    /** Trusted wrapper must authenticate before exposing this roster. */
    public function activeStaff(): array
    {
        $c = $this->config(false); if (!$c) return [];
        return array_values(array_map(static fn(array $p): array => ['id'=>(string)$p['id'],'name'=>$p['name'],'role'=>$p['role'],'active'=>true], array_filter($c['staff'],static fn(array $p): bool => $p['active'])));
    }
    public function enabled(): bool { return $this->config(false) !== []; }
    private function statement(string $sql, array $params = []): PDOStatement { $s = $this->db->prepare($sql); $s->execute($params); return $s; }
    private function transaction(callable $fn): mixed
    {
        $this->db->exec('BEGIN IMMEDIATE');
        try { $result = $fn(); $this->db->exec('COMMIT'); return $result; }
        catch (Throwable $e) { $this->db->exec('ROLLBACK'); throw $e; }
    }
    private function migrate(): void
    {
        if ($this->migrated) return;
        if ($this->db->getAttribute(PDO::ATTR_DRIVER_NAME) !== 'sqlite') throw new RuntimeException('Telegram storage requires SQLite');
        $this->db->setAttribute(PDO::ATTR_ERRMODE,PDO::ERRMODE_EXCEPTION); $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE,PDO::FETCH_ASSOC);
        $this->db->exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
        $this->transaction(function (): void {
            $this->db->exec('CREATE TABLE IF NOT EXISTS telegram_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, bot_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS telegram_limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS telegram_updates (bot_hash TEXT NOT NULL, update_id INTEGER NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'pending\', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(bot_hash,update_id));
                CREATE TABLE IF NOT EXISTS telegram_chats (user_id TEXT NOT NULL, chat_id TEXT NOT NULL, bot_hash TEXT NOT NULL, registered_at INTEGER NOT NULL, PRIMARY KEY(user_id,bot_hash));
                CREATE TABLE IF NOT EXISTS telegram_messages (order_id TEXT NOT NULL REFERENCES orders(id), chat_id TEXT NOT NULL, user_id TEXT, kind TEXT NOT NULL, bot_hash TEXT NOT NULL, message_id INTEGER, sent_hash TEXT, generation INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT \'pending\', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(order_id,chat_id,bot_hash));
                CREATE TABLE IF NOT EXISTS telegram_meta (name TEXT PRIMARY KEY,value INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS telegram_events (notification_id TEXT PRIMARY KEY REFERENCES notifications(id), processed_at INTEGER NOT NULL);
                CREATE INDEX IF NOT EXISTS telegram_messages_due ON telegram_messages(status,next_attempt_at);
                CREATE INDEX IF NOT EXISTS telegram_updates_due ON telegram_updates(status,next_attempt_at);
                CREATE INDEX IF NOT EXISTS telegram_sessions_expiry ON telegram_sessions(expires_at);');
        });
        $this->migrated = true;
    }
    private function limit(string $peer): void
    {
        $this->migrate(); $this->transaction(function () use ($peer): void {
            $now = $this->now(); $this->statement('DELETE FROM telegram_limits WHERE expires_at <= ?',[$now]);
            $limits = ['auth:global'=>1000,'auth:peer:'.hash('sha256',$peer)=>30];
            foreach ($limits as $bucket=>$max) { $row = $this->statement('SELECT count,expires_at FROM telegram_limits WHERE bucket=?',[$bucket])->fetch(); if ($row && $row['count'] >= $max) throw new CafeTelegramException(429,'Слишком много попыток. Откройте приложение позже.','rate_limited',max(1,$row['expires_at']-$now)); }
            foreach ($limits as $bucket=>$max) $this->statement('INSERT INTO telegram_limits VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1',[$bucket,$now+300]);
            $this->statement('DELETE FROM telegram_sessions WHERE expires_at<=?',[$now]);
        });
    }
    /** Official HMAC scheme: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app */
    public static function verifyInitData(string $raw, string $botToken, int $now): string
    {
        $reject = static function (): never { throw new CafeTelegramException(401,'Откройте приложение заново через Telegram.','telegram_auth'); };
        if ($raw === '' || strlen($raw) > 16384 || preg_match('/%(?![0-9A-Fa-f]{2})/',$raw)) $reject();
        $fields = [];
        foreach (explode('&',$raw) as $pair) {
            $parts = explode('=',$pair,2); if (count($parts) !== 2) $reject();
            $key = urldecode($parts[0]); $value = urldecode($parts[1]);
            if (!preg_match('/^[a-z_]{1,64}$/D',$key) || array_key_exists($key,$fields) || preg_match('/[\x00\r\n]/',$value) || !preg_match('//u',$value)) $reject();
            $fields[$key] = $value;
        }
        $hash = $fields['hash'] ?? ''; unset($fields['hash']);
        if (!preg_match('/^[a-f0-9]{64}$/D',$hash) || !preg_match('/^[1-9][0-9]{8,11}$/D',$fields['auth_date'] ?? '')) $reject();
        $date = (int)$fields['auth_date']; if ($date < $now - 300 || $date > $now + 30) $reject();
        ksort($fields,SORT_STRING); $parts = []; foreach ($fields as $key=>$value) $parts[] = $key.'='.$value;
        $secret = hash_hmac('sha256',$botToken,'WebAppData',true);
        if (!hash_equals(hash_hmac('sha256',implode("\n",$parts),$secret),$hash)) $reject();
        try { $user = json_decode($fields['user'] ?? '',true,16,JSON_THROW_ON_ERROR); } catch (Throwable) { $reject(); }
        if (!is_array($user) || array_is_list($user) || ($user['is_bot'] ?? false) === true || self::id($user['id'] ?? null) === null) $reject();
        return (string)$user['id'];
    }
    public function authenticate(string $initData, string $peer = 'unknown'): array
    {
        $c = $this->config(); $this->limit($peer);
        $id = self::verifyInitData($initData,$c['botToken'],$this->now()); $staff = self::member($c,$id);
        if (!$staff) throw new CafeTelegramException(403,'Доступ только для сотрудников.','staff_denied');
        $token = bin2hex(random_bytes(32)); $expires = $this->now()+self::SESSION_SECONDS;
        $this->transaction(function () use ($id,$token,$expires,$c): void {
            $this->statement('INSERT INTO telegram_sessions VALUES(?,?,?,?)',[hash('sha256',$token),$id,self::botHash($c),$expires]);
            // Bound simultaneous sessions without storing the raw launch payload or token.
            $this->statement('DELETE FROM telegram_sessions WHERE user_id=? AND bot_hash=? AND token_hash NOT IN (SELECT token_hash FROM telegram_sessions WHERE user_id=? AND bot_hash=? ORDER BY expires_at DESC,rowid DESC LIMIT 20)',[$id,self::botHash($c),$id,self::botHash($c)]);
        });
        return ['token'=>$token,'expiresAt'=>self::iso($expires),'staff'=>$staff];
    }
    public function session(string $token): array
    {
        $c = $this->config(); $this->migrate();
        if (!preg_match('/^[a-f0-9]{64}$/D',$token)) throw new CafeTelegramException(401,'Откройте приложение заново через Telegram.','session_expired');
        $row = $this->statement('SELECT * FROM telegram_sessions WHERE token_hash=?',[hash('sha256',$token)])->fetch();
        if (!$row || $row['expires_at'] <= $this->now() || !hash_equals($row['bot_hash'],self::botHash($c))) throw new CafeTelegramException(401,'Откройте приложение заново через Telegram.','session_expired');
        $staff = self::member($c,$row['user_id']);
        if (!$staff) throw new CafeTelegramException(403,'Доступ сотрудника отозван.','staff_denied');
        return $staff;
    }
    public function logout(string $token): void { $this->migrate(); if (preg_match('/^[a-f0-9]{64}$/D',$token)) $this->statement('DELETE FROM telegram_sessions WHERE token_hash=?',[hash('sha256',$token)]); }
    public function checkRequestSecurity(?string $origin, ?string $fetchSite, bool $https, string $peer, bool $mutation): void
    {
        $p = parse_url((string)($this->site['public_origin'] ?? ''));
        $dev = ($this->site['allow_http_dev'] ?? false) === true && is_array($p) && ($p['scheme'] ?? '') === 'http' && in_array($p['host'] ?? '',['localhost','127.0.0.1','[::1]','::1'],true) && in_array($peer,['127.0.0.1','::1'],true);
        if (!$https && !$dev) throw new CafeTelegramException(400,'Приложение сотрудников доступно только по HTTPS.','https_required');
        if (($mutation && $origin !== ($this->site['public_origin'] ?? '')) || in_array($fetchSite,['cross-site','same-site'],true)) throw new CafeTelegramException(403,'Откройте приложение на настроенном сайте.','origin');
    }
    /** Verify the secret before parsing/body processing in the HTTP wrapper as well. */
    public function verifyWebhookSecret(string $secret): void
    {
        $c = $this->config(); if ($secret === '' || !hash_equals($c['webhookSecret'],$secret)) throw new CafeTelegramException(403,'Запрос отклонён.','webhook_secret');
    }
    public function webhook(string $secret, array $update): array
    {
        $this->verifyWebhookSecret($secret); $c = $this->config(); $this->migrate();
        if (!is_int($update['update_id'] ?? null) || $update['update_id'] < 0 || strlen(self::json($update)) > 65536) throw new CafeTelegramException(400,'Некорректный запрос.','invalid_update');
        $m = $update['message'] ?? null; $payload = [];
        if (is_array($m) && ($m['from']['is_bot'] ?? false) !== true && is_string($m['text'] ?? null) && strlen($m['text']) <= 4096) {
            $id = self::id($m['from']['id'] ?? null); $private = ($m['chat']['type'] ?? '') === 'private';
            $chat = self::id($m['chat']['id'] ?? null,!$private);
            if ($id && $chat && (!$private || $chat === $id) && preg_match('/^\/(start|orders|help|id)(?:@([A-Za-z0-9_]{5,32}))?(?:\s|$)/D',$m['text'],$match)
                && (empty($match[2]) || strcasecmp($match[2],$c['botUsername']) === 0)) $payload = ['id'=>$id,'chat'=>$chat,'private'=>$private,'command'=>$match[1]];
        }
        $this->transaction(function () use ($c,$update,$payload): void {
            $hash = self::botHash($c);
            if ($this->statement('SELECT 1 FROM telegram_updates WHERE bot_hash=? AND update_id=?',[$hash,$update['update_id']])->fetchColumn()) return;
            $now=$this->now(); $status=$payload ? 'pending' : 'ignored';
            $this->statement('DELETE FROM telegram_limits WHERE expires_at<=?',[$now]);
            $this->statement('DELETE FROM telegram_updates WHERE created_at<? AND status IN (\'sent\',\'ignored\',\'skipped\')',[$now-604800]);
            if ($payload) {
                // A public bot must not let command spam starve order notifications.
                foreach (['command:global'=>60,'command:chat:'.hash('sha256',$payload['chat'])=>5] as $bucket=>$max) {
                    $count=$this->statement('SELECT count FROM telegram_limits WHERE bucket=?',[$bucket])->fetchColumn();
                    if ($count !== false && $count >= $max) $status='ignored';
                }
                if ($status === 'pending') foreach (['command:global','command:chat:'.hash('sha256',$payload['chat'])] as $bucket) $this->statement('INSERT INTO telegram_limits VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1',[$bucket,$now+60]);
            }
            $this->statement('INSERT INTO telegram_updates(bot_hash,update_id,payload,status,created_at) VALUES(?,?,?,?,?)',[$hash,$update['update_id'],self::json($payload),$status,$now]);
        });
        return ['ok'=>true];
    }
    private function snapshot(string $id): ?array
    {
        $row = $this->statement('SELECT * FROM orders WHERE id=?',[$id])->fetch(); if (!$row) return null;
        if (($row['environment'] ?? null) !== $this->environment()) return null;
        if ($this->snapshotLoader) { try { return ($this->snapshotLoader)($id); } catch (Throwable) { return null; } }
        if (!empty($row['staff_snapshot'])) return json_decode($row['staff_snapshot'],true,64,JSON_THROW_ON_ERROR);
        $request = json_decode($row['original_request'],true,64,JSON_THROW_ON_ERROR); $order = json_decode($row['snapshot'],true,64,JSON_THROW_ON_ERROR);
        return ['id'=>$row['id'],'version'=>(int)($row['version'] ?? 1),'assignee'=>null] + $order + $request;
    }
    private static function shorten(string $text, int $length): string
    {
        $text = preg_replace('/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u','',$text) ?? '';
        preg_match_all('/./us',$text,$chars); $result=''; $units=0;
        foreach ($chars[0] as $char) { $size=strlen($char) === 4 ? 2 : 1; if ($units+$size > $length-1) return $result.'…'; $result.=$char; $units+=$size; }
        return $result;
    }
    private static function money(mixed $minor): string { return is_int($minor) ? number_format($minor/100,($minor % 100) ? 2 : 0,',',' ').' ₽' : 'после подтверждения'; }
    public static function notificationText(array $o, bool $private): string
    {
        $status = ['new'=>'Новый','processing'=>'На согласовании','accepted'=>'Принят','cancelled'=>'Отменён'][$o['status'] ?? ''] ?? 'Требует проверки';
        $f = $o['fulfilment'] ?? [];
        $parts = ['Заказ №'.($o['number'] ?? '').' · '.$status,'Создан: '.($o['createdAt'] ?? ''),($f['type'] ?? '') === 'pickup' ? 'Самовывоз' : 'Доставка'];
        $when = $f['confirmedAt'] ?? (($f['timing'] ?? '') === 'scheduled' ? ($f['requestedAt'] ?? '') : 'Как можно скорее'); $parts[] = 'Время: '.$when;
        if ($private) {
            if (!empty($o['assignee']['name'])) $parts[] = 'Ответственный: '.$o['assignee']['name'];
            if (!empty($o['contact']['name'])) $parts[] = 'Гость: '.$o['contact']['name'];
            $parts[] = 'Телефон: '.($o['contact']['phone'] ?? '');
            if (($f['type'] ?? '') === 'delivery') { $a = $f['address'] ?? []; $address = []; foreach (['city'=>'','streetHouse'=>'','apartment'=>'кв./офис ','entrance'=>'подъезд ','floor'=>'этаж ','intercom'=>'домофон '] as $key=>$label) if (!empty($a[$key])) $address[] = $label.$a[$key]; $parts[] = 'Адрес: '.implode(', ',$address); }
            $lines = []; foreach (array_slice($o['items'] ?? [],0,12) as $line) $lines[] = self::shorten((string)($line['name'] ?? ''),70).' × '.($line['quantity'] ?? '').' = '.self::money($line['lineTotalMinor'] ?? null);
            if (count($o['items'] ?? []) > 12) $lines[] = 'Остальные блюда — в карточке заказа.';
            $parts[] = implode("\n",$lines);
        }
        $parts[] = 'Блюда: '.self::money($o['subtotalMinor'] ?? null); $parts[] = 'Доставка: '.self::money($o['deliveryFeeMinor'] ?? null); $parts[] = 'Итого: '.self::money($o['totalMinor'] ?? null);
        if ($private) {
            if (!empty($o['orderComment'])) $parts[] = 'Комментарий гостя: '.self::shorten($o['orderComment'],450);
            if (!empty($f['courierInstructions'])) $parts[] = 'Указания курьеру: '.self::shorten($f['courierInstructions'],250);
            if (!empty($o['fulfillmentComment'])) $parts[] = 'Для исполнения: '.self::shorten($o['fulfillmentComment'],250);
        }
        // Truncate plaintext first: no broken tags or entities, full details remain in the app.
        return htmlspecialchars(self::shorten(implode("\n",$parts),3500),ENT_QUOTES | ENT_SUBSTITUTE,'UTF-8');
    }
    private static function button(array $c, ?string $id, bool $private): array
    {
        $label = $id ? 'Открыть заказ' : 'Открыть список заказов';
        if ($private) return ['inline_keyboard'=>[[['text'=>$label,'web_app'=>['url'=>$c['webAppUrl'].($id ? '?order='.rawurlencode($id) : '')]]]]];
        $name = $c['notifications']['miniAppName']; $url = 'https://t.me/'.$c['botUsername'].($name !== '' ? '/'.$name : '').'?startapp='.($id ? 'order_'.rawurlencode($id) : 'orders');
        return ['inline_keyboard'=>[[['text'=>$label,'url'=>$url]]]];
    }
    private function recipients(array $c): array
    {
        if ($c['notifications']['mode'] === 'group') return [['chat'=>(string)$c['notifications']['groupChatId'],'user'=>null,'kind'=>'group']];
        $result = []; $hash = self::botHash($c);
        foreach ($this->statement('SELECT user_id,chat_id FROM telegram_chats WHERE bot_hash=?',[$hash])->fetchAll() as $row) if (self::member($c,$row['user_id'])) $result[] = ['chat'=>$row['chat_id'],'user'=>$row['user_id'],'kind'=>'private'];
        return $result;
    }
    private function allowedRecipient(array $c, array $job): bool
    {
        if (!hash_equals($job['bot_hash'],self::botHash($c))) return false;
        if ($job['kind'] === 'group') return $c['notifications']['mode'] === 'group' && (string)$c['notifications']['groupChatId'] === $job['chat_id'];
        return $c['notifications']['mode'] === 'private' && self::member($c,(string)$job['user_id']) !== null
            && $this->statement('SELECT 1 FROM telegram_chats WHERE user_id=? AND chat_id=? AND bot_hash=?',[$job['user_id'],$job['chat_id'],$job['bot_hash']])->fetchColumn() !== false;
    }
    private function expandNotifications(array $c, float $deadline): void
    {
        $recipients = $this->recipients($c); if (!$recipients) return;
        $this->transaction(function () use ($c,$recipients,$deadline): void {
            $events = $this->statement('SELECT n.id,n.order_id FROM notifications n JOIN orders o ON o.id=n.order_id LEFT JOIN telegram_events t ON t.notification_id=n.id WHERE t.notification_id IS NULL AND o.environment=? ORDER BY n.created_at,n.id LIMIT 200',[$this->environment()])->fetchAll();
            foreach ($events as $event) {
                if (microtime(true)>=$deadline) break;
                foreach ($recipients as $to) $this->statement('INSERT INTO telegram_messages(order_id,chat_id,user_id,kind,bot_hash,status,updated_at) VALUES(?,?,?,?,?,\'pending\',?) ON CONFLICT(order_id,chat_id,bot_hash) DO UPDATE SET generation=telegram_messages.generation+1,status=CASE WHEN telegram_messages.status=\'sending\' THEN \'sending\' ELSE \'pending\' END,attempts=CASE WHEN telegram_messages.status=\'sending\' THEN telegram_messages.attempts ELSE 0 END,next_attempt_at=0,updated_at=excluded.updated_at',[$event['order_id'],$to['chat'],$to['user'],$to['kind'],self::botHash($c),$this->now()]);
                $this->statement('INSERT OR IGNORE INTO telegram_events VALUES(?,?)',[$event['id'],$this->now()]);
            }
        });
    }
    private function claim(string $table): ?array
    {
        if (!in_array($table,['telegram_updates','telegram_messages'],true)) throw new LogicException('Invalid Telegram queue');
        $hash=self::botHash($this->config());
        return $this->transaction(function () use ($table,$hash): ?array {
            $now = $this->now(); $pause = $this->statement('SELECT value FROM telegram_meta WHERE name=?',['pause_until:'.$hash])->fetchColumn(); if ($pause !== false && (int)$pause > $now) return null;
            $row = $this->statement('SELECT rowid AS queue_id,* FROM '.$table.' WHERE bot_hash=? AND ((status IN (\'pending\',\'retry\') AND next_attempt_at<=?) OR (status=\'sending\' AND lease_until<=?)) ORDER BY rowid LIMIT 1',[$hash,$now,$now])->fetch();
            if (!$row) return null; $lease = bin2hex(random_bytes(16));
            $this->statement('UPDATE '.$table.' SET status=\'sending\',lease_token=?,lease_until=?,attempts=attempts+1 WHERE rowid=?',[$lease,$now+self::LEASE_SECONDS,$row['queue_id']]);
            $row['lease_token']=$lease; $row['attempts']++; return $row;
        });
    }
    private function finish(string $table, array $job, array $changes): void
    {
        $set = []; $values = []; foreach ($changes as $column=>$value) {
            if ($table === 'telegram_messages' && $column === 'status' && in_array($value,['sent','retry','failed'],true)) { $set[]="status=CASE WHEN generation>? THEN 'pending' ELSE ? END"; $values[]=$job['generation'];$values[]=$value;$set[]='attempts=CASE WHEN generation>? THEN 0 ELSE attempts END';$values[]=$job['generation']; }
            else { $set[] = $column.'=?'; $values[] = $value; }
        }
        $values[] = $job['queue_id']; $values[] = $job['lease_token'];
        $this->statement('UPDATE '.$table.' SET '.implode(',',$set).',lease_token=NULL,lease_until=0 WHERE rowid=? AND lease_token=?',$values);
    }
    private function failure(string $table, array $job, string $code, ?int $after = null, bool $permanent = false): void
    {
        $delay = $after ?? min(3600,15 * (2 ** min(8,$job['attempts']-1)));
        $delay = max(1,min(604800,$delay));
        $this->transaction(function () use ($table,$job,$code,$after,$delay,$permanent): void {
            if ($after !== null) $this->statement('INSERT INTO telegram_meta VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=MAX(value,excluded.value)',['pause_until:'.$job['bot_hash'],$this->now()+$delay]);
            $this->finish($table,$job,['status'=>$permanent || $job['attempts'] >= 8 ? 'failed' : 'retry','last_error'=>$code,'next_attempt_at'=>$this->now()+$delay]);
        });
    }
    /** Network endpoint is fixed, TLS verified, redirects disabled. Never log response bodies. */
    private function call(array $c, string $method, array $body): array
    {
        if ($this->transport) return ($this->transport)($method,$body);
        if (!extension_loaded('curl')) throw new RuntimeException('Telegram transport unavailable');
        $handle = curl_init('https://api.telegram.org/bot'.$c['botToken'].'/'.$method);
        $buffer = ''; curl_setopt_array($handle,[CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>self::json($body),CURLOPT_HTTPHEADER=>['Content-Type: application/json'],CURLOPT_CONNECTTIMEOUT=>5,CURLOPT_TIMEOUT=>15,CURLOPT_FOLLOWLOCATION=>false,CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2,CURLOPT_PROTOCOLS=>CURLPROTO_HTTPS,CURLOPT_WRITEFUNCTION=>static function ($handle,string $chunk) use (&$buffer): int { if (strlen($buffer)+strlen($chunk)>262144) return 0; $buffer.=$chunk; return strlen($chunk); }]);
        $ok = curl_exec($handle); $status = curl_getinfo($handle,CURLINFO_RESPONSE_CODE); curl_close($handle);
        if ($ok === false || $status < 200 || $status >= 500) throw new RuntimeException('Telegram response unavailable');
        $value = json_decode($buffer,true,64,JSON_THROW_ON_ERROR);
        if (!is_array($value) || !is_bool($value['ok'] ?? null)) throw new RuntimeException('Telegram response unavailable');
        return $value;
    }
    private function deliver(string $table, array $job, array $c, string $method, array $payload, ?string $fingerprint = null): void
    {
        try { $result = $this->call($c,$method,$payload); } catch (Throwable) { $this->failure($table,$job,'network_unknown'); return; }
        if (($result['ok'] ?? false) === true) {
            if ($table === 'telegram_updates') { $this->finish($table,$job,['status'=>'sent','last_error'=>null]); return; }
            $messageId = $result['result']['message_id'] ?? ($method === 'editMessageText' ? $job['message_id'] : null);
            if (!is_int($messageId) || $messageId <= 0) { $this->failure($table,$job,'invalid_response'); return; }
            $this->finish($table,$job,['status'=>'sent','message_id'=>$messageId,'sent_hash'=>$fingerprint,'last_error'=>null,'updated_at'=>$this->now()]); return;
        }
        $code = (int)($result['error_code'] ?? 0); $description = (string)($result['description'] ?? '');
        if ($code === 429) { $this->failure($table,$job,'rate_limited',is_int($result['parameters']['retry_after'] ?? null) ? $result['parameters']['retry_after'] : 60); return; }
        if ($method === 'editMessageText' && $code === 400 && str_contains(strtolower($description),'message is not modified')) { $this->finish($table,$job,['status'=>'sent','sent_hash'=>$fingerprint,'last_error'=>null,'updated_at'=>$this->now()]); return; }
        if ($method === 'editMessageText' && $code === 400 && (str_contains(strtolower($description),'message to edit not found') || str_contains(strtolower($description),"message can't be edited"))) {
            $this->finish($table,$job,['status'=>'pending','message_id'=>null,'last_error'=>'message_missing','next_attempt_at'=>$this->now()]); return;
        }
        $this->failure($table,$job,$code === 403 ? 'bot_blocked' : 'telegram_error',null,in_array($code,[400,401,403,404],true));
    }
    private function processUpdate(array $job): void
    {
        $c = $this->config(); if (!hash_equals(self::botHash($c),$job['bot_hash'])) { $this->finish('telegram_updates',$job,['status'=>'skipped']); return; }
        $p = json_decode($job['payload'],true,16,JSON_THROW_ON_ERROR); $member = self::member($c,$p['id']); $private = $p['private'];
        if (!$private && ($c['notifications']['mode'] !== 'group' || (string)$c['notifications']['groupChatId'] !== $p['chat'])) { $this->finish('telegram_updates',$job,['status'=>'ignored']); return; }
        $payload = ['chat_id'=>$p['chat'],'text'=>'Доступ только для сотрудников. Для передачи своего ID администратору используйте /id в личном чате с ботом.'];
        if ($p['command'] === 'id' && $private) $payload['text']='Ваш Telegram ID: '.$p['id'].'. Передайте его администратору. Это не предоставляет доступ.';
        elseif ($member) {
            if ($private && $p['command'] === 'start') $this->statement('INSERT INTO telegram_chats VALUES(?,?,?,?) ON CONFLICT(user_id,bot_hash) DO UPDATE SET chat_id=excluded.chat_id,registered_at=excluded.registered_at',[$p['id'],$p['chat'],$job['bot_hash'],$this->now()]);
            $payload['text'] = $p['command'] === 'help' ? 'Новый → На согласовании → Принят. Открытие карточки не назначает и не принимает заказ. Телефон, состав, сумму и время согласуйте с гостем.'.($c['responsibleContact'] !== '' ? "\nОтветственный: ".$c['responsibleContact'] : '') : 'Приложение сотрудников «Восемь утра». Откройте список заказов. Для получения личных уведомлений один раз отправьте /start.';
            $payload['reply_markup']=self::button($c,null,$private);
        }
        $this->deliver('telegram_updates',$job,$c,'sendMessage',$payload);
    }
    private function processMessage(array $job): void
    {
        $c = $this->config();
        if (!$this->allowedRecipient($c,$job)) { $this->finish('telegram_messages',$job,['status'=>'skipped','last_error'=>'recipient_inactive']); return; }
        $snapshot = $this->snapshot($job['order_id']);
        if (!$snapshot) { $this->failure('telegram_messages',$job,'order_unavailable'); return; }
        $text = self::notificationText($snapshot,$job['kind'] === 'private');
        $payload = ['chat_id'=>$job['chat_id'],'text'=>$text,'parse_mode'=>'HTML','link_preview_options'=>['is_disabled'=>true],'reply_markup'=>self::button($c,$job['order_id'],$job['kind'] === 'private')];
        $fingerprint = hash('sha256',self::json($payload));
        if ($job['message_id'] && $job['sent_hash'] === $fingerprint) { $this->finish('telegram_messages',$job,['status'=>'sent','last_error'=>null]); return; }
        $method = $job['message_id'] ? 'editMessageText' : 'sendMessage'; if ($job['message_id']) $payload['message_id']=(int)$job['message_id'];
        $this->deliver('telegram_messages',$job,$c,$method,$payload,$fingerprint);
    }
    public function work(int $limit = 20): array
    {
        $c = $this->config(false); if (!$c) return ['enabled'=>false,'processed'=>0];
        $this->migrate(); $limit = max(1,min(100,$limit)); $processed = 0; $deadline=microtime(true)+30;
        for ($n=0;$n<min(5,$limit) && microtime(true)<$deadline;$n++) {
            if (!$this->config(false)) break;
            $job = $this->claim('telegram_updates'); if (!$job) break;
            $this->processUpdate($job); $processed++;
        }
        $c=$this->config(false); if (!$c) return ['enabled'=>false,'processed'=>$processed];
        $this->expandNotifications($c,$deadline);
        for ($n=$processed;$n<$limit && microtime(true)<$deadline;$n++) { if (!$this->config(false)) break; $job=$this->claim('telegram_messages'); if (!$job) break; $this->processMessage($job); $processed++; }
        return ['enabled'=>true,'processed'=>$processed];
    }
    private function manager(array $actor): void { $member = $this->staffMember((string)($actor['id'] ?? '')); if (!$member || $member['role'] !== 'manager') throw new CafeTelegramException(403,'Действие доступно руководителю.','manager_required'); }
    public function diagnostics(array $actor): array
    {
        $this->manager($actor); $this->migrate();
        $hash=self::botHash($this->config());
        $counts = $this->statement('SELECT status,COUNT(*) AS count FROM telegram_messages WHERE bot_hash=? GROUP BY status',[$hash])->fetchAll();
        $failures = $this->statement('SELECT rowid AS id,order_id AS orderId,status,attempts,last_error AS error,next_attempt_at AS nextAttemptAt FROM telegram_messages WHERE bot_hash=? AND status IN (\'failed\',\'retry\') ORDER BY updated_at DESC LIMIT 50',[$hash])->fetchAll();
        return ['enabled'=>true,'counts'=>$counts,'failures'=>$failures];
    }
    public function retryNotification(array $actor, int $id): void
    {
        $this->manager($actor); $this->migrate();
        if ($id <= 0) throw new CafeTelegramException(422,'Некорректное уведомление.','invalid_notification');
        $this->statement('UPDATE telegram_messages SET status=\'pending\',attempts=0,next_attempt_at=0,last_error=NULL WHERE rowid=? AND bot_hash=? AND status IN (\'failed\',\'retry\')',[$id,self::botHash($this->config())]);
    }
    /** Operator-only setup; never call from an HTTP route. */
    public function setup(bool $apply = false): array
    {
        $c = $this->config(); $origin = (string)($this->site['public_origin'] ?? '');
        if (!self::httpsUrl($origin)) throw new CafeTelegramException(422,'Настройте публичный HTTPS-адрес.','https_required');
        $plan = ['environment'=>$this->environment(),'botUsername'=>$c['botUsername'],'webAppUrl'=>$c['webAppUrl'],'webhookUrl'=>rtrim($origin,'/').'/api/telegram/webhook','notificationsMode'=>$c['notifications']['mode']];
        if (!$apply) return $plan + ['applied'=>false];
        $steps = [
            ['setWebhook',['url'=>$plan['webhookUrl'],'secret_token'=>$c['webhookSecret'],'allowed_updates'=>['message'],'drop_pending_updates'=>false,'max_connections'=>5]],
            ['setMyCommands',['commands'=>[['command'=>'start','description'=>'Открыть приложение сотрудников'],['command'=>'orders','description'=>'Список заказов'],['command'=>'help','description'=>'Помощь сотруднику'],['command'=>'id','description'=>'Узнать свой Telegram ID']]]],
            ['setChatMenuButton',['menu_button'=>['type'=>'web_app','text'=>'Заказы','web_app'=>['url'=>$c['webAppUrl']]]]],
        ];
        foreach ($steps as [$method,$body]) { try { $result = $this->call($c,$method,$body); } catch (Throwable) { throw new CafeTelegramException(503,'Настройка Telegram прервана. Проверьте подключение и повторите команду.','setup_failed'); } if (($result['ok'] ?? false) !== true) throw new CafeTelegramException(503,'Telegram отклонил настройку. Проверьте приватную конфигурацию.','setup_failed'); }
        return $plan + ['applied'=>true];
    }
}
