<?php
declare(strict_types=1);

// Operator-only local utility; not a browser endpoint and never inside site/.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require __DIR__ . (is_file(__DIR__ . '/php/auth.php') ? '/php/auth.php' : '/app/auth.php');
$directory = $argv[1] ?? '';
if ($directory === '' || str_contains($directory, "\0")) {
    fwrite(STDERR, "Usage: php prepare-access.php PRIVATE_OUTPUT_DIRECTORY\n"); exit(1);
}
if (!is_dir($directory) && !mkdir($directory, 0700, true)) { throw new RuntimeException('Cannot create private directory'); }
$directory = realpath($directory);
foreach (['admin-config.php', 'admin-access.txt', 'admin-data'] as $name) {
    if (file_exists($directory . '/' . $name)) { throw new RuntimeException('Existing admin configuration or data must not be overwritten'); }
}
$import = null;
if (($argv[2] ?? '') === '--import-node') {
    $input = stream_get_contents(STDIN, 32769);
    if ($input === false || strlen($input) > 32768) throw new RuntimeException('Invalid private import');
    $import = json_decode($input, true, 32, JSON_THROW_ON_ERROR);
    if (!is_array($import) || !is_array($import['account'] ?? null) || ($import['account']['version'] ?? null) !== 2
        || !preg_match('/\A[a-f0-9]{64}\z/', $import['encryptionKey'] ?? '')) throw new RuntimeException('Invalid private import');
}
$password = rtrim(strtr(base64_encode(random_bytes(24)), '+/', '-_'), '=');
$config = [
    'publicOrigin' => 'https://vosem-utra.ru',
    'username' => $import ? CafeAuth::normalizeUsername($import['account']['username'] ?? null) : 'v.utra@yandex.ru',
    'passwordHash' => CafeAuth::hashPassword($password),
    'encryptionKey' => $import['encryptionKey'] ?? bin2hex(random_bytes(32)),
    'googleVerification' => '',
    'yandexVerification' => '',
];
if ($import !== null) {
    // Node/PHP use the same authenticated encryption format. No plaintext TOTP is exported.
    $account = ['version' => 1, 'username' => $config['username'], 'passwordHash' => $config['passwordHash'],
        'credentialVersion' => bin2hex(random_bytes(32)), 'totp' => $import['account']['totp'] ?? null,
        'recovery' => $import['account']['recovery'] ?? []];
    $auth = new CafeAuth($directory . '/admin-data', ['public_origin' => $config['publicOrigin'], 'encryption_key' => $config['encryptionKey']]);
    $auth->installAccount($account);
}
umask(0077);
$handle = fopen($directory . '/admin-config.php', 'x');
if ($handle === false) { throw new RuntimeException('Cannot create configuration'); }
fwrite($handle, "<?php\ndeclare(strict_types=1);\nreturn " . var_export($config, true) . ";\n");
fclose($handle);
$handle = fopen($directory . '/admin-access.txt', 'x');
if ($handle === false) { throw new RuntimeException('Cannot save initial access'); }
$mfa = $import !== null && ($import['account']['totp'] ?? null) !== null
    ? "Подключённое приложение и неиспользованные резервные коды перенесены. Используйте существующую запись «Восемь утра».\n"
    : "После входа подключите второй фактор и сохраните резервные коды.\n";
fwrite($handle, "Вход на REG.RU: https://vosem-utra.ru/admin\nПочта: {$config['username']}\nПервоначальный пароль: {$password}\n\nХраните в менеджере паролей. Этот файл не загружается на сайт и не попадает в GitHub.\n".$mfa."Локальный аккаунт Node.js этим инструментом не изменяется.\n");
fclose($handle);
echo "Private configuration and access instructions created. Keep them outside the public site and Git.\n";
