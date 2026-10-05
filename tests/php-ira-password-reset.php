<?php
declare(strict_types=1);
require_once __DIR__.'/../hosting/php/auth.php';

function check(bool $condition, string $message): void { if (!$condition) throw new RuntimeException($message); }
function rejected(callable $operation, string $code): void {
    try { $operation(); } catch (CafeAuthException $error) { check($error->errorCode === $code, 'Unexpected rejection: '.$error->errorCode); return; }
    throw new RuntimeException('Expected '.$code);
}
function install(string $directory): array {
    $process = proc_open([PHP_BINARY, __DIR__.'/../hosting/staging/reset-ira-password.php', $directory], [0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']], $pipes, null, null, ['bypass_shell'=>true]);
    check(is_resource($process), 'Installer starts'); fclose($pipes[0]);
    $out = stream_get_contents($pipes[1]); $err = stream_get_contents($pipes[2]); fclose($pipes[1]); fclose($pipes[2]);
    return ['code'=>proc_close($process), 'out'=>$out, 'err'=>$err];
}
$root = sys_get_temp_dir().'/cafe-ira-reset-'.bin2hex(random_bytes(8));
mkdir($root.'/app', 0700, true);
try {
    foreach (['auth.php','core.php'] as $name) copy(__DIR__.'/../hosting/php/'.$name, $root.'/app/'.$name);
    file_put_contents($root.'/app/deployment.php', "<?php return ['staging'=>true,'public_origin'=>'https://test888.ru'];");
    $config = ['public_origin'=>'https://test888.ru','bootstrap_username'=>'v.utra@yandex.ru','encryption_key'=>bin2hex(random_bytes(32)), 'auth_mode'=>'password'];
    file_put_contents($root.'/admin-config.php', '<?php return '.var_export($config, true).';');
    $auth = new CafeAuth($root.'/admin-data', $config);
    $oldPassword = 'old-fixture-password-2026'; $temporary = 'new-temporary-fixture-password';
    $base = ['version'=>1,'passwordHash'=>CafeAuth::hashPassword($oldPassword),'totp'=>null,'recovery'=>[]];
    $auth->installAccount($base+['username'=>'v.utra@yandex.ru','credentialVersion'=>bin2hex(random_bytes(32))]);
    $auth->installAdditionalAccount($base+['username'=>'ira.zhugan@inbox.ru','credentialVersion'=>bin2hex(random_bytes(32))]);
    $ownerSession = $auth->login(['username'=>'v.utra@yandex.ru','password'=>$oldPassword], 'owner');
    $iraSession = $auth->login(['username'=>'ira.zhugan@inbox.ru','password'=>$oldPassword], 'ira');
    $file = $root.'/admin-data/auth-state.json';
    $before = CafeStorage::readJson($file);
    foreach (['devices','passwordResets','challenges','enrollments'] as $section) {
        $before[$section]['owner-fixture'] = ['username'=>'v.utra@yandex.ru','credentialVersion'=>$before['account']['credentialVersion'],'expiresAt'=>(int)floor(microtime(true)*1000)+600000];
        $before[$section]['ira-fixture'] = ['username'=>'ira.zhugan@inbox.ru','credentialVersion'=>$before['accounts']['ira.zhugan@inbox.ru']['credentialVersion'],'expiresAt'=>(int)floor(microtime(true)*1000)+600000];
    }
    CafeStorage::atomicJson($file, $before);
    file_put_contents($root.'/admin-data/menu.json', '{"fixture":"preserve-menu"}');
    $configBefore = file_get_contents($root.'/admin-config.php');
    $bundle = ['version'=>1,'id'=>bin2hex(random_bytes(16)),'origin'=>'https://test888.ru','username'=>'ira.zhugan@inbox.ru',
        'passwordHash'=>password_hash($temporary, PASSWORD_BCRYPT, ['cost'=>12]), 'credentialVersion'=>bin2hex(random_bytes(32)),
        'expiresAt'=>(int)floor(microtime(true)*1000)+86400000];
    CafeStorage::atomicJson($root.'/admin-password-reset-test888.json', $bundle);
    $result = install($root);
    check($result['code'] === 0 && json_decode($result['out'], true)['status'] === 'installed', 'Installer succeeds: '.$result['err']);
    check(!str_contains($result['out'].$result['err'], $temporary) && !str_contains($result['out'].$result['err'], $bundle['passwordHash']), 'No credentials in installer output');
    $after = CafeStorage::readJson($file);
    check($after['account'] === $before['account'], 'Other account remains unchanged');
    foreach (['devices','passwordResets','challenges','enrollments'] as $section) {
        check($after[$section]['owner-fixture'] === $before[$section]['owner-fixture'] && !isset($after[$section]['ira-fixture']), 'Only target grants are revoked: '.$section);
    }
    check($auth->session($ownerSession['token']) !== null && $auth->session($iraSession['token']) === null, 'Only target sessions are revoked');
    check(file_get_contents($root.'/admin-config.php') === $configBefore && file_get_contents($root.'/admin-data/menu.json') === '{"fixture":"preserve-menu"}', 'Configuration and menu preserved');
    rejected(fn()=>$auth->login(['username'=>'ira.zhugan@inbox.ru','password'=>$oldPassword], 'ira'), 'invalid_credentials');
    $login = $auth->login(['username'=>'ira.zhugan@inbox.ru','password'=>$temporary], 'ira');
    check($login['passwordChangeRequired'] && !isset($login['token']), 'Temporary password cannot open admin before changing');
    rejected(fn()=>$auth->completePasswordReset(['passwordToken'=>$login['passwordToken'],'password'=>$temporary], 'ira'), 'invalid_password');
    $auth->completePasswordReset(['passwordToken'=>$login['passwordToken'],'password'=>'permanent-fixture-password-2026'], 'ira');
    rejected(fn()=>$auth->login(['username'=>'ira.zhugan@inbox.ru','password'=>$temporary], 'ira'), 'invalid_credentials');
    check($auth->login(['username'=>'ira.zhugan@inbox.ru','password'=>'permanent-fixture-password-2026'], 'ira')['authenticated'], 'Own password opens admin');
    $changed = file_get_contents($file);
    check(json_decode(install($root)['out'], true)['status'] === 'already_installed' && file_get_contents($file) === $changed, 'Repeating cron never resets the chosen password');
    echo "PASS: target-only reset, required new password, revoked target sessions, unchanged owner/menu/config, idempotent installation\n";
    foreach (['expired','wrong-host','wrong-user','bad-hash','conflicting-id'] as $reason) {
        $invalid = $bundle; if ($reason !== 'conflicting-id') $invalid['id'] = bin2hex(random_bytes(16));
        if ($reason === 'expired') $invalid['expiresAt'] = 1;
        if ($reason === 'wrong-host') $invalid['origin'] = 'https://other.example';
        if ($reason === 'wrong-user') $invalid['username'] = 'v.utra@yandex.ru';
        if ($reason === 'bad-hash') $invalid['passwordHash'] = 'invalid';
        if ($reason === 'conflicting-id') $invalid['expiresAt']++;
        CafeStorage::atomicJson($root.'/admin-password-reset-test888.json', $invalid);
        check(install($root)['code'] !== 0 && file_get_contents($file) === $changed, 'Invalid package cannot change access: '.$reason);
    }
    echo "PASS: expired, wrong-host, wrong-user, invalid-hash and changed-ID bundles fail closed\n";
    $missing = CafeStorage::readJson($file); unset($missing['accounts']['ira.zhugan@inbox.ru']); CafeStorage::atomicJson($file, $missing);
    $bundle['id'] = bin2hex(random_bytes(16)); CafeStorage::atomicJson($root.'/admin-password-reset-test888.json', $bundle);
    check(install($root)['code'] === 0, 'Authorized target can be added if the prior invitation was never installed');
    check($auth->login(['username'=>'ira.zhugan@inbox.ru','password'=>$temporary], 'ira')['passwordChangeRequired'], 'New target must also change the temporary password');
    echo "PASS: missing target is provisioned without changing the owner\n";
} finally {
    $resolved = realpath($root); $temp = realpath(sys_get_temp_dir());
    if (!$resolved || !$temp || dirname($resolved) !== $temp || !str_starts_with(basename($resolved), 'cafe-ira-reset-')) throw new RuntimeException('Unsafe cleanup');
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($resolved, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST) as $entry) {
        if ($entry->isDir() && !$entry->isLink()) rmdir($entry->getPathname()); else unlink($entry->getPathname());
    }
    rmdir($resolved);
}
