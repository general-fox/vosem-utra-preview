<?php
declare(strict_types=1);
require_once __DIR__ . '/core.php';

/** Named administrators. Every PHP worker shares one locked, atomic state transaction. */
final class CafeAuth
{
    private const CHALLENGE_MS = 300000;
    private const RATE_MS = 900000;
    private const DEVICE_MS = 2592000000;
    private string $directory;
    private array $config;
    private Closure $clock;
    private bool $checkpointed = false;

    public function __construct(string $dataDir, array $config)
    {
        if (!is_dir($dataDir) && !@mkdir($dataDir, 0700, true) && !is_dir($dataDir)) throw new RuntimeException('Cannot create private storage.');
        $resolved = realpath($dataDir);
        if ($resolved === false) throw new RuntimeException('Invalid private storage.');
        $documentRoot = $config['document_root'] ?? ($_SERVER['DOCUMENT_ROOT'] ?? '');
        $publicRoot = $documentRoot !== '' ? realpath($documentRoot) : false;
        if ($publicRoot !== false) {
            $private = strtolower(str_replace('\\', '/', $resolved));
            $public = rtrim(strtolower(str_replace('\\', '/', $publicRoot)), '/');
            if ($private === $public || str_starts_with($private, $public . '/')) throw new RuntimeException('Authentication storage must be outside the web root.');
        }
        $this->directory = $resolved;
        $this->config = $config;
        $this->clock = Closure::fromCallable($config['clock'] ?? static fn(): int => (int)floor(microtime(true) * 1000));
    }

    private function now(): int { return ($this->clock)(); }
    private static function token(): string { return bin2hex(random_bytes(32)); }
    private static function tokenKey(mixed $token): ?string { return is_string($token) && preg_match('/\A[a-f0-9]{64}\z/', $token) === 1 ? hash('sha256', $token) : null; }
    private static function invalid(): CafeAuthException { return new CafeAuthException(401, 'Неверные данные для входа.', 'invalid_credentials'); }
    private static function expired(): CafeAuthException { return new CafeAuthException(410, 'Время подтверждения истекло. Начните вход заново.', 'challenge_expired'); }

    public static function normalizeUsername(mixed $value): string
    {
        $error = static fn() => new CafeAuthException(400, 'Укажите корректную почту или логин.', 'invalid_username');
        if (!is_string($value) || preg_match('/[\x00-\x1f\x7f]/', $value)) throw $error();
        $value = strtolower(trim($value));
        if (strlen($value) > 254) throw $error();
        if (!str_contains($value, '@')) {
            if (!preg_match('/\A[a-z0-9][a-z0-9._-]{2,63}\z/', $value)) throw $error();
            return $value;
        }
        $parts = explode('@', $value);
        $atom = '[a-z0-9!#$%&\x27*+\/=?^_`{|}~-]+';
        $domain = '/\A[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\z/';
        if (count($parts) !== 2 || strlen($parts[0]) > 64 || !preg_match('/\A' . $atom . '(?:\.' . $atom . ')*\z/', $parts[0]) || !preg_match($domain, $parts[1])) throw $error();
        return $value;
    }

    public static function passwordAlgorithm(): string
    {
        return defined('PASSWORD_ARGON2ID') && in_array('argon2id', password_algos(), true) ? PASSWORD_ARGON2ID : PASSWORD_BCRYPT;
    }
    private static function passwordOptions(string $algorithm): array
    {
        return $algorithm === PASSWORD_BCRYPT ? ['cost' => 12] : ['memory_cost' => 65536, 'time_cost' => 3, 'threads' => 1];
    }
    private static function passwordLength(mixed $value): int
    {
        if (!is_string($value) || strlen($value) > 4096 || str_contains($value, "\0") || preg_match('//u', $value) !== 1) return -1;
        return preg_match_all('/./us', $value);
    }
    public static function hashPassword(string $password): string
    {
        $algorithm = self::passwordAlgorithm();
        $length = self::passwordLength($password);
        if ($length < 15 || $length > 1024 || ($algorithm === PASSWORD_BCRYPT && strlen($password) > 72)) {
            throw new CafeAuthException(400, $algorithm === PASSWORD_BCRYPT ? 'Пароль: от 15 символов, не более 72 байт UTF-8 на этом сервере.' : 'Пароль должен содержать от 15 до 1024 символов.', 'invalid_password');
        }
        $hash = password_hash($password, $algorithm, self::passwordOptions($algorithm));
        if (!is_string($hash)) throw new RuntimeException('Password hashing is unavailable.');
        return $hash;
    }
    private static function usableHash(mixed $hash): bool
    {
        if (!is_string($hash) || strlen($hash) > 512) return false;
        return in_array(password_get_info($hash)['algoName'], ['argon2id', 'bcrypt'], true);
    }
    private static function checkPassword(mixed $password, string $hash): bool
    {
        $length = self::passwordLength($password);
        if ($length < 1 || $length > 1024 || (password_get_info($hash)['algoName'] === 'bcrypt' && strlen($password) > 72)) return false;
        return password_verify($password, $hash);
    }

