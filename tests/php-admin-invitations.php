<?php
declare(strict_types=1);
require_once __DIR__.'/../hosting/php/auth.php';

$fixtures = [];
$temporaryPassword = 'fixture-only-temporary-password';
$temporaryHash = password_hash($temporaryPassword, PASSWORD_BCRYPT, ['cost'=>12]);
$installer = __DIR__.'/../hosting/staging/install-admins.php';
function check(bool $ok, string $message): void { if (!$ok) throw new RuntimeException($message); }
function command(array $arguments): array {
    $process = proc_open([PHP_BINARY, ...$arguments], [0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']], $pipes, null, null, ['bypass_shell'=>true]);
    if (!is_resource($process)) throw new RuntimeException('Cannot start test process');
    fclose($pipes[0]);
    $out = stream_get_contents($pipes[1]); $err = stream_get_contents($pipes[2]);
    fclose($pipes[1]); fclose($pipes[2]);
    return ['code'=>proc_close($process), 'out'=>$out, 'err'=>$err];
}
function fixture(string $owner = 'test-admin@test888.ru'): array {
    global $fixtures, $temporaryHash;
    $root = sys_get_temp_dir().'/cafe-invitations-'.bin2hex(random_bytes(8));
    mkdir($root.'/app', 0700, true); $fixtures[] = realpath($root);
    foreach (['auth.php', 'core.php'] as $name) copy(__DIR__.'/../hosting/php/'.$name, $root.'/app/'.$name);
    file_put_contents($root.'/app/deployment.php', "<?php return ['staging'=>true, 'public_origin'=>'https://test888.ru'];");
    $config = ['public_origin'=>'https://test888.ru', 'bootstrap_username'=>$owner, 'bootstrap_password_hash'=>$temporaryHash, 'encryption_key'=>bin2hex(random_bytes(32))];
    file_put_contents($root.'/admin-config.php', '<?php return '.var_export($config, true).';');
    $auth = new CafeAuth($root.'/admin-data', $config);
    $auth->installAccount(['version'=>1, 'username'=>$owner, 'passwordHash'=>$temporaryHash, 'credentialVersion'=>bin2hex(random_bytes(32)), 'totp'=>null, 'recovery'=>[]]);
    $pending = $auth->login(['username'=>$owner,'password'=>'fixture-only-temporary-password'], 'owner-peer');
    $start = $auth->enrollStart(['challengeToken'=>$pending['challengeToken'], 'username'=>$owner], 'owner-peer');
    $auth->enrollConfirm(['enrollmentToken'=>$start['enrollmentToken'], 'code'=>CafeAuth::totp($start['secret'], (int)floor(microtime(true)*1000))], 'owner-peer');
    $bundle = ['version'=>1, 'id'=>bin2hex(random_bytes(16)), 'origin'=>'https://test888.ru', 'expiresAt'=>(int)floor(microtime(true)*1000)+86400000,
        'accounts'=>array_map(static fn($username)=>['username'=>$username, 'passwordHash'=>$temporaryHash, 'credentialVersion'=>bin2hex(random_bytes(32))], ['v.utra@yandex.ru', 'ira.zhugan@inbox.ru'])];
    CafeStorage::atomicJson($root.'/admin-invitations-test888.json', $bundle);
    file_put_contents($root.'/admin-data/menu.json', '{"fixture":"menu-preserve"}');
    file_put_contents($root.'/kds-config.json', '{"fixture":"integration-preserve"}');
    return ['root'=>$root, 'auth'=>$auth, 'config'=>$config, 'bundle'=>$bundle];
}
function state(array $fixture): array { return CafeStorage::readJson($fixture['root'].'/admin-data/auth-state.json'); }
function runInstaller(array $fixture): array { global $installer; return command([$installer, $fixture['root']]); }
function rejected(callable $operation, string $code): void {
    try { $operation(); } catch (CafeAuthException $error) { check($error->errorCode === $code, 'Unexpected rejection'); return; }
    throw new RuntimeException('Expected authentication rejection');
}
function cleanup(string $root): void {
    $resolved = realpath($root); $temp = realpath(sys_get_temp_dir());
    if (!$resolved || !$temp || dirname($resolved) !== $temp || !str_starts_with(basename($resolved), 'cafe-invitations-')) throw new RuntimeException('Unsafe cleanup path');
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($resolved, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($iterator as $entry) { if ($entry->isDir() && !$entry->isLink()) rmdir($entry->getPathname()); else unlink($entry->getPathname()); }
    rmdir($resolved);
}

try {
    $app = fixture(); $before = state($app);
    $files = array_map(fn($name)=>hash_file('sha256', $app['root'].'/'.$name), ['admin-config.php', 'admin-data/menu.json', 'kds-config.json']);
    $result = runInstaller($app);
    check($result['code'] === 0 && json_decode($result['out'], true)['status'] === 'installed', 'Batch did not install');
    $after = state($app); $preserved = $after; unset($preserved['adminImports']); $preserved['accounts'] = $before['accounts'];
    check($preserved === $before, 'Existing owner, sessions or devices changed');
    check(count($after['accounts']) === 2, 'Both administrators must be installed');
    check($files === array_map(fn($name)=>hash_file('sha256', $app['root'].'/'.$name), ['admin-config.php', 'admin-data/menu.json', 'kds-config.json']), 'Site data changed');
    check(!str_contains($result['out'].$result['err'], $temporaryPassword) && !str_contains($result['out'].$result['err'], $temporaryHash), 'Sensitive installer output');
    echo "PASS: installs both accounts, preserves owner/sessions/devices/menu/configuration\n";

    $secrets = [];
    foreach (array_keys($after['accounts']) as $index=>$username) {
        $auth = $app['auth']; $peer = 'new-admin-'.$index;
        $login = $auth->login(['username'=>$username, 'password'=>$temporaryPassword], $peer);
        check($login['enrollmentRequired'] && $login['requiresNewPassword'] && !isset($login['token']), 'No MFA/password enrollment gate');
        rejected(fn()=>$auth->enrollStart(['challengeToken'=>$login['challengeToken'], 'username'=>$username, 'password'=>$temporaryPassword], $peer), 'invalid_password');
        $start = $auth->enrollStart(['challengeToken'=>$login['challengeToken'], 'username'=>$username, 'password'=>'new-unique-fixture-password-'.$index], $peer);
        $secrets[] = $start['secret'];
        rejected(fn()=>$auth->enrollConfirm(['enrollmentToken'=>$start['enrollmentToken'], 'code'=>'invalid'], $peer), 'invalid_code');
        $done = $auth->enrollConfirm(['enrollmentToken'=>$start['enrollmentToken'], 'code'=>CafeAuth::totp($start['secret'], (int)floor(microtime(true)*1000))], $peer);
        check(count($done['recoveryCodes']) === 10 && $auth->session($done['token'])['username'] === $username, 'MFA enrollment did not authorize correct account');
        rejected(fn()=>$auth->login(['username'=>$username, 'password'=>$temporaryPassword], $peer), 'invalid_credentials');
        check($auth->login(['username'=>$username, 'password'=>'new-unique-fixture-password-'.$index], $peer)['mfaRequired'], 'New password must require MFA');
    }
    check($secrets[0] !== $secrets[1], 'Accounts must have independent TOTP secrets');
    echo "PASS: independent MFA, required new passwords, temporary passwords stop working\n";

    $enrolled = state($app); $rerun = runInstaller($app);
    check($rerun['code'] === 0 && json_decode($rerun['out'], true)['status'] === 'already_installed' && state($app) === $enrolled, 'Rerun modified enrolled accounts');
    echo "PASS: repeat installation does not reset passwords, MFA or active sessions\n";

    $collision = fixture('ira.zhugan@inbox.ru'); $original = state($collision);
    $failed = runInstaller($collision);
    check($failed['code'] !== 0 && str_contains($failed['err'], 'Account already exists') && state($collision) === $original, 'Collision caused partial creation or overwrite');
    echo "PASS: conflict on second email rejects entire batch without partial creation\n";

    foreach (['expired', 'wrong-origin', 'bad-hash', 'bad-key'] as $reason) {
        $bad = fixture(); $original = state($bad); $payload = $bad['bundle'];
        if ($reason === 'expired') $payload['expiresAt'] = 1;
        if ($reason === 'wrong-origin') $payload['origin'] = 'https://vosem-utra.ru';
        if ($reason === 'bad-hash') $payload['accounts'][1]['passwordHash'] = 'invalid';
        if ($reason === 'bad-key') { $bad['config']['encryption_key'] = bin2hex(random_bytes(32)); file_put_contents($bad['root'].'/admin-config.php', '<?php return '.var_export($bad['config'], true).';'); }
        CafeStorage::atomicJson($bad['root'].'/admin-invitations-test888.json', $payload);
        check(runInstaller($bad)['code'] !== 0 && state($bad) === $original, 'Invalid package changed account state: '.$reason);
    }
    echo "PASS: expired, wrong-site, invalid-hash and mismatched-key packages cannot change access\n";

    $bundle = $app['bundle']; $bundle['expiresAt']++;
    CafeStorage::atomicJson($app['root'].'/admin-invitations-test888.json', $bundle);
    check(runInstaller($app)['code'] !== 0 && state($app) === $enrolled, 'Changed package reused prior receipt');
    echo "PASS: changed package cannot reuse completed installation ID\n";
} finally { foreach ($fixtures as $root) cleanup($root); }
