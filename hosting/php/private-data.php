<?php
declare(strict_types=1);
// Offline encrypted backups / first-install transfer. Never an HTTP endpoint.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once __DIR__.'/menu.php';

const CAFE_BUNDLE_LIMIT = 67108864;
function cafe_private_write(string $path, string $bytes): void {
    $stream = @fopen($path, 'xb');
    if (!$stream) throw new RuntimeException('Output already exists or cannot be written.');
    @chmod($path, 0600);
    try {
        for ($offset = 0; $offset < strlen($bytes); $offset += $written) {
            $written = fwrite($stream, substr($bytes, $offset));
            if (!$written) throw new RuntimeException('Private output write failed.');
        }
        if (!fflush($stream)) throw new RuntimeException('Private output flush failed.');
        if (function_exists('fsync') && !fsync($stream)) throw new RuntimeException('Private output sync failed.');
    } finally { fclose($stream); }
}
function cafe_portable_config(string $directory): array {
    if (is_link($directory.'/admin-config.php')) throw new RuntimeException('Symlinks are not supported.');
    $saved = require $directory.'/admin-config.php';
    if (!is_array($saved)) throw new RuntimeException('Invalid configuration.');
    $config = [];
    foreach (['publicOrigin'=>'public_origin','username'=>'bootstrap_username','passwordHash'=>'bootstrap_password_hash','encryptionKey'=>'encryption_key','googleVerification'=>'google_verification','yandexVerification'=>'yandex_verification'] as $canonical => $alias) {
        if (array_key_exists($canonical, $saved) || array_key_exists($alias, $saved)) $config[$canonical] = $saved[$alias] ?? $saved[$canonical];
    }
    $config['indexing'] = ($saved['indexing'] ?? true) === true;
    return $config;
}
function cafe_portable_auth_config(array $config): array {
    return ['public_origin'=>'https://vosem-utra.ru', 'encryption_key'=>$config['encryptionKey'] ?? '',
        'bootstrap_username'=>$config['username'] ?? 'admin', 'bootstrap_password_hash'=>$config['passwordHash'] ?? null];
}
function cafe_cold_state(array $state): array {
    if (($state['version'] ?? null) !== 1) throw new RuntimeException('Invalid authentication snapshot version.');
    return ['version'=>1, 'account'=>$state['account'] ?? null, 'accounts'=>$state['accounts'] ?? [],
        'sessions'=>[], 'devices'=>[], 'challenges'=>[], 'enrollments'=>[], 'buckets'=>[]];
}
function cafe_snapshot(string $directory, bool $includeOrders): array {
    $directory = realpath($directory) ?: throw new RuntimeException('Private source not found.');
    $config = cafe_portable_config($directory);
    $auth = new CafeAuth($directory.'/admin-data', cafe_portable_auth_config($config));
    return CafeStorage::locked($directory.'/admin-data/auth.lock', function () use ($directory, $config, $auth, $includeOrders): array {
        return CafeStorage::locked($directory.'/admin-data/menu.lock', function () use ($directory, $config, $auth, $includeOrders): array {
            $state = cafe_cold_state(CafeStorage::readJson($directory.'/admin-data/auth-state.json', ['version'=>1]));
            $auth->validatePortableState($state);
            $menu = CafeStorage::readJson($directory.'/admin-data/menu.json');
            if (!is_array($menu) || !is_int($menu['revision'] ?? null) || $menu['revision'] < 1) throw new RuntimeException('Saved menu not found or invalid.');
            cafe_normalize_catalog($menu);
            $files = []; $size = 0;
            $add = static function (string $name, string $file) use (&$files, &$size): void {
                if (is_link($file) || !is_file($file)) throw new RuntimeException('Invalid private file.');
                $size += filesize($file);
                if ($size > 32 * 1024 * 1024) throw new RuntimeException('Private data exceeds 32 MiB; use a streaming server backup.');
                $bytes = file_get_contents($file);
                if ($bytes === false) throw new RuntimeException('Cannot read private file.');
                $files[$name] = base64_encode($bytes);
            };
            foreach (glob($directory.'/admin-data/uploads/*') ?: [] as $file) {
                if (!preg_match('/\A[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:jpg|jpeg|png|webp)\z/i', basename($file))) throw new RuntimeException('Unexpected upload filename.');
                $add('admin-data/uploads/'.basename($file), $file);
            }
            foreach ($menu['items'] as $item) foreach (cafe_menu_images($item) as $image) if (str_starts_with($image, '/uploads/') && !isset($files['admin-data'.$image])) throw new RuntimeException('A menu photograph is missing.');
            $ordersConfig = null;
            if ($includeOrders && is_file($directory.'/orders-config.php')) {
                $ordersConfig = require $directory.'/orders-config.php';
                if (!is_array($ordersConfig)) throw new RuntimeException('Invalid ordering configuration.');
            }
            if ($includeOrders && is_file($directory.'/orders-data/orders.sqlite')) {
                if (is_link($directory.'/orders-data/orders.sqlite')) throw new RuntimeException('Symlinks are not supported.');
                $snapshot = $directory.'/orders-data/backup-'.bin2hex(random_bytes(12)).'.sqlite';
                try {
                    $db = new PDO('sqlite:'.$directory.'/orders-data/orders.sqlite', null, null, [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
                    $db->exec('PRAGMA busy_timeout=5000');
                    $db->exec('VACUUM INTO '.$db->quote($snapshot));
                    $db = null;
                    $copy = new PDO('sqlite:'.$snapshot, null, null, [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
                    if ($copy->query('PRAGMA integrity_check')->fetchColumn() !== 'ok') throw new RuntimeException('Invalid order backup.');
                    $copy = null;
                    $add('orders-data/orders.sqlite', $snapshot);
                } finally { if (is_file($snapshot)) unlink($snapshot); }
            }
            // Keep the duplicate-registration ledger and its stable key together, independently of orders.
            $registration = $directory.'/registration-data';
            if (file_exists($registration.'/ledger.sqlite') || file_exists($registration.'/hmac.key') || is_link($registration)
                || is_link($registration.'/ledger.sqlite') || is_link($registration.'/hmac.key')) {
                if (is_link($registration) || is_link($registration.'/ledger.sqlite') || is_link($registration.'/hmac.key')
                    || !is_file($registration.'/ledger.sqlite') || !is_file($registration.'/hmac.key')) throw new RuntimeException('Incomplete registration ledger or unsafe path.');
                $handle = @fopen($registration.'/hmac.key', 'rb');
                if (!$handle) throw new RuntimeException('Cannot read registration key.');
                $snapshot = $registration.'/backup-'.bin2hex(random_bytes(12)).'.sqlite';
                try {
                    if (!flock($handle, LOCK_SH) || strlen((string)stream_get_contents($handle)) !== 32) throw new RuntimeException('Invalid registration key.');
                    $db = new PDO('sqlite:'.$registration.'/ledger.sqlite', null, null, [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
                    $db->exec('PRAGMA busy_timeout=5000');
                    $db->exec('VACUUM INTO '.$db->quote($snapshot));
                    $db = null;
                    $copy = new PDO('sqlite:'.$snapshot, null, null, [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
                    if ($copy->query('PRAGMA integrity_check')->fetchColumn() !== 'ok') throw new RuntimeException('Invalid registration backup.');
                    $copy = null;
                    $add('registration-data/ledger.sqlite', $snapshot);
                    $add('registration-data/hmac.key', $registration.'/hmac.key');
                } finally {
                    $db = $copy = null;
                    flock($handle, LOCK_UN); fclose($handle);
                    if (is_file($snapshot)) unlink($snapshot);
                }
            }
            return ['version'=>1, 'createdAt'=>gmdate('c'), 'source'=>'vosem-php', 'localTestData'=>is_file($directory.'/.local-development'),
                'config'=>$config, 'auth'=>$state, 'menu'=>$menu, 'ordersConfig'=>$ordersConfig, 'files'=>$files];
        });
    });
}
function cafe_export_private(string $directory, string $bundle, string $keyFile, bool $includeOrders): void {
    if (file_exists($bundle) || file_exists($keyFile) || $bundle === $keyFile) throw new RuntimeException('Backup output must be new.');
    $snapshot = cafe_snapshot($directory, $includeOrders);
    $plain = json_encode($snapshot, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    if (strlen($plain) > CAFE_BUNDLE_LIMIT) throw new RuntimeException('Backup exceeds size limit.');
    $key = random_bytes(32); $iv = random_bytes(12); $tag = '';
    $ciphertext = openssl_encrypt($plain, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag, 'vosem-private-backup:v1', 16);
    if ($ciphertext === false) throw new RuntimeException('Encryption failed.');
    $envelope = json_encode(['format'=>'vosem-private-v1', 'iv'=>bin2hex($iv), 'tag'=>bin2hex($tag), 'data'=>base64_encode($ciphertext)], JSON_THROW_ON_ERROR);
    // A failed bundle write may leave a key, but never an unencrypted backup.
    cafe_private_write($keyFile, bin2hex($key)."\n");
    cafe_private_write($bundle, $envelope);
}
function cafe_import_private(string $bundle, string $keyFile, string $destination, string $origin): void {
    if (file_exists($destination) || is_link($destination)) throw new RuntimeException('Destination exists; live data must never be overwritten.');
    if (!preg_match('~\Ahttps://[a-zA-Z0-9.-]+(?::[0-9]{1,5})?\z~', $origin)
        && !preg_match('~\Ahttp://(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?\z~', $origin)) throw new RuntimeException('Use an HTTPS origin or a local test origin.');
    if (!is_file($bundle) || filesize($bundle) > CAFE_BUNDLE_LIMIT * 1.4) throw new RuntimeException('Invalid bundle size.');
    $envelope = json_decode(file_get_contents($bundle), true, 16, JSON_THROW_ON_ERROR);
    $key = trim(file_get_contents($keyFile));
    if (($envelope['format'] ?? null) !== 'vosem-private-v1' || !preg_match('/\A[a-f0-9]{64}\z/', $key)
        || !preg_match('/\A[a-f0-9]{24}\z/', $envelope['iv'] ?? '') || !preg_match('/\A[a-f0-9]{32}\z/', $envelope['tag'] ?? '')) throw new RuntimeException('Invalid backup or key.');
    $ciphertext = base64_decode($envelope['data'] ?? '', true);
    if ($ciphertext === false) throw new RuntimeException('Invalid encrypted data.');
    $plain = openssl_decrypt($ciphertext, 'aes-256-gcm', hex2bin($key), OPENSSL_RAW_DATA, hex2bin($envelope['iv']), hex2bin($envelope['tag']), 'vosem-private-backup:v1');
    if ($plain === false || strlen($plain) > CAFE_BUNDLE_LIMIT) throw new RuntimeException('Backup authentication failed.');
    $snapshot = json_decode($plain, true, 128, JSON_THROW_ON_ERROR);
    if (($snapshot['version'] ?? null) !== 1 || ($snapshot['source'] ?? null) !== 'vosem-php' || !is_array($snapshot['config'] ?? null)
        || !is_array($snapshot['auth'] ?? null) || !is_array($snapshot['files'] ?? null)) throw new RuntimeException('Invalid backup contents.');
    if (($snapshot['localTestData'] ?? false) && str_starts_with($origin, 'https:') && (isset($snapshot['files']['orders-data/orders.sqlite']) || ($snapshot['ordersConfig'] ?? null) !== null)) throw new RuntimeException('Do not transfer local test orders to a live site. Use export without --include-orders.');
    $menu = $snapshot['menu']; cafe_normalize_catalog($menu);
    if (!is_int($menu['revision'] ?? null) || $menu['revision'] < 1) throw new RuntimeException('Invalid menu revision.');
    $decoded = [];
    foreach ($snapshot['files'] as $name => $encoded) {
        if (!is_string($name) || (!preg_match('~\A(?:admin-data/uploads/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:jpg|jpeg|png|webp)|orders-data/orders\.sqlite)\z~i', $name)
                && !in_array($name, ['registration-data/ledger.sqlite','registration-data/hmac.key'], true))
            || str_contains($name, '..') || !is_string($encoded) || ($bytes = base64_decode($encoded, true)) === false) throw new RuntimeException('Unsafe backup path or contents.');
        $decoded[$name] = $bytes;
    }
    if (isset($decoded['registration-data/ledger.sqlite']) !== isset($decoded['registration-data/hmac.key'])) throw new RuntimeException('Registration ledger and key must be restored together.');
    if (isset($decoded['registration-data/hmac.key'])) {
        if (strlen($decoded['registration-data/hmac.key']) !== 32) throw new RuntimeException('Invalid registration key.');
        // Phone hashes include the origin; silently changing it would disable duplicate protection.
        if (($snapshot['config']['publicOrigin'] ?? '') !== $origin) throw new RuntimeException('Registration history can only be restored to its original site origin. Transfer admin/menu data separately for a different site.');
    }
    foreach ($menu['items'] as $item) foreach (cafe_menu_images($item) as $image) if (str_starts_with($image, '/uploads/') && !isset($decoded['admin-data'.$image])) throw new RuntimeException('Missing menu photograph.');
    $parent = realpath(dirname($destination));
    if ($parent === false || in_array(basename($destination), ['.', '..', ''], true)) throw new RuntimeException('Create the destination parent first.');
    $staging = $parent.'/.cafe-restore-'.bin2hex(random_bytes(12));
    if (!mkdir($staging, 0700)) throw new RuntimeException('Cannot create restore staging.');
    $config = $snapshot['config']; $config['publicOrigin'] = $origin;
    // Publishing/indexing and real order acceptance are separate explicit decisions.
    $config['indexing'] = false;
    unset($config['public_origin'], $config['allow_http_dev'], $config['production']);
    $state = cafe_cold_state($snapshot['auth']);
    $auth = new CafeAuth($staging.'/admin-data', cafe_portable_auth_config($config));
    $auth->validatePortableState($state);
    CafeStorage::atomicJson($staging.'/admin-data/auth-state.json', $state);
    CafeStorage::atomicJson($staging.'/admin-data/menu.json', $menu);
    cafe_private_write($staging.'/admin-config.php', "<?php\ndeclare(strict_types=1);\nreturn ".var_export($config, true).";\n");
    foreach ($decoded as $name => $bytes) {
        if (!is_dir(dirname($staging.'/'.$name))) mkdir(dirname($staging.'/'.$name), 0700, true);
        cafe_private_write($staging.'/'.$name, $bytes);
    }
    if (isset($decoded['orders-data/orders.sqlite'])) {
        $db = new PDO('sqlite:'.$staging.'/orders-data/orders.sqlite', null, null, [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
        if ($db->query('PRAGMA integrity_check')->fetchColumn() !== 'ok') throw new RuntimeException('Invalid restored order database.');
        $db = null;
    }
    if (isset($decoded['registration-data/ledger.sqlite'])) {
        $db = new PDO('sqlite:'.$staging.'/registration-data/ledger.sqlite', null, null, [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
        if ($db->query('PRAGMA integrity_check')->fetchColumn() !== 'ok') throw new RuntimeException('Invalid restored registration database.');
        $db = null;
    }
    if (($snapshot['ordersConfig'] ?? null) !== null) {
        if (!is_array($snapshot['ordersConfig'])) throw new RuntimeException('Invalid ordering configuration.');
        $settings = $snapshot['ordersConfig']; $settings['enabled'] = false;
        cafe_private_write($staging.'/orders-config.php', "<?php\nreturn ".var_export($settings, true).";\n");
    }
    if (str_starts_with($origin, 'http:')) cafe_private_write($staging.'/.local-development', "Local test data; do not publish test orders.\n");
    if (file_exists($destination) || !rename($staging, $destination)) throw new RuntimeException('Destination became occupied; restore left in private staging.');
}

if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    try {
        umask(0077);
        $mode = $argv[1] ?? '';
        if ($mode === 'export' && in_array(count($argv), [5, 6], true) && (!isset($argv[5]) || $argv[5] === '--include-orders')) {
            cafe_export_private($argv[2], $argv[3], $argv[4], isset($argv[5]));
            echo "Encrypted private backup created. Keep its key separately; neither belongs in Git or the public site.\n";
        } elseif ($mode === 'import' && count($argv) === 6) {
            cafe_import_private($argv[2], $argv[3], $argv[4], $argv[5]);
            echo "Private data restored to a NEW directory. Passwords and authenticators preserved; sessions/devices cleared; orders and indexing require review.\n";
        } else throw new RuntimeException('Usage: private-data.php export PRIVATE BUNDLE KEY [--include-orders] | import BUNDLE KEY NEW_PRIVATE ORIGIN');
    } catch (Throwable $error) { fwrite(STDERR, "Private transfer failed. No existing destination was overwritten. ".$error->getMessage()."\n"); exit(1); }
}
