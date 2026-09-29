<?php
declare(strict_types=1);

// Run locally/over SSH, never through a browser. Uses the existing private key.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once __DIR__ . '/auth.php';

try {
    $directory = isset($argv[1]) ? realpath($argv[1]) : false;
    if (!$directory || count($argv) !== 3 || !is_file($directory . '/admin-config.php')) throw new RuntimeException('Usage: php add-admin.php PRIVATE_DIRECTORY email (existing admin-config.php required)');
    $username = CafeAuth::normalizeUsername($argv[2]);
    if (!str_contains($username, '@')) throw new RuntimeException('Use an employee email address.');
    $saved = require $directory . '/admin-config.php';
    if (!is_array($saved)) throw new RuntimeException('Invalid private configuration.');
    $config = [
        'public_origin' => $saved['public_origin'] ?? $saved['publicOrigin'] ?? 'https://vosem-utra.ru',
        'bootstrap_username' => $saved['bootstrap_username'] ?? $saved['username'] ?? 'admin',
        'bootstrap_password_hash' => $saved['bootstrap_password_hash'] ?? $saved['passwordHash'] ?? null,
        'encryption_key' => $saved['encryption_key'] ?? $saved['encryptionKey'] ?? null,
    ];
    $password = rtrim(strtr(base64_encode(random_bytes(24)), '+/', '-_'), '=');
    $expiresAt = (int)floor(microtime(true) * 1000) + 604800000;
    $auth = new CafeAuth($directory . '/admin-data', $config);
    $account = ['version' => 1, 'username' => $username, 'passwordHash' => CafeAuth::hashPassword($password),
        'credentialVersion' => bin2hex(random_bytes(32)), 'totp' => null, 'recovery' => [],
        'temporaryPassword' => true, 'initialExpiresAt' => $expiresAt];
    $file = $directory . '/admin-access-' . bin2hex(random_bytes(6)) . '.txt';
    umask(0077);
    $handle = fopen($file, 'x');
    if (!$handle) throw new RuntimeException('Cannot save private access instructions.');
    $message = "НЕ ПУБЛИКОВАТЬ И НЕ ДОБАВЛЯТЬ В GIT\nПочта: {$username}\nВременный пароль: {$password}\nПервый вход до: " . gmdate('c', intdiv($expiresAt, 1000))
        . "\nОткройте /admin.html. Задайте свой пароль от 15 символов, подключите свой QR в Яндекс ID (Ключ) и сохраните резервные коды.\nПосле настройки временный пароль перестанет действовать. Браузер запомнится на 30 дней; на чужом устройстве нажмите «Выйти». Храните данные в менеджере паролей.\n";
    if (fwrite($handle, $message) !== strlen($message)) { fclose($handle); throw new RuntimeException('Could not save access instructions. Account not created.'); }
    fclose($handle);
    try { $auth->installAdditionalAccount($account); }
    catch (Throwable $error) { unlink($file); throw $error; }
    echo "Additional account created. Private first-login instructions: {$file}\n";
} catch (Throwable $error) {
    fwrite(STDERR, $error->getMessage() . "\n"); exit(1);
}