    public static function base32Encode(string $bytes): string
    {
        $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; $bits = 0; $buffer = 0; $result = '';
        foreach (unpack('C*', $bytes) as $byte) {
            $buffer = (($buffer << 8) | $byte) & 0xffff; $bits += 8;
            while ($bits >= 5) { $bits -= 5; $result .= $alphabet[($buffer >> $bits) & 31]; }
        }
        if ($bits > 0) $result .= $alphabet[($buffer << (5 - $bits)) & 31];
        return $result;
    }
    private static function base32Decode(string $secret): string
    {
        if (!preg_match('/\A[A-Z2-7]{16,128}\z/', $secret)) throw new RuntimeException('Invalid authenticator data.');
        $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; $bits = 0; $buffer = 0; $result = '';
        foreach (str_split($secret) as $character) {
            $buffer = (($buffer << 5) | strpos($alphabet, $character)) & 0xffff; $bits += 5;
            if ($bits >= 8) { $bits -= 8; $result .= chr(($buffer >> $bits) & 255); }
        }
        return $result;
    }
    public static function totp(string $secret, int $milliseconds, int $digits = 6, string $algorithm = 'sha1'): string
    {
        $counter = intdiv($milliseconds, 30000);
        $message = pack('N2', intdiv($counter, 4294967296), $counter % 4294967296);
        $digest = hash_hmac($algorithm, $message, self::base32Decode($secret), true);
        $offset = ord($digest[strlen($digest) - 1]) & 15;
        $number = unpack('N', substr($digest, $offset, 4))[1] & 0x7fffffff;
        return str_pad((string)($number % (10 ** $digits)), $digits, '0', STR_PAD_LEFT);
    }
    private function verifyTotp(string $secret, mixed $code, int $lastCounter = -1): ?int
    {
        if (!is_string($code) || preg_match('/\A[0-9]{6}\z/', $code) !== 1) return null;
        $current = intdiv($this->now(), 30000);
        foreach ([0, -1, 1] as $offset) {
            $counter = $current + $offset;
            if ($counter < 0 || $counter <= $lastCounter) continue;
            if (hash_equals(self::totp($secret, $counter * 30000), $code)) return $counter;
        }
        return null;
    }

    private function encryptionKey(): string
    {
        $configured = $this->config['encryption_key'] ?? '';
        if (!is_string($configured)) throw new RuntimeException('Encryption is not configured.');
        $key = preg_match('/\A[a-f0-9]{64}\z/i', $configured) === 1 ? hex2bin($configured) : base64_decode($configured, true);
        if (!is_string($key) || strlen($key) !== 32 || !extension_loaded('openssl')) throw new RuntimeException('Encryption is not configured.');
        return $key;
    }
    private function encrypt(string $secret): array
    {
        $iv = random_bytes(12); $tag = '';
        $ciphertext = openssl_encrypt($secret, 'aes-256-gcm', $this->encryptionKey(), OPENSSL_RAW_DATA, $iv, $tag, 'vosem-utra:totp:v1', 16);
        if ($ciphertext === false) throw new RuntimeException('Encryption is unavailable.');
        return ['version' => 1, 'iv' => bin2hex($iv), 'ciphertext' => bin2hex($ciphertext), 'tag' => bin2hex($tag)];
    }
    private function decrypt(array $record): string
    {
        if (($record['version'] ?? null) !== 1 || !preg_match('/\A[a-f0-9]{24}\z/', $record['iv'] ?? '') || !preg_match('/\A[a-f0-9]{32}\z/', $record['tag'] ?? '') || !preg_match('/\A[a-f0-9]{32,256}\z/', $record['ciphertext'] ?? '')) throw new RuntimeException('Invalid encrypted authenticator data.');
        $secret = openssl_decrypt(hex2bin($record['ciphertext']), 'aes-256-gcm', $this->encryptionKey(), OPENSSL_RAW_DATA, hex2bin($record['iv']), hex2bin($record['tag']), 'vosem-utra:totp:v1');
        if ($secret === false) throw new RuntimeException('Authenticator decryption failed.');
        self::base32Decode($secret);
        return $secret;
    }
    private function originReady(): bool
    {
        $origin = $this->config['public_origin'] ?? '';
        if (!is_string($origin) || preg_match('~\A(https?)://(\[[a-f0-9:]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?\z~i', $origin, $parts) !== 1) return false;
        if (isset($parts[3]) && ((int)$parts[3] < 1 || (int)$parts[3] > 65535)) return false;
        if (strtolower($parts[1]) === 'https') return true;
        return ($this->config['allow_http_dev'] ?? false) === true && in_array(strtolower($parts[2]), ['localhost', '127.0.0.1', '[::1]'], true);
    }
    public function checkOrigin(?string $origin, ?string $fetchSite = null): void
    {
        if (!$this->originReady() || $origin !== ($this->config['public_origin'] ?? '') || $fetchSite === 'cross-site') throw new CafeAuthException(403, 'Запрос должен быть отправлен с этого сайта.', 'origin');
    }
    public function cookieOptions(): array
    {
        return ['expires' => time() + (int)floor(($this->config['session_ms'] ?? 28800000) / 1000), 'path' => '/api/admin', 'secure' => !str_starts_with($this->config['public_origin'] ?? '', 'http://'), 'httponly' => true, 'samesite' => 'Strict'];
    }

