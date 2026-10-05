<?php
declare(strict_types=1);
// Local packaging utility. Never shipped in site/ or exposed over HTTP.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once __DIR__.'/../php/private-data.php';
try {
    umask(0077);
    [$script, $mode, $target, $notes, $source] = $argv + array_fill(0, 5, '');
    if (!in_array($mode, ['fresh', 'preserve'], true) || !is_dir($target.'/app') || !is_file($target.'/app/deployment.php')) throw new RuntimeException('Expected a new test package');
    $profile = require $target.'/app/deployment.php';
    if (($profile['public_origin'] ?? '') !== 'https://test888.ru' || ($profile['staging'] ?? false) !== true) throw new RuntimeException('Only test888.ru is supported');
    foreach (['admin-config.php', 'admin-data'] as $name) if (file_exists($target.'/'.$name)) throw new RuntimeException('Existing test access must not be overwritten');
    if (file_exists($notes)) throw new RuntimeException('Access note must be new');
    $snapshot = cafe_snapshot($source, false);
    if ($mode === 'preserve') {
        $config = $snapshot['config'];
        $state = cafe_cold_state($snapshot['auth']);
        $instructions = "Используйте текущие логин и пароль. Сессии сброшены.\nВход выполняется через сайт, подтверждение через приложение не требуется.\n";
    } else {
        $password = bin2hex(random_bytes(16));
        $config = ['username'=>'test-admin@test888.ru', 'encryptionKey'=>bin2hex(random_bytes(32))];
        $state = ['version'=>1, 'account'=>[
            'version'=>1, 'username'=>$config['username'], 'passwordHash'=>CafeAuth::hashPassword($password),
            'credentialVersion'=>bin2hex(random_bytes(32)), 'totp'=>null, 'recovery'=>[],
            'temporaryPassword'=>true, 'initialExpiresAt'=>(int)floor(microtime(true)*1000)+14*86400000,
        ], 'accounts'=>[], 'sessions'=>[], 'devices'=>[], 'challenges'=>[], 'enrollments'=>[], 'buckets'=>[]];
        $instructions = "Логин: {$config['username']}\nВременный пароль: {$password}\n\nПервый вход доступен в течение 14 дней после создания пакета.\nПри первом входе задайте свой пароль, отличный от временного, затем войдите с новым паролем.\nЭтот логин не создаёт почтовый ящик и не требует его наличия.\nРабочий вход на компьютере не менялся.\n";
    }
    $config['publicOrigin'] = 'https://test888.ru'; $config['indexing'] = false;
    unset($config['public_origin']);
    $auth = new CafeAuth($target.'/admin-data', cafe_portable_auth_config($config));
    $auth->validatePortableState($state);
    CafeStorage::atomicJson($target.'/admin-data/auth-state.json', $state);
    CafeStorage::atomicJson($target.'/admin-data/menu.json', $snapshot['menu']);
    foreach ($snapshot['files'] as $name => $encoded) {
        if (!str_starts_with($name, 'admin-data/uploads/')) throw new RuntimeException('Unexpected snapshot file');
        $destination = $target.'/'.$name;
        if (!is_dir(dirname($destination))) mkdir(dirname($destination), 0700, true);
        cafe_private_write($destination, base64_decode($encoded, true));
    }
    cafe_private_write($target.'/admin-config.php', "<?php\nreturn ".var_export($config, true).";\n");
    cafe_private_write($notes, "ДОСТУП ТОЛЬКО ДЛЯ TEST888.RU\nhttps://test888.ru/admin\n\n".$instructions."\nЭтот файл не загружайте на хостинг или в GitHub. Сохраните пароль в менеджере паролей.\n");
    echo "Test access and current menu prepared. No orders, sessions or integration tokens copied.\n";
} catch (Throwable) {
    fwrite(STDERR, "Test package preparation failed. Existing access was not replaced.\n"); exit(1);
}
