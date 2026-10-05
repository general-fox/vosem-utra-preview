<?php
declare(strict_types=1);
// One-time offline installation beside admin-config.php; never a web endpoint.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
ini_set('display_errors', '0');
umask(0077);

try {
    $directory = realpath($argv[1] ?? __DIR__);
    if (!$directory || count($argv) > 2 || !is_file($directory.'/app/auth.php') || !is_file($directory.'/admin-config.php') || !is_file($directory.'/admin-data/auth-state.json')) {
        throw new RuntimeException('Use the existing vosem-utra-private directory. No account was changed.');
    }
    require_once $directory.'/app/auth.php';
    $saved = require $directory.'/admin-config.php';
    $profile = require $directory.'/app/deployment.php';
    if (!is_array($saved) || !is_array($profile) || ($profile['staging'] ?? false) !== true || ($profile['public_origin'] ?? $profile['publicOrigin'] ?? '') !== 'https://test888.ru'
        || ($saved['public_origin'] ?? $saved['publicOrigin'] ?? '') !== 'https://test888.ru') {
        throw new RuntimeException('This package is only for the existing https://test888.ru staging site.');
    }
    $config = [
        'public_origin'=>'https://test888.ru',
        'bootstrap_username'=>$saved['bootstrap_username'] ?? $saved['username'] ?? 'admin',
        'bootstrap_password_hash'=>$saved['bootstrap_password_hash'] ?? $saved['passwordHash'] ?? null,
        'encryption_key'=>$saved['encryption_key'] ?? $saved['encryptionKey'] ?? null,
    ];
    $bundle = CafeStorage::readJson($directory.'/admin-invitations-test888.json');
    if (!is_array($bundle) || ($bundle['version'] ?? null) !== 1 || ($bundle['origin'] ?? '') !== $config['public_origin']
        || !is_string($bundle['id'] ?? null) || !preg_match('/\A[a-f0-9]{32}\z/', $bundle['id'])
        || !is_int($bundle['expiresAt'] ?? null) || !is_array($bundle['accounts'] ?? null) || count($bundle['accounts']) !== 2) {
        throw new RuntimeException('Invalid administrator invitation package.');
    }
    $accounts = [];
    foreach ($bundle['accounts'] as $record) {
        if (!is_array($record)) throw new RuntimeException('Invalid administrator invitation.');
        $username = CafeAuth::normalizeUsername($record['username'] ?? null);
        if ($username !== ($record['username'] ?? null) || !str_contains($username, '@') || isset($accounts[$username])
            || !is_string($record['passwordHash'] ?? null) || (password_get_info($record['passwordHash'])['algoName'] ?? '') !== 'bcrypt'
            || (password_get_info($record['passwordHash'])['options']['cost'] ?? 0) !== 12
            || !is_string($record['credentialVersion'] ?? null) || !preg_match('/\A[a-f0-9]{64}\z/', $record['credentialVersion'])) {
            throw new RuntimeException('Invalid or duplicate administrator invitation.');
        }
        $accounts[$username] = ['version'=>1, 'username'=>$username, 'passwordHash'=>$record['passwordHash'],
            'credentialVersion'=>$record['credentialVersion'], 'secondary'=>true, 'totp'=>null, 'recovery'=>[],
            'temporaryPassword'=>true, 'initialExpiresAt'=>$bundle['expiresAt']];
    }
    $fingerprint = hash('sha256', json_encode($bundle, JSON_THROW_ON_ERROR));
    $auth = new CafeAuth($directory.'/admin-data', $config);
    // Same lock and atomic writer as live authentication: no stale state upload or lost sessions.
    $result = CafeStorage::locked($directory.'/admin-data/auth.lock', function () use ($directory, $config, $bundle, $accounts, $fingerprint, $auth): array {
        $file = $directory.'/admin-data/auth-state.json';
        $state = CafeStorage::readJson($file);
        if (!is_array($state) || ($state['version'] ?? null) !== 1) throw new RuntimeException('Invalid existing authentication state.');
        foreach (['sessions', 'challenges', 'enrollments', 'buckets'] as $section) {
            if (!is_array($state[$section] ?? null)) throw new RuntimeException('Invalid existing authentication state.');
        }
        foreach (['accounts', 'devices', 'adminImports'] as $section) {
            if (isset($state[$section]) && !is_array($state[$section])) throw new RuntimeException('Invalid existing authentication state.');
        }
        $receipt = $state['adminImports'][$bundle['id']] ?? null;
        if ($receipt !== null) {
            if (!is_array($receipt) || ($receipt['fingerprint'] ?? '') !== $fingerprint) throw new RuntimeException('Package ID conflict. Nothing was changed.');
            return ['status'=>'already_installed', 'users'=>$receipt['users']];
        }
        if ($bundle['expiresAt'] <= (int)floor(microtime(true)*1000)) throw new RuntimeException('Temporary passwords expired. Request a new package. Nothing was changed.');
        $candidate = $state;
        $candidate['accounts'] ??= [];
        $owner = $state['account']['username'] ?? CafeAuth::normalizeUsername($config['bootstrap_username']);
        foreach ($accounts as $username => $account) {
            if ($username === $owner || isset($candidate['accounts'][$username])) {
                throw new RuntimeException('Account already exists: '.$username.'. Neither account was changed. Do not remove existing authentication files.');
            }
            $candidate['accounts'][$username] = $account;
        }
        $auth->validatePortableState($candidate);
        $receipt = ['fingerprint'=>$fingerprint, 'users'=>array_keys($accounts), 'createdAt'=>gmdate('c')];
        $candidate['adminImports'][$bundle['id']] = $receipt;
        CafeStorage::atomicJson($file, $candidate);
        $auth->audit('credentials.batch_added', '', ['users'=>$receipt['users']]);
        return ['status'=>'installed', 'users'=>$receipt['users']];
    });
    echo json_encode($result, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR)."\n";
} catch (Throwable $error) {
    // Errors contain paths/validation messages only; never dump the bundle or configuration.
    fwrite(STDERR, 'Administrator installation stopped: '.$error->getMessage()."\n");
    exit(1);
}