    private function transaction(callable $operation): mixed
    {
        return CafeStorage::locked($this->directory . '/auth.lock', function () use ($operation) {
            $file = $this->directory . '/auth-state.json';
            $state = CafeStorage::readJson($file, ['version' => 1, 'account' => null, 'sessions' => [], 'challenges' => [], 'enrollments' => [], 'buckets' => []]);
            if (!is_array($state) || ($state['version'] ?? null) !== 1) throw new RuntimeException('Invalid authentication storage.');
            foreach (['sessions', 'challenges', 'enrollments', 'buckets'] as $section) if (!isset($state[$section]) || !is_array($state[$section])) throw new RuntimeException('Invalid authentication storage.');
            $before = $state;
            $state['accounts'] ??= [];
            $state['devices'] ??= [];
            if (!is_array($state['accounts']) || !is_array($state['devices'])) throw new RuntimeException('Invalid account storage.');
            $this->checkpointed = false;
            foreach (['sessions', 'challenges', 'enrollments', 'devices'] as $section) foreach ($state[$section] as $key => $value) if (($value['expiresAt'] ?? 0) <= $this->now()) unset($state[$section][$key]);
            foreach ($state['buckets'] as $key => $value) {
                if (!is_array($value) || !is_int($value['until'] ?? null) || !is_int($value['count'] ?? null) || $value['count'] < 0) throw new RuntimeException('Invalid authentication limits.');
                if ($value['until'] <= $this->now()) unset($state['buckets'][$key]);
            }
            try { $result = $operation($state); }
            catch (CafeAuthException $error) { if ($state !== $before || $this->checkpointed || !is_file($file)) CafeStorage::atomicJson($file, $state); throw $error; }
            if ($state !== $before || $this->checkpointed || !is_file($file)) CafeStorage::atomicJson($file, $state);
            return $result;
        });
    }
    private function account(array $state, ?string $username = null): ?array
    {
        $account = ($username !== null ? ($state['accounts'][$username] ?? null) : null) ?? $state['account'] ?? null;
        if ($account !== null) {
            if (!is_array($account) || ($account['version'] ?? null) !== 1 || self::normalizeUsername($account['username'] ?? null) !== $account['username'] || !self::usableHash($account['passwordHash'] ?? null) || !is_string($account['credentialVersion'] ?? null) || !array_key_exists('totp', $account) || !is_array($account['recovery'] ?? null)) throw new RuntimeException('Invalid administrator configuration.');
            return $account;
        }
        $hash = $this->config['bootstrap_password_hash'] ?? null;
        if (!self::usableHash($hash)) {
            if (!empty($state['accounts'])) {
                $first = array_key_first($state['accounts']);
                if (!is_array($state['accounts'][$first]) || ($state['accounts'][$first]['secondary'] ?? false) !== true || ($state['accounts'][$first]['username'] ?? null) !== $first) throw new RuntimeException('Invalid additional account');
                return $this->account($state, $first);
            }
            return null;
        }
        $username = self::normalizeUsername($this->config['bootstrap_username'] ?? 'admin');
        return ['version' => 1, 'username' => $username, 'passwordHash' => $hash, 'credentialVersion' => hash('sha256', $username . ':' . $hash), 'totp' => null, 'recovery' => []];
    }
    private function readiness(array $state, ?string $username = null): array
    {
        try {
            $account = $this->account($state, $username);
            if ($account === null) return ['current' => null, 'ready' => false, 'enrollmentAvailable' => false];
            if (!$this->originReady()) return ['current' => $account, 'ready' => false, 'enrollmentAvailable' => false];
            $this->encryptionKey();
            if ($account['totp'] !== null) {
                if (!is_int($account['totp']['lastCounter'] ?? null) || !is_array($account['recovery'] ?? null)) throw new RuntimeException('Invalid MFA state.');
                foreach ($account['recovery'] as $code) if (!is_string($code) || !preg_match('/\A[a-f0-9]{64}\z/', $code)) throw new RuntimeException('Invalid recovery code state.');
                $this->decrypt($account['totp']['encrypted']);
            }
            return ['current' => $account, 'ready' => $account['totp'] !== null, 'enrollmentAvailable' => $account['totp'] === null];
        } catch (Throwable) { return ['current' => $account ?? null, 'ready' => false, 'enrollmentAvailable' => false]; }
    }
    private function saveAccount(array &$state, array $account): void
    {
        if (($account['secondary'] ?? false) === true) $state['accounts'][$account['username']] = $account;
        else $state['account'] = $account;
    }
    private function trustedDevice(array $state, ?string $token): ?array
    {
        $key = self::tokenKey($token);
        $device = $key ? ($state['devices'][$key] ?? null) : null;
        if (!$device || $device['expiresAt'] <= $this->now()) return null;
        $fresh = $this->readiness($state, $device['username']);
        return $fresh['ready'] && $fresh['current']['username'] === $device['username'] && $fresh['current']['credentialVersion'] === $device['credentialVersion'] ? $device : null;
    }
    private function rememberDevice(array &$state, array $account, ?string $oldToken = null, ?int $expiresAt = null): array
    {
        $expiresAt ??= $this->now() + self::DEVICE_MS;
        if ($key = self::tokenKey($oldToken)) unset($state['devices'][$key]);
        $token = self::token();
        $this->boundedAdd($state['devices'], $token, ['username' => $account['username'], 'credentialVersion' => $account['credentialVersion'], 'expiresAt' => $expiresAt]);
        return ['deviceToken' => $token, 'deviceMaxAge' => max(0, (int)floor(($expiresAt - $this->now()) / 1000))];
    }
    public function forgetDevice(?string $token): void
    {
        $this->transaction(function (array &$state) use ($token) { if ($key = self::tokenKey($token)) unset($state['devices'][$key]); });
    }
    public function resume(?string $deviceToken, string $peer): array
    {
        return $this->transaction(function (array &$state) use ($deviceToken, $peer) {
            $device = $this->trustedDevice($state, $deviceToken);
            if (!$device) throw new CafeAuthException(401, 'Срок запоминания истёк. Войдите с паролем.', 'device_expired');
            $token = self::token();
            $this->boundedAdd($state['challenges'], $token, ['type' => 'mfa', 'username' => $device['username'], 'credentialVersion' => $device['credentialVersion'], 'deviceHash' => self::tokenKey($deviceToken), 'peer' => hash('sha256', $peer), 'expiresAt' => $this->now() + self::CHALLENGE_MS, 'attempts' => 0, 'oldTokenHash' => null]);
            return ['mfaRequired' => true, 'challengeToken' => $token, 'trusted' => true, 'username' => $device['username']];
        });
    }
    private function reserve(array &$state, string $peer, string $phase): array
    {
        $keys = [$phase . ':peer:' . hash('sha256', $peer), $phase . ':global'];
        foreach ($keys as $index => $key) {
            $bucket = $state['buckets'][$key] ?? null;
            if ($bucket && $bucket['count'] >= ($index === 0 ? 8 : 40)) throw new CafeAuthException(429, 'Слишком много попыток. Повторите позже.', 'rate_limit', (int)ceil(($bucket['until'] - $this->now()) / 1000));
        }
        foreach ($keys as $key) { $state['buckets'][$key] ??= ['count' => 0, 'until' => $this->now() + self::RATE_MS]; $state['buckets'][$key]['count']++; }
        // Reservation survives a killed PHP worker; the successful request refunds only itself.
        CafeStorage::atomicJson($this->directory . '/auth-state.json', $state);
        $this->checkpointed = true;
        return $keys;
    }
    private function refund(array &$state, array $keys): void
    {
        foreach ($keys as $key) { if (isset($state['buckets'][$key]) && --$state['buckets'][$key]['count'] <= 0) unset($state['buckets'][$key]); }
    }
    private function boundedAdd(array &$map, string $token, array $value): void
    {
        if (count($map) >= 100) unset($map[array_key_first($map)]);
        $map[hash('sha256', $token)] = $value;
    }
    private function pending(array $map, mixed $token, string $peer, ?string $type = null): array
    {
        $key = self::tokenKey($token); $value = $key !== null ? ($map[$key] ?? null) : null;
        if (!$value || ($value['peer'] ?? '') !== hash('sha256', $peer) || ($value['expiresAt'] ?? 0) <= $this->now() || ($value['attempts'] ?? 5) >= 5 || ($type !== null && ($value['type'] ?? '') !== $type)) throw self::expired();
        return [$key, $value];
    }
    private function sessionInState(array &$state, ?string $token, bool $touch = true): ?array
    {
        $key = self::tokenKey($token); $session = $key !== null ? ($state['sessions'][$key] ?? null) : null;
        if ($session === null) return null;
        $fresh = $this->readiness($state, $session['username']);
        if (!$fresh['ready'] || $session['credentialVersion'] !== $fresh['current']['credentialVersion'] || $session['expiresAt'] <= $this->now() || $session['lastSeen'] + ($this->config['idle_ms'] ?? 1800000) <= $this->now()) { unset($state['sessions'][$key]); return null; }
        if ($touch) $state['sessions'][$key]['lastSeen'] = $this->now();
        return $session + ['token' => $token];
    }
    private function issue(array &$state, array $account, string $peer, ?string $oldToken = null): array
    {
        if ($oldKey = self::tokenKey($oldToken)) unset($state['sessions'][$oldKey]);
        $token = self::token(); $csrfToken = self::token();
        $this->boundedAdd($state['sessions'], $token, ['username' => $account['username'], 'credentialVersion' => $account['credentialVersion'], 'csrfToken' => $csrfToken, 'expiresAt' => $this->now() + ($this->config['session_ms'] ?? 28800000), 'lastSeen' => $this->now()]);
        $this->audit('login.succeeded', $peer, ['username' => $account['username']]);
        return ['authenticated' => true, 'token' => $token, 'csrfToken' => $csrfToken];
    }
    public function audit(string $event, string $peer = '', array $detail = []): void
    {
        if (!preg_match('/\A[a-z][a-z._]{0,63}\z/', $event)) throw new RuntimeException('Invalid audit event.');
        $entry = ['at' => gmdate('c', intdiv($this->now(), 1000)), 'event' => $event];
        if ($peer !== '') $entry['peer'] = substr(hash('sha256', $peer), 0, 24);
        foreach (['revision', 'count', 'method', 'username'] as $field) if (isset($detail[$field]) && (is_int($detail[$field]) || is_string($detail[$field]))) $entry[$field] = $detail[$field];
        CafeStorage::locked($this->directory . '/audit.lock', function () use ($entry) {
            $file = $this->directory . '/security-audit.jsonl';
            if (is_file($file) && filesize($file) > 5 * 1024 * 1024) { if (is_file($file . '.1')) unlink($file . '.1'); if (!rename($file, $file . '.1')) throw new RuntimeException('Cannot rotate private audit.'); }
            if (file_put_contents($file, json_encode($entry, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR) . "\n", FILE_APPEND) === false) throw new RuntimeException('Cannot write private audit.');
            @chmod($file, 0600);
        });
    }

