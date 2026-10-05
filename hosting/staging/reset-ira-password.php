<?php
declare(strict_types=1);
// One-time CLI operation in the private directory. Never an HTTP endpoint.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
ini_set('display_errors', '0');
umask(0077);

try {
    $directory = realpath($argv[1] ?? __DIR__);
    if (!$directory || count($argv) > 2 || !is_file($directory.'/admin-config.php') || !is_file($directory.'/app/auth.php') || !is_file($directory.'/admin-data/auth-state.json')) {
        throw new RuntimeException('Use the existing private directory after uploading the site update.');
    }
    require_once $directory.'/app/auth.php';
    $saved = require $directory.'/admin-config.php';
    $deployment = require $directory.'/app/deployment.php';
    if (!is_array($saved) || !is_array($deployment) || ($deployment['staging'] ?? false) !== true
        || ($deployment['public_origin'] ?? $deployment['publicOrigin'] ?? '') !== 'https://test888.ru'
        || ($saved['public_origin'] ?? $saved['publicOrigin'] ?? '') !== 'https://test888.ru') {
        throw new RuntimeException('This reset is only for test888.ru.');
    }
    $bundle = CafeStorage::readJson($directory.'/admin-password-reset-test888.json');
    if (!is_array($bundle) || ($bundle['version'] ?? null) !== 1 || ($bundle['origin'] ?? '') !== 'https://test888.ru'
        || ($bundle['username'] ?? '') !== 'ira.zhugan@inbox.ru'
        || !is_string($bundle['id'] ?? null) || !preg_match('/\A[a-f0-9]{32}\z/', $bundle['id'])
        || !is_int($bundle['expiresAt'] ?? null) || !is_string($bundle['passwordHash'] ?? null)
        || (password_get_info($bundle['passwordHash'])['algoName'] ?? '') !== 'bcrypt'
        || (password_get_info($bundle['passwordHash'])['options']['cost'] ?? 0) !== 12
        || !is_string($bundle['credentialVersion'] ?? null) || !preg_match('/\A[a-f0-9]{64}\z/', $bundle['credentialVersion'])) {
        throw new RuntimeException('Invalid private password reset package.');
    }
    $config = ['public_origin'=>'https://test888.ru', 'auth_mode'=>'password',
        'bootstrap_username'=>$saved['bootstrap_username'] ?? $saved['username'] ?? 'admin',
        'bootstrap_password_hash'=>$saved['bootstrap_password_hash'] ?? $saved['passwordHash'] ?? null,
        'encryption_key'=>$saved['encryption_key'] ?? $saved['encryptionKey'] ?? null];
    $auth = new CafeAuth($directory.'/admin-data', $config);
    $fingerprint = hash('sha256', json_encode($bundle, JSON_THROW_ON_ERROR));
    $result = CafeStorage::locked($directory.'/admin-data/auth.lock', function () use ($directory, $auth, $config, $bundle, $fingerprint): array {
        $file = $directory.'/admin-data/auth-state.json';
        $state = CafeStorage::readJson($file);
        if (!is_array($state) || ($state['version'] ?? null) !== 1) throw new RuntimeException('Invalid authentication state.');
        foreach (['sessions','challenges','enrollments','buckets'] as $section) {
            if (!is_array($state[$section] ?? null)) throw new RuntimeException('Invalid authentication state.');
        }
        foreach (['accounts','devices','passwordResets','credentialResetImports'] as $section) {
            if (isset($state[$section]) && !is_array($state[$section])) throw new RuntimeException('Invalid authentication state.');
        }
        $receipt = $state['credentialResetImports'][$bundle['id']] ?? null;
        if ($receipt !== null) {
            if (!is_array($receipt) || ($receipt['fingerprint'] ?? '') !== $fingerprint) throw new RuntimeException('Reset package ID conflict.');
            return ['status'=>'already_installed', 'username'=>$bundle['username']];
        }
        $now = (int)floor(microtime(true)*1000);
        if ($bundle['expiresAt'] <= $now || $bundle['expiresAt'] > $now + 7*86400000) throw new RuntimeException('Temporary password package expired or has an invalid deadline.');
        $auth->validatePortableState($state);
        $username = $bundle['username'];
        $owner = $state['account']['username'] ?? CafeAuth::normalizeUsername($config['bootstrap_username']);
        $existing = $username === $owner ? ($state['account'] ?? null) : ($state['accounts'][$username] ?? null);
        $oldVersion = $existing['credentialVersion'] ?? null;
        $account = array_replace($existing ?? ['version'=>1, 'username'=>$username, 'totp'=>null, 'recovery'=>[]],
            ['passwordHash'=>$bundle['passwordHash'], 'credentialVersion'=>$bundle['credentialVersion'],
                'temporaryPassword'=>true, 'initialExpiresAt'=>$bundle['expiresAt']]);
        $candidate = $state;
        if ($username === $owner) $candidate['account'] = $account;
        else { $account['secondary'] = true; $candidate['accounts'][$username] = $account; }
        foreach (['sessions','challenges','enrollments','devices','passwordResets'] as $section) {
            foreach ($candidate[$section] ?? [] as $id=>$record) {
                if (($record['username'] ?? null) === $username || ($record['accountUsername'] ?? null) === $username
                    || ($oldVersion !== null && ($record['credentialVersion'] ?? null) === $oldVersion)) unset($candidate[$section][$id]);
            }
        }
        $auth->validatePortableState($candidate);
        $candidate['credentialResetImports'][$bundle['id']] = ['fingerprint'=>$fingerprint, 'username'=>$username, 'installedAt'=>gmdate('c')];
        CafeStorage::atomicJson($file, $candidate);
        return ['status'=>'installed', 'username'=>$username];
    });
    CafeStorage::atomicJson($directory.'/admin-password-reset-status.json', $result + ['checkedAt'=>gmdate('c')]);
    echo json_encode($result, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR)."\n";
} catch (Throwable $error) {
    fwrite(STDERR, 'Password reset stopped: '.$error->getMessage()."\n");
    exit(1);
}
