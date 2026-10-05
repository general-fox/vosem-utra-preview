<?php
declare(strict_types=1);
// Local packaging only. Keep the destination outside the repository.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once __DIR__.'/../hosting/php/private-data.php';

try {
    umask(0077);
    if (count($argv) !== 2 || !is_dir(dirname($argv[1])) || file_exists($argv[1])) throw new RuntimeException('Pass a new output directory. Existing packages are never overwritten.');
    $parent = realpath(dirname($argv[1]));
    $repository = str_replace('\\', '/', realpath(__DIR__.'/..'));
    $destination = str_replace('\\', '/', $parent.'/'.basename($argv[1]));
    if (strtolower($destination) === strtolower($repository) || str_starts_with(strtolower($destination), strtolower($repository).'/')) throw new RuntimeException('The private package must be outside the repository.');
    mkdir($destination, 0700);
    $upload = $destination.'/upload/vosem-utra-private';
    mkdir($upload, 0700, true);
    $expires = (int)floor(microtime(true)*1000) + 7*86400000;
    $bundle = ['version'=>1, 'id'=>bin2hex(random_bytes(16)), 'origin'=>'https://test888.ru', 'expiresAt'=>$expires, 'accounts'=>[]];
    $expiryMoscow = (new DateTimeImmutable('@'.intdiv($expires, 1000)))->setTimezone(new DateTimeZone('Europe/Moscow'))->format('d.m.Y H:i');
    foreach (['v.utra@yandex.ru', 'ira.zhugan@inbox.ru'] as $username) {
        $password = rtrim(strtr(base64_encode(random_bytes(24)), '+/', '-_'), '=');
        // Portable PHP 8.3 hash; upgraded by the normal password flow on the host.
        $hash = password_hash($password, PASSWORD_BCRYPT, ['cost'=>12]);
        if (!is_string($hash)) throw new RuntimeException('Password hashing unavailable.');
        $bundle['accounts'][] = ['username'=>$username, 'passwordHash'=>$hash, 'credentialVersion'=>bin2hex(random_bytes(32))];
        $note = "ДОСТУП ТОЛЬКО ДЛЯ TEST888.RU\nЭтот файл не загружать на хостинг или в GitHub.\n\nАдминка: https://test888.ru/admin.html\nЛогин: {$username}\nВременный пароль: {$password}\nПервый вход до: {$expiryMoscow} (Москва).\n\nДанные начнут работать после установки пакета на хостинге.\nПри первом входе задайте свой пароль, отличный от временного, затем войдите с новым паролем.\nПароль от почты не нужен. После смены временный пароль перестанет действовать.\nУ каждого аккаунта свой пароль. Следующие входы выполняются через сайт.\n";
        cafe_private_write($destination.'/admin-access-'.str_replace('@', '-at-', $username).'.txt', $note);
    }
    CafeStorage::atomicJson($upload.'/admin-invitations-test888.json', $bundle);
    cafe_private_write($upload.'/install-admins-test888.php', file_get_contents(__DIR__.'/../hosting/staging/install-admins.php'));
    echo 'Prepared two staging administrator invitations; passwords are in local access files, excluded from upload.'."\n";
} catch (Throwable $error) {
    fwrite(STDERR, 'Package preparation stopped: '.$error->getMessage()."\n");
    exit(1);
}