    public function status(?string $token = null, ?string $deviceToken = null): array
    {
        return $this->transaction(function (array &$state) use ($token, $deviceToken) {
            $session = $this->sessionInState($state, $token);
            if ($session !== null) return ['authenticated' => true, 'csrfToken' => $session['csrfToken']];
            $fresh = $this->readiness($state);
            $device = $this->trustedDevice($state, $deviceToken);
            return ['authenticated' => false, 'configured' => $fresh['current'] !== null, 'mfaRequired' => true, 'production' => !($this->config['allow_http_dev'] ?? false), 'ready' => $fresh['ready'], 'enrollmentAvailable' => $fresh['enrollmentAvailable']] + ($device ? ['trustedUsername' => $device['username']] : []);
        });
    }
    /** Offline migration/provisioning only. No HTTP route may expose this method. */
    public function validatePortableState(array $state): void
    {
        if (PHP_SAPI !== 'cli') throw new RuntimeException('Offline validation only.');
        if (($state['version'] ?? null) !== 1 || !is_array($state['accounts'] ?? [])) throw new RuntimeException('Invalid account snapshot.');
        $users = [];
        if (($state['account'] ?? null) !== null) $users[] = $state['account']['username'] ?? '';
        foreach ($state['accounts'] ?? [] as $username => $account) {
            if (($account['username'] ?? null) !== $username || ($account['secondary'] ?? false) !== true || in_array($username, $users, true)) throw new RuntimeException('Invalid employee snapshot.');
            $users[] = $username;
        }
        foreach ($users ?: [null] as $username) {
            $fresh = $this->readiness($state, $username);
            if ($fresh['current'] !== null && !$fresh['ready'] && !$fresh['enrollmentAvailable']) throw new RuntimeException('Account or encryption key cannot be restored.');
            if ($username !== null && ($fresh['current']['username'] ?? null) !== $username) throw new RuntimeException('Invalid account snapshot.');
        }
    }

