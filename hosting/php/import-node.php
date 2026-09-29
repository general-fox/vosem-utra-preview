<?php
declare(strict_types=1);
// One-time offline conversion. Passwords arrive through stdin, never argv or logs.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once __DIR__.'/auth.php';
try {
    $directory = $argv[1] ?? '';
    if (!is_dir($directory) || count(scandir($directory)) !== 2) throw new RuntimeException('Use an empty staging directory.');
    $input = stream_get_contents(STDIN, 1048577);
    if ($input === false || strlen($input) > 1048576) throw new RuntimeException('Invalid import');
    $source = json_decode($input, true, 64, JSON_THROW_ON_ERROR);
    if (!is_array($source['accounts'] ?? null) || !preg_match('/\A[a-f0-9]{64}\z/', $source['encryptionKey'] ?? '')) throw new RuntimeException('Invalid import');
    $config = ['publicOrigin'=>'https://vosem-utra.ru', 'encryptionKey'=>$source['encryptionKey'], 'indexing'=>false];
    $auth = new CafeAuth($directory.'/admin-data', ['public_origin'=>$config['publicOrigin'], 'encryption_key'=>$config['encryptionKey']]);
    foreach ($source['accounts'] as $entry) {
        $old = $entry['account'];
        $account = ['version'=>1, 'username'=>CafeAuth::normalizeUsername($old['username']),
            'passwordHash'=>CafeAuth::hashPassword($entry['password']), 'credentialVersion'=>bin2hex(random_bytes(32)),
            'totp'=>$old['totp'] ?? null, 'recovery'=>$old['recovery'] ?? []];
        if (($old['temporaryPassword'] ?? false) === true) {
            $account['temporaryPassword'] = true; $account['initialExpiresAt'] = $old['initialExpiresAt'];
        }
        if (($old['secondary'] ?? false) === true) $auth->installAdditionalAccount($account);
        else $auth->installAccount($account);
    }
    umask(0077);
    if (file_put_contents($directory.'/admin-config.php', "<?php\ndeclare(strict_types=1);\nreturn ".var_export($config, true).";\n") === false) throw new RuntimeException('Write failed');
    echo "PHP accounts prepared; existing passwords and enrolled authenticators preserved.\n";
} catch (Throwable) { fwrite(STDERR, "Cannot convert private accounts. Nothing in the source was changed.\n"); exit(1); }