    public function installAccount(array $account): void
    {
        if (PHP_SAPI !== 'cli') throw new CafeAuthException(403, 'Настройка разрешена только локально.', 'forbidden');
        $this->transaction(function (array &$state) use ($account) {
            $candidate = $state; $candidate['account'] = $account;
            $fresh = $this->readiness($candidate);
            if (!$fresh['ready'] && !$fresh['enrollmentAvailable']) throw new RuntimeException('Invalid account or encryption configuration for migration.');
            $state['account'] = $account;
            $state['sessions'] = []; $state['challenges'] = []; $state['enrollments'] = [];
            $this->audit('credentials.installed', '', ['username' => $account['username']]);
        });
    }
    /** Offline only: add, never overwrite the owner or another employee. */
    public function installAdditionalAccount(array $account): void
    {
        if (PHP_SAPI !== 'cli') throw new CafeAuthException(403, 'Настройка разрешена только локально.', 'forbidden');
        $this->transaction(function (array &$state) use ($account) {
            $username = self::normalizeUsername($account['username'] ?? null);
            if ($username === ($this->account($state)['username'] ?? null) || isset($state['accounts'][$username])) throw new RuntimeException('This account already exists; nothing was replaced.');
            $account['secondary'] = true;
            $candidate = $state; $candidate['accounts'][$username] = $account;
            $fresh = $this->readiness($candidate, $username);
            if (!$fresh['ready'] && !$fresh['enrollmentAvailable']) throw new RuntimeException('Invalid additional account configuration.');
            $state['accounts'][$username] = $account;
            $this->audit('credentials.added', '', ['username' => $username]);
        });
    }
    public function session(?string $token, bool $touch = true): ?array { return $this->transaction(fn(array &$state) => $this->sessionInState($state, $token, $touch)); }
    public function requireSession(?string $token, ?string $csrfToken = null, bool $mutation = false): array
    {
        $session = $this->session($token);
        if ($session === null) throw new CafeAuthException(401, 'Войдите в панель управления.', 'unauthorized');
        if ($mutation && (!is_string($csrfToken) || !hash_equals($session['csrfToken'], $csrfToken))) throw new CafeAuthException(403, 'Сессия устарела. Обновите страницу.', 'csrf');
        return $session;
    }
    public function logout(?string $token, string $peer): array
    {
        return $this->transaction(function (array &$state) use ($token, $peer) { if ($key = self::tokenKey($token)) unset($state['sessions'][$key]); $this->audit('logout', $peer); return ['authenticated' => false]; });
    }
    public function login(array $body, string $peer, ?string $oldToken = null): array
    {
        return $this->transaction(function (array &$state) use ($body, $peer, $oldToken) {
            try { $username = self::normalizeUsername($body['username'] ?? null); } catch (CafeAuthException) { $username = ''; }
            $fresh = $this->readiness($state, $username);
            if (!$fresh['ready'] && !$fresh['enrollmentAvailable']) throw new CafeAuthException(503, 'Вход администратора требует настройки на сервере.', $fresh['current'] ? 'production_setup_required' : 'not_configured');
            $account = $fresh['current']; $reservation = $this->reserve($state, $peer, 'password');
            $password = $body['password'] ?? null;
            $validPassword = self::checkPassword($password, $account['passwordHash']);
            if (!$validPassword || !hash_equals($account['username'], $username) || (isset($account['initialExpiresAt']) && $account['initialExpiresAt'] <= $this->now())) { $this->audit('login.failed', $peer); throw self::invalid(); }
            $this->refund($state, $reservation);
            $token = self::token();
            $pending = ['username' => $account['username'], 'secondary' => ($account['secondary'] ?? false) === true, 'credentialVersion' => $account['credentialVersion'], 'peer' => hash('sha256', $peer), 'expiresAt' => $this->now() + self::CHALLENGE_MS, 'attempts' => 0];
            if ($account['totp'] === null) {
                $requiresNewPassword = ($account['temporaryPassword'] ?? false) === true || self::passwordLength($password) < 15;
                $passwordHash = $requiresNewPassword ? null : (password_needs_rehash($account['passwordHash'], self::passwordAlgorithm(), self::passwordOptions(self::passwordAlgorithm())) ? self::hashPassword($password) : $account['passwordHash']);
                $pending += ['type' => 'enrollment', 'requiresNewPassword' => $requiresNewPassword, 'passwordHash' => $passwordHash];
                $this->boundedAdd($state['challenges'], $token, $pending);
                $this->audit('enrollment.authorized', $peer);
                return ['enrollmentRequired' => true, 'challengeToken' => $token, 'username' => $account['username'], 'requiresNewPassword' => $requiresNewPassword];
            }
            $pending += ['type' => 'mfa', 'oldTokenHash' => self::tokenKey($oldToken)];
            $this->boundedAdd($state['challenges'], $token, $pending);
            $this->audit('login.mfa_requested', $peer);
            return ['mfaRequired' => true, 'challengeToken' => $token];
        });
    }
    public function enrollStart(array $body, string $peer): array
    {
        return $this->transaction(function (array &$state) use ($body, $peer) {
            [$key, $pending] = $this->pending($state['challenges'], $body['challengeToken'] ?? null, $peer, 'enrollment');
            $fresh = $this->readiness($state, $pending['username'] ?? null);
            if (!$fresh['enrollmentAvailable'] || $fresh['current']['credentialVersion'] !== $pending['credentialVersion']) { unset($state['challenges'][$key]); throw self::expired(); }
            $username = self::normalizeUsername($body['username'] ?? null);
            if (($pending['secondary'] ?? false) && $username !== $pending['username']) throw new CafeAuthException(400, 'Для этой учётной записи нельзя изменить почту.', 'invalid_username');
            if (!($pending['secondary'] ?? false) && isset($state['accounts'][$username])) throw new CafeAuthException(400, 'Эта почта уже используется.', 'invalid_username');
            $reservation = $this->reserve($state, $peer, 'enrollment');
            if ($pending['requiresNewPassword'] && !isset($body['password'])) throw new CafeAuthException(400, 'Укажите новый пароль от 15 символов.', 'invalid_password');
            if (($fresh['current']['temporaryPassword'] ?? false) && self::checkPassword($body['password'] ?? null, $fresh['current']['passwordHash'])) throw new CafeAuthException(400, 'Задайте свой пароль, отличный от временного.', 'invalid_password');
            $passwordHash = array_key_exists('password', $body) ? (is_string($body['password']) ? self::hashPassword($body['password']) : throw new CafeAuthException(400, 'Укажите новый пароль.', 'invalid_password')) : $pending['passwordHash'];
            $secret = self::base32Encode(random_bytes(20)); $token = self::token();
            $this->boundedAdd($state['enrollments'], $token, ['accountUsername' => $pending['username'] ?? null, 'secondary' => $pending['secondary'] ?? false, 'credentialVersion' => $pending['credentialVersion'], 'peer' => hash('sha256', $peer), 'expiresAt' => $this->now() + self::CHALLENGE_MS, 'attempts' => 0, 'username' => $username, 'passwordHash' => $passwordHash, 'encryptedSecret' => $this->encrypt($secret)]);
            unset($state['challenges'][$key]); $this->refund($state, $reservation);
            $this->audit('enrollment.started', $peer);
            $uri = 'otpauth://totp/' . rawurlencode('Восемь утра:' . $username) . '?secret=' . $secret . '&issuer=' . rawurlencode('Восемь утра') . '&algorithm=SHA1&digits=6&period=30';
            return ['enrollmentToken' => $token, 'otpauthUri' => $uri, 'secret' => $secret, 'expiresIn' => 300];
        });
    }
    private static function recoveryHash(string $code): string { return hash('sha256', 'vosem-recovery-v1:' . str_replace(['-', ' '], '', strtolower($code))); }
    public function enrollConfirm(array $body, string $peer): array
    {
        return $this->transaction(function (array &$state) use ($body, $peer) {
            [$key, $pending] = $this->pending($state['enrollments'], $body['enrollmentToken'] ?? null, $peer);
            $fresh = $this->readiness($state, $pending['accountUsername'] ?? null);
            if (!$fresh['enrollmentAvailable'] || $fresh['current']['credentialVersion'] !== $pending['credentialVersion']) { unset($state['enrollments'][$key]); throw self::expired(); }
            $reservation = $this->reserve($state, $peer, 'otp');
            $state['enrollments'][$key]['attempts']++;
            $secret = $this->decrypt($pending['encryptedSecret']);
            $counter = $this->verifyTotp($secret, is_string($body['code'] ?? null) ? trim($body['code']) : null);
            if ($counter === null) {
                $this->audit('enrollment.failed', $peer);
                if ($state['enrollments'][$key]['attempts'] >= 5) { unset($state['enrollments'][$key]); throw self::expired(); }
                throw new CafeAuthException(401, 'Код не принят. Проверьте код в приложении.', 'invalid_code');
            }
            $recovery = [];
            for ($index = 0; $index < 10; $index++) $recovery[] = implode('-', str_split(bin2hex(random_bytes(16)), 4));
            $account = ['version' => 1, 'username' => $pending['username'], 'passwordHash' => $pending['passwordHash'], 'credentialVersion' => self::token(), 'totp' => ['encrypted' => $this->encrypt($secret), 'lastCounter' => $counter], 'recovery' => array_map(self::recoveryHash(...), $recovery)];
            if ($pending['secondary'] ?? false) $account['secondary'] = true;
            elseif (isset($state['accounts'][$account['username']])) throw new CafeAuthException(400, 'Эта почта уже используется.', 'invalid_username');
            $this->saveAccount($state, $account);
            foreach (['sessions', 'challenges', 'enrollments'] as $section) foreach ($state[$section] as $id => $entry) if ($entry['credentialVersion'] === $pending['credentialVersion']) unset($state[$section][$id]);
            $this->refund($state, $reservation); $this->audit('credentials.mfa_enrolled', $peer, ['username' => $account['username']]);
            $deviceResult = $this->rememberDevice($state, $account);
            return $this->issue($state, $account, $peer) + ['recoveryCodes' => $recovery] + $deviceResult;
        });
    }
    public function enrollCancel(array $body, string $peer): array
    {
        return $this->transaction(function (array &$state) use ($body, $peer) {
            foreach (['challengeToken' => 'challenges', 'enrollmentToken' => 'enrollments'] as $name => $section) {
                $key = self::tokenKey($body[$name] ?? null);
                if ($key && isset($state[$section][$key]) && $state[$section][$key]['peer'] === hash('sha256', $peer) && ($section === 'enrollments' || $state[$section][$key]['type'] === 'enrollment')) unset($state[$section][$key]);
            }
            return ['cancelled' => true];
        });
    }
    public function verify(array $body, string $peer, ?string $deviceToken = null): array
    {
        return $this->transaction(function (array &$state) use ($body, $peer, $deviceToken) {
            [$key, $pending] = $this->pending($state['challenges'], $body['challengeToken'] ?? null, $peer, 'mfa');
            $fresh = $this->readiness($state, $pending['username'] ?? null);
            if (!$fresh['ready'] || $fresh['current']['credentialVersion'] !== $pending['credentialVersion']) { unset($state['challenges'][$key]); throw self::expired(); }
            $reservation = $this->reserve($state, $peer, 'otp');
            $state['challenges'][$key]['attempts']++;
            $device = isset($pending['deviceHash']) ? $this->trustedDevice($state, $deviceToken) : null;
            if (isset($pending['deviceHash']) && (!$device || $pending['deviceHash'] !== self::tokenKey($deviceToken) || $device['username'] !== $fresh['current']['username'])) {
                unset($state['challenges'][$key]); throw new CafeAuthException(401, 'Войдите с паролем.', 'device_expired');
            }
            $account = $fresh['current']; $method = 'totp';
            $code = is_string($body['code'] ?? null) && strlen($body['code']) <= 100 ? trim($body['code']) : '';
            $counter = $this->verifyTotp($this->decrypt($account['totp']['encrypted']), $code, $account['totp']['lastCounter']);
            if ($counter !== null) $account['totp']['lastCounter'] = $counter;
            else {
                $recoveryIndex = false;
                if (!isset($pending['deviceHash']) && preg_match('/\A[a-fA-F0-9 -]{32,47}\z/', $code)) foreach ($account['recovery'] as $index => $hash) if (hash_equals($hash, self::recoveryHash($code))) { $recoveryIndex = $index; break; }
                if ($recoveryIndex === false) {
                    $this->audit('mfa.failed', $peer);
                    if ($state['challenges'][$key]['attempts'] >= 5) { unset($state['challenges'][$key]); throw self::expired(); }
                    throw new CafeAuthException(401, 'Код не принят. Проверьте код в приложении.', 'invalid_code');
                }
                array_splice($account['recovery'], $recoveryIndex, 1); $method = 'recovery';
            }
            $this->saveAccount($state, $account); unset($state['challenges'][$key]);
            if ($pending['oldTokenHash']) unset($state['sessions'][$pending['oldTokenHash']]);
            $this->refund($state, $reservation); $this->audit('mfa.succeeded', $peer, ['method' => $method]);
            $deviceResult = $method === 'totp' ? $this->rememberDevice($state, $account, $deviceToken, $device['expiresAt'] ?? null) : [];
            return $this->issue($state, $account, $peer) + $deviceResult;
        });
    }
}
