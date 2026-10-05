<?php
declare(strict_types=1);
require_once __DIR__ . '/../hosting/php/auth.php';

const TEST_PASSWORD = 'test-only-long-password';
const TEST_NOW = 1800000000000;
$passwordHash = CafeAuth::hashPassword(TEST_PASSWORD);
$directories = [];
$passed = 0;

function check(bool $condition, string $message = 'Assertion failed'): void { if (!$condition) throw new RuntimeException($message); }
function expectError(callable $operation, string $code, ?int $status = null): void {
    try { $operation(); } catch (CafeAuthException $error) { check($error->errorCode === $code, 'Unexpected auth error code'); if ($status !== null) check($error->status === $status, 'Unexpected auth status'); return; }
    throw new RuntimeException('Expected auth error');
}
function fixture(array $overrides = []): array {
    global $directories, $passwordHash;
    $directory = sys_get_temp_dir() . '/cafe-php-auth-' . bin2hex(random_bytes(8));
    mkdir($directory, 0700, true); $directories[] = $directory;
    $clock = (object)['now' => TEST_NOW];
    $config = array_replace(['public_origin' => 'https://cafe.example', 'encryption_key' => str_repeat('33', 32), 'bootstrap_username' => 'v.utra@yandex.ru', 'bootstrap_password_hash' => $passwordHash], $overrides);
    $config['clock'] = static fn(): int => $clock->now;
    return ['directory' => $directory, 'config' => $config, 'clock' => $clock, 'auth' => new CafeAuth($directory, $config)];
}
function credentials(string $password = TEST_PASSWORD): array { return ['username' => ' V.UTRA@YANDEX.RU ', 'password' => $password]; }
function state(array $app): array { return CafeStorage::readJson($app['directory'] . '/auth-state.json'); }
function enroll(array $app): array {
    $pending = $app['auth']->login(credentials(), 'peer');
    $started = $app['auth']->enrollStart(['challengeToken' => $pending['challengeToken'], 'username' => 'v.utra@yandex.ru'], 'peer');
    $done = $app['auth']->enrollConfirm(['enrollmentToken' => $started['enrollmentToken'], 'code' => CafeAuth::totp($started['secret'], $app['clock']->now)], 'peer');
    return ['pending' => $pending, 'started' => $started, 'done' => $done];
}
function parallel(array $app, array $jobs): array {
    $running = [];
    foreach ($jobs as $job) {
        $filename = $app['directory'] . '/worker-' . bin2hex(random_bytes(6)) . '.json';
        $config = $app['config']; unset($config['clock']);
        CafeStorage::atomicJson($filename, $job + ['directory' => $app['directory'], 'config' => $config, 'now' => $app['clock']->now, 'peer' => 'peer']);
        $pipes = [];
        $process = proc_open([PHP_BINARY, __DIR__ . '/php-auth-worker.php', $filename], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, null, ['bypass_shell' => true]);
        if (!is_resource($process)) throw new RuntimeException('Cannot start PHP concurrency test');
        fclose($pipes[0]); $running[] = [$process, $pipes, $filename];
    }
    $results = [];
    foreach ($running as [$process, $pipes, $filename]) {
        $output = stream_get_contents($pipes[1]); $error = stream_get_contents($pipes[2]);
        fclose($pipes[1]); fclose($pipes[2]); $exit = proc_close($process); unlink($filename);
        check($exit === 0 && $error === '', 'PHP worker failed');
        $results[] = json_decode($output, true, 512, JSON_THROW_ON_ERROR);
    }
    return $results;
}
function runTest(string $name, callable $operation): void { global $passed; $operation(); $passed++; echo "PASS: {$name}\n"; }
function removeFixture(string $directory): void {
    // Every entry belongs to a randomly created test fixture; never remove application data.
    $resolved = realpath($directory); $temporary = realpath(sys_get_temp_dir());
    if ($resolved === false || $temporary === false || dirname($resolved) !== $temporary || !str_starts_with(basename($resolved), 'cafe-php-auth-')) throw new RuntimeException('Unsafe test cleanup path');
    foreach (scandir($resolved) as $name) if ($name !== '.' && $name !== '..') { $entry = $resolved . DIRECTORY_SEPARATOR . $name; if (is_dir($entry)) rmdir($entry); else unlink($entry); }
    rmdir($resolved);
}

try {
    runTest('RFC 6238 SHA1/SHA256/SHA512 vectors and base32', function () {
        $vectors = [[59, '94287082', '46119246', '90693936'], [1111111109, '07081804', '68084774', '25091201'], [1111111111, '14050471', '67062674', '99943326'], [1234567890, '89005924', '91819424', '93441116'], [2000000000, '69279037', '90698825', '38618901'], [20000000000, '65353130', '77737706', '47863826']];
        $secrets = ['12345678901234567890', '12345678901234567890123456789012', str_repeat('1234567890', 6) . '1234'];
        foreach ($vectors as $vector) foreach (['sha1', 'sha256', 'sha512'] as $index => $algorithm) check(CafeAuth::totp(CafeAuth::base32Encode($secrets[$index]), $vector[0] * 1000, 8, $algorithm) === $vector[$index + 1]);
    });
    runTest('email validation, native password hashes and bcrypt non-truncation', function () {
        global $passwordHash;
        check(CafeAuth::normalizeUsername(' V.Utra@Yandex.RU ') === 'v.utra@yandex.ru');
        check(CafeAuth::normalizeUsername(' OWNER ') === 'owner');
        foreach (['a@@b.ru', '.a@b.ru', 'a..b@c.ru', 'a@-b.ru', "a@b.ru\n", str_repeat('a', 65) . '@b.ru'] as $value) expectError(fn() => CafeAuth::normalizeUsername($value), 'invalid_username');
        expectError(fn() => CafeAuth::hashPassword('short-7'), 'invalid_password');
        expectError(fn() => CafeAuth::hashPassword(str_repeat('я', 7)), 'invalid_password');
        foreach (['eight-8!', str_repeat('я', 8)] as $password) check(password_verify($password, CafeAuth::hashPassword($password)));
        check(password_verify(TEST_PASSWORD, $passwordHash));
        if (CafeAuth::passwordAlgorithm() === PASSWORD_ARGON2ID) check(password_get_info($passwordHash)['options']['memory_cost'] >= 65536);
        $app = fixture(['bootstrap_password_hash' => password_hash(str_repeat('x', 72), PASSWORD_BCRYPT, ['cost' => 12])]);
        expectError(fn() => $app['auth']->login(credentials(str_repeat('x', 73)), 'peer'), 'invalid_credentials');
        check($app['auth']->login(credentials(str_repeat('x', 72)), 'peer')['enrollmentRequired']);
    });
    runTest('HTTPS/key/private-storage gates and no public first-account registration', function () {
        foreach ([['public_origin' => 'http://cafe.example'], ['encryption_key' => ''], ['bootstrap_password_hash' => '']] as $override) {
            $app = fixture($override); check(!$app['auth']->status()['enrollmentAvailable']);
            expectError(fn() => $app['auth']->login(credentials(), 'peer'), $override === ['bootstrap_password_hash' => ''] ? 'not_configured' : 'production_setup_required');
            expectError(fn() => $app['auth']->enrollStart(['challengeToken' => str_repeat('a', 64), 'username' => 'v.utra@yandex.ru', 'password' => TEST_PASSWORD], 'peer'), 'challenge_expired');
        }
        $dev = fixture(['allow_http_dev' => true, 'public_origin' => 'http://127.0.0.1:8080']); check($dev['auth']->status()['enrollmentAvailable']);
        $remote = fixture(['allow_http_dev' => true, 'public_origin' => 'http://evil.example']); check(!$remote['auth']->status()['enrollmentAvailable']);
        try { new CafeAuth($dev['directory'], $dev['config'] + ['document_root' => $dev['directory']]); throw new RuntimeException('Expected outside-webroot guard'); }
        catch (RuntimeException $error) { check(str_contains($error->getMessage(), 'outside the web root')); }
    });
    runTest('password-protected enrollment encrypts pending secret and persists account only after real TOTP', function () {
        $app = fixture(); $auth = $app['auth'];
        check($auth->status()['enrollmentAvailable'] && !$auth->status()['ready']);
        expectError(fn() => $auth->login(credentials('wrong-password'), 'peer'), 'invalid_credentials');
        $pending = $auth->login(credentials(), 'peer'); check($pending['enrollmentRequired'] && !isset($pending['token']));
        check($auth->session($pending['challengeToken']) === null);
        $started = $auth->enrollStart(['challengeToken' => $pending['challengeToken'], 'username' => 'v.utra@yandex.ru'], 'peer');
        $disk = file_get_contents($app['directory'] . '/auth-state.json');
        check(state($app)['account'] === null && !str_contains($disk, $started['secret']) && !str_contains($disk, $started['enrollmentToken']) && !str_contains($disk, TEST_PASSWORD));
        expectError(fn() => $auth->enrollConfirm(['enrollmentToken' => $started['enrollmentToken'], 'code' => 'wrong'], 'peer'), 'invalid_code');
        check(state($app)['account'] === null);
        $done = $auth->enrollConfirm(['enrollmentToken' => $started['enrollmentToken'], 'code' => CafeAuth::totp($started['secret'], TEST_NOW)], 'peer');
        check($done['authenticated'] && count($done['recoveryCodes']) === 10 && $auth->session($done['token']) !== null);
        check($auth->cookieOptions()['secure'] && $auth->cookieOptions()['httponly'] && $auth->cookieOptions()['samesite'] === 'Strict');
        expectError(fn() => $auth->enrollConfirm(['enrollmentToken' => $started['enrollmentToken'], 'code' => CafeAuth::totp($started['secret'], TEST_NOW)], 'peer'), 'challenge_expired');
        $disk = file_get_contents($app['directory'] . '/auth-state.json'); $audit = file_get_contents($app['directory'] . '/security-audit.jsonl');
        foreach ([TEST_PASSWORD, $started['secret'], $started['otpauthUri'], $started['enrollmentToken'], $done['token'], ...$done['recoveryCodes']] as $secret) check(!str_contains($disk, $secret) && !str_contains($audit, $secret), 'Secret leaked to persistence or audit');
        check(!isset($auth->status($done['token'])['recoveryCodes']));
    });
    runTest('weak bootstrap requires replacement; cancellation leaves account unchanged', function () {
        $app = fixture(['bootstrap_password_hash' => password_hash('short-7', PASSWORD_BCRYPT)]); $auth = $app['auth'];
        $pending = $auth->login(credentials('short-7'), 'peer'); check($pending['requiresNewPassword']);
        expectError(fn() => $auth->enrollStart(['challengeToken' => $pending['challengeToken'], 'username' => 'v.utra@yandex.ru'], 'peer'), 'invalid_password');
        $started = $auth->enrollStart(['challengeToken' => $pending['challengeToken'], 'username' => 'v.utra@yandex.ru', 'password' => TEST_PASSWORD], 'peer');
        $auth->enrollCancel(['enrollmentToken' => $started['enrollmentToken']], 'peer');
        expectError(fn() => $auth->enrollConfirm(['enrollmentToken' => $started['enrollmentToken'], 'code' => CafeAuth::totp($started['secret'], TEST_NOW)], 'peer'), 'challenge_expired');
        check(state($app)['account'] === null && state($app)['enrollments'] === []);
    });
    runTest('eight-character password can be retained and still requires TOTP', function () {
        $password = 'eight-8!';
        $app = fixture(['bootstrap_password_hash' => CafeAuth::hashPassword($password)]); $auth = $app['auth'];
        $pending = $auth->login(credentials($password), 'peer');
        check($pending['enrollmentRequired'] && !$pending['requiresNewPassword'] && !isset($pending['token']));
        $started = $auth->enrollStart(['challengeToken' => $pending['challengeToken'], 'username' => 'v.utra@yandex.ru'], 'peer');
        check(state($app)['account'] === null);
        $done = $auth->enrollConfirm(['enrollmentToken' => $started['enrollmentToken'], 'code' => CafeAuth::totp($started['secret'], TEST_NOW)], 'peer');
        check($done['authenticated'] && password_verify($password, state($app)['account']['passwordHash']));
        $pending = $auth->login(credentials($password), 'peer');
        check($pending['mfaRequired'] && !isset($pending['token']));
    });
    runTest('peer binding, expiry and five-code limit persist across PHP instances', function () {
        $app = fixture(); $auth = $app['auth'];
        $pending = $auth->login(credentials(), 'peer');
        expectError(fn() => $auth->enrollStart(['challengeToken' => $pending['challengeToken'], 'username' => 'v.utra@yandex.ru'], 'other'), 'challenge_expired');
        $app['clock']->now += 300001; expectError(fn() => $auth->enrollStart(['challengeToken' => $pending['challengeToken'], 'username' => 'v.utra@yandex.ru'], 'peer'), 'challenge_expired');
        $pending = $auth->login(credentials(), 'peer');
        $started = $auth->enrollStart(['challengeToken' => $pending['challengeToken'], 'username' => 'v.utra@yandex.ru'], 'peer');
        for ($index = 0; $index < 4; $index++) expectError(fn() => (new CafeAuth($app['directory'], $app['config']))->enrollConfirm(['enrollmentToken' => $started['enrollmentToken'], 'code' => 'wrong'], 'peer'), 'invalid_code');
        expectError(fn() => $auth->enrollConfirm(['enrollmentToken' => $started['enrollmentToken'], 'code' => 'wrong'], 'peer'), 'challenge_expired');
        check(state($app)['account'] === null);
    });
    runTest('concurrent PHP enrollment confirmations create exactly one session', function () {
        $app = fixture(); $pending = $app['auth']->login(credentials(), 'peer');
        $started = $app['auth']->enrollStart(['challengeToken' => $pending['challengeToken'], 'username' => 'v.utra@yandex.ru'], 'peer');
        $job = ['method' => 'enrollConfirm', 'body' => ['enrollmentToken' => $started['enrollmentToken'], 'code' => CafeAuth::totp($started['secret'], TEST_NOW)]];
        $statuses = array_column(parallel($app, [$job, $job]), 'status'); sort($statuses);
        check($statuses === [200, 410] && count(state($app)['sessions']) === 1);
    });
    runTest('concurrent PHP TOTP/recovery reuse succeeds once and stays consumed after restart', function () {
        $app = fixture(); $setup = enroll($app); $auth = $app['auth'];
        $app['clock']->now += 30000;
        $jobs = [];
        for ($index = 0; $index < 2; $index++) { $pending = $auth->login(credentials(), 'peer'); $jobs[] = ['method' => 'verify', 'body' => ['challengeToken' => $pending['challengeToken'], 'code' => CafeAuth::totp($setup['started']['secret'], $app['clock']->now)]]; }
        $statuses = array_column(parallel($app, $jobs), 'status'); sort($statuses); check($statuses === [200, 401]);
        $jobs = [];
        for ($index = 0; $index < 2; $index++) { $pending = $auth->login(credentials(), 'peer'); $jobs[] = ['method' => 'verify', 'body' => ['challengeToken' => $pending['challengeToken'], 'code' => $setup['done']['recoveryCodes'][0]]]; }
        $statuses = array_column(parallel($app, $jobs), 'status'); sort($statuses); check($statuses === [200, 401]);
        $restarted = new CafeAuth($app['directory'], $app['config']); $pending = $restarted->login(credentials(), 'peer');
        expectError(fn() => $restarted->verify(['challengeToken' => $pending['challengeToken'], 'code' => $setup['done']['recoveryCodes'][0]], 'peer'), 'invalid_code');
        check(count(state($app)['account']['recovery']) === 9);
    });
    runTest('parallel password failures obey persistent eight-peer and forty-global limits', function () {
        $app = fixture();
        $jobs = array_fill(0, 12, ['method' => 'login', 'body' => credentials('wrong-password')]);
        $statuses = array_column(parallel($app, $jobs), 'status');
        check(count(array_filter($statuses, fn($status) => $status === 401)) === 8 && count(array_filter($statuses, fn($status) => $status === 429)) === 4);
        $auth = new CafeAuth($app['directory'], $app['config']); expectError(fn() => $auth->login(credentials(), 'peer'), 'rate_limit');
        for ($index = 0; $index < 32; $index++) expectError(fn() => $auth->login(credentials(''), 'other-' . $index), 'invalid_credentials');
        expectError(fn() => $auth->login(credentials(), 'new-peer'), 'rate_limit');
        $app['clock']->now += 900001; check($auth->login(credentials(), 'peer')['enrollmentRequired']);
    });
    runTest('bogus challenges do not consume legitimate OTP budget and cross-kind tokens cannot enroll', function () {
        $app = fixture(); $setup = enroll($app); $auth = $app['auth']; $pending = $auth->login(credentials(), 'peer');
        for ($index = 0; $index < 20; $index++) expectError(fn() => $auth->verify(['challengeToken' => str_repeat('a', 64), 'code' => '000000'], 'peer'), 'challenge_expired');
        expectError(fn() => $auth->enrollStart(['challengeToken' => $pending['challengeToken'], 'username' => 'attacker', 'password' => TEST_PASSWORD], 'peer'), 'challenge_expired');
        check($auth->verify(['challengeToken' => $pending['challengeToken'], 'code' => $setup['done']['recoveryCodes'][0]], 'peer')['authenticated']);
    });
    runTest('idle/absolute expiry, logout and CSRF/Origin checks', function () {
        $app = fixture(['session_ms' => 250, 'idle_ms' => 100]); $setup = enroll($app); $auth = $app['auth']; $token = $setup['done']['token'];
        expectError(fn() => $auth->checkOrigin('https://evil.example'), 'origin');
        expectError(fn() => $auth->checkOrigin('https://cafe.example', 'cross-site'), 'origin');
        expectError(fn() => $auth->requireSession($token, 'wrong', true), 'csrf');
        check($auth->requireSession($token, $setup['done']['csrfToken'], true)['username'] === 'v.utra@yandex.ru');
        $app['clock']->now += 101; check($auth->session($token) === null);
        $login = $auth->login(credentials(), 'peer'); $session = $auth->verify(['challengeToken' => $login['challengeToken'], 'code' => $setup['done']['recoveryCodes'][0]], 'peer');
        for ($index = 0; $index < 3; $index++) { $app['clock']->now += 80; check($auth->activity($session['token'], $session['csrfToken'])['authenticated']); }
        $app['clock']->now += 11; check($auth->session($session['token']) === null);
        $login = $auth->login(credentials(), 'peer'); $session = $auth->verify(['challengeToken' => $login['challengeToken'], 'code' => $setup['done']['recoveryCodes'][1]], 'peer');
        $auth->logout($session['token'], 'peer'); check($auth->session($session['token']) === null);
    });
    runTest('offline migration preserves encrypted TOTP/recovery and invalidates old capabilities', function () {
        $source = fixture(); $sourceSetup = enroll($source); $sourceAccount = state($source)['account'];
        $target = fixture(); $pending = $target['auth']->login(credentials(), 'peer');
        $started = $target['auth']->enrollStart(['challengeToken' => $pending['challengeToken'], 'username' => 'v.utra@yandex.ru'], 'peer');
        $sourceAccount['credentialVersion'] = bin2hex(random_bytes(32));
        $target['auth']->installAccount($sourceAccount);
        expectError(fn() => $target['auth']->enrollConfirm(['enrollmentToken' => $started['enrollmentToken'], 'code' => CafeAuth::totp($started['secret'], TEST_NOW)], 'peer'), 'challenge_expired');
        $target['clock']->now += 30000;
        $login = $target['auth']->login(credentials(), 'peer');
        check($target['auth']->verify(['challengeToken' => $login['challengeToken'], 'code' => CafeAuth::totp($sourceSetup['started']['secret'], $target['clock']->now)], 'peer')['authenticated']);
        check(state($target)['account']['recovery'] === state($source)['account']['recovery']);
    });
    runTest('expired pending secret is removed from disk and corrupted encryption fails closed', function () {
        $app = fixture(); $pending = $app['auth']->login(credentials(), 'peer');
        $app['auth']->enrollStart(['challengeToken' => $pending['challengeToken'], 'username' => 'v.utra@yandex.ru'], 'peer');
        $app['clock']->now += 300001; $app['auth']->status(); check(state($app)['enrollments'] === []);
        $setup = enroll($app); $saved = state($app); $saved['account']['totp']['encrypted']['tag'] = str_repeat('00', 16);
        CafeStorage::locked($app['directory'] . '/auth.lock', fn() => CafeStorage::atomicJson($app['directory'] . '/auth-state.json', $saved));
        check(!$app['auth']->status()['ready'] && !$app['auth']->status()['enrollmentAvailable']);
        expectError(fn() => $app['auth']->login(credentials(), 'peer'), 'production_setup_required');
    });
    runTest('independent employee enrollment preserves owner credentials and session', function () {
        global $passwordHash;
        $app = fixture(); $owner = enroll($app); $auth = $app['auth']; $before = state($app)['account'];
        $extra = ['version' => 1, 'username' => 'ira@example.test', 'passwordHash' => $passwordHash, 'credentialVersion' => bin2hex(random_bytes(32)), 'totp' => null, 'recovery' => [], 'temporaryPassword' => true, 'initialExpiresAt' => TEST_NOW + 604800000];
        $auth->installAdditionalAccount($extra);
        try { $auth->installAdditionalAccount($extra); throw new Exception('Overwrite accepted'); } catch (RuntimeException $error) { check(str_contains($error->getMessage(), 'already exists')); }
        $pending = $auth->login(['username' => 'IRA@example.test', 'password' => TEST_PASSWORD], 'ira');
        check($pending['requiresNewPassword']);
        expectError(fn() => $auth->enrollStart(['challengeToken' => $pending['challengeToken'], 'username' => 'v.utra@yandex.ru', 'password' => TEST_PASSWORD], 'ira'), 'invalid_username');
        expectError(fn() => $auth->enrollStart(['challengeToken' => $pending['challengeToken'], 'username' => 'ira@example.test'], 'ira'), 'invalid_password');
        expectError(fn() => $auth->enrollStart(['challengeToken' => $pending['challengeToken'], 'username' => 'ira@example.test', 'password' => TEST_PASSWORD], 'ira'), 'invalid_password');
        expectError(fn() => $auth->enrollStart(['challengeToken' => $pending['challengeToken'], 'username' => 'ira@example.test', 'password' => 'short-7'], 'ira'), 'invalid_password');
        $newPassword = 'eight-8!';
        $started = $auth->enrollStart(['challengeToken' => $pending['challengeToken'], 'username' => 'ira@example.test', 'password' => $newPassword], 'ira');
        $done = $auth->enrollConfirm(['enrollmentToken' => $started['enrollmentToken'], 'code' => CafeAuth::totp($started['secret'], TEST_NOW)], 'ira');
        check($done['authenticated'] && $done['deviceMaxAge'] === 34560000);
        check($auth->session($done['token'])['username'] === 'ira@example.test');
        check(state($app)['account'] === $before);
        check($auth->session($owner['done']['token']) !== null);
        check(state($app)['accounts']['ira@example.test']['secondary']);
        expectError(fn() => $auth->login(['username' => 'ira@example.test', 'password' => TEST_PASSWORD], 'ira'), 'invalid_credentials');
        $app['clock']->now += 900001;
        check($auth->session($done['token']) === null);
        $auth = new CafeAuth($app['directory'], $app['config']);
        check($auth->status(null, $done['deviceToken'])['trustedUsername'] === 'ira@example.test');
        $challenge = $auth->resume($done['deviceToken'], 'ira');
        expectError(fn() => $auth->verify(['challengeToken' => $challenge['challengeToken'], 'code' => CafeAuth::totp($owner['started']['secret'], $app['clock']->now)], 'ira', $done['deviceToken']), 'invalid_code');
        $unlocked = $auth->verify(['challengeToken' => $challenge['challengeToken'], 'code' => CafeAuth::totp($started['secret'], $app['clock']->now)], 'ira', $done['deviceToken']);
        check($auth->session($unlocked['token'])['username'] === 'ira@example.test');
    });
    runTest('trusted token is hashed, rotates, needs cookie plus OTP and survives beyond 30 days and logout', function () {
        $app = fixture(); $setup = enroll($app); $auth = $app['auth'];
        check(isset($setup['done']['deviceToken']) && $setup['done']['deviceMaxAge'] === 34560000);
        $app['clock']->now += 30000;
        $pending = $auth->login(credentials(), 'peer');
        $done = $auth->verify(['challengeToken' => $pending['challengeToken'], 'code' => CafeAuth::totp($setup['started']['secret'], $app['clock']->now)], 'peer');
        check($done['deviceMaxAge'] === 34560000);
        check(!str_contains(file_get_contents($app['directory'] . '/auth-state.json'), $done['deviceToken']));
        check(!$auth->status(null, $done['deviceToken'])['authenticated']);
        check(!isset($auth->status()['trustedUsername']));
        $app['clock']->now += 900000;
        $auth = new CafeAuth($app['directory'], $app['config']);
        $pending = $auth->resume($done['deviceToken'], 'peer');
        expectError(fn() => $auth->verify(['challengeToken' => $pending['challengeToken'], 'code' => CafeAuth::totp($setup['started']['secret'], $app['clock']->now)], 'peer'), 'device_expired');
        $pending = $auth->resume($done['deviceToken'], 'peer'); $other = $auth->resume($done['deviceToken'], 'peer');
        $unlocked = $auth->verify(['challengeToken' => $pending['challengeToken'], 'code' => CafeAuth::totp($setup['started']['secret'], $app['clock']->now)], 'peer', $done['deviceToken']);
        check($unlocked['deviceToken'] !== $done['deviceToken'] && $unlocked['deviceMaxAge'] === 34560000);
        expectError(fn() => $auth->verify(['challengeToken' => $other['challengeToken'], 'code' => CafeAuth::totp($setup['started']['secret'], $app['clock']->now)], 'peer', $done['deviceToken']), 'device_expired');
        expectError(fn() => $auth->resume($done['deviceToken'], 'peer'), 'device_expired');
        $auth->logout($unlocked['token'], 'peer');
        check($auth->session($unlocked['token']) === null);
        $app['clock']->now += 2592000001;
        $auth = new CafeAuth($app['directory'], $app['config']);
        $pending = $auth->resume($unlocked['deviceToken'], 'peer');
        $again = $auth->verify(['challengeToken' => $pending['challengeToken'], 'code' => CafeAuth::totp($setup['started']['secret'], $app['clock']->now)], 'peer', $unlocked['deviceToken']);
        check($again['authenticated'] && $again['deviceMaxAge'] === 34560000);
        $record = state($app)['devices'][hash('sha256', $again['deviceToken'])];
        check($record['persistent'] === true && !isset($record['expiresAt']));
    });
    runTest('device recovery bypass, forgotten token, five wrong codes and changed credentials are rejected', function () {
        $app = fixture(); $setup = enroll($app); $auth = $app['auth']; $app['clock']->now += 30000;
        $pending = $auth->login(credentials(), 'peer');
        $done = $auth->verify(['challengeToken' => $pending['challengeToken'], 'code' => CafeAuth::totp($setup['started']['secret'], $app['clock']->now)], 'peer');
        $resumed = $auth->resume($done['deviceToken'], 'peer');
        expectError(fn() => $auth->verify(['challengeToken' => $resumed['challengeToken'], 'code' => $setup['done']['recoveryCodes'][0]], 'peer', $done['deviceToken']), 'invalid_code');
        $pending = $auth->login(credentials(), 'peer');
        $recovery = $auth->verify(['challengeToken' => $pending['challengeToken'], 'code' => $setup['done']['recoveryCodes'][0]], 'peer');
        check(!isset($recovery['deviceToken']));
        for ($i = 0; $i < 4; $i++) expectError(fn() => $auth->verify(['challengeToken' => $resumed['challengeToken'], 'code' => 'bad'], 'peer', $done['deviceToken']), $i === 3 ? 'challenge_expired' : 'invalid_code');
        $pending = $auth->login(credentials(), 'peer');
        $recovery = $auth->verify(['challengeToken' => $pending['challengeToken'], 'code' => $setup['done']['recoveryCodes'][1]], 'peer', $done['deviceToken']);
        check(!isset($recovery['deviceToken']));
        expectError(fn() => $auth->resume($done['deviceToken'], 'peer'), 'device_expired');
        $auth->forgetDevice($done['deviceToken']); expectError(fn() => $auth->resume($done['deviceToken'], 'peer'), 'device_expired');
        $app['clock']->now += 30000;
        $pending = $auth->login(credentials(), 'peer');
        $again = $auth->verify(['challengeToken' => $pending['challengeToken'], 'code' => CafeAuth::totp($setup['started']['secret'], $app['clock']->now)], 'peer');
        $changed = state($app)['account']; $changed['credentialVersion'] = bin2hex(random_bytes(32)); $auth->installAccount($changed);
        expectError(fn() => $auth->resume($again['deviceToken'], 'peer'), 'device_expired');
    });
    runTest('expired employee initial password is rejected without affecting owner', function () {
        global $passwordHash;
        $app = fixture(); enroll($app);
        $app['auth']->installAdditionalAccount(['version' => 1, 'username' => 'expired@example.test', 'passwordHash' => $passwordHash, 'credentialVersion' => bin2hex(random_bytes(32)), 'totp' => null, 'recovery' => [], 'temporaryPassword' => true, 'initialExpiresAt' => TEST_NOW]);
        expectError(fn() => $app['auth']->login(['username' => 'expired@example.test', 'password' => TEST_PASSWORD], 'peer'), 'invalid_credentials');
        check($app['auth']->login(credentials(), 'peer')['mfaRequired']);
    });
    runTest('15-minute idle lock ignores polling; CSRF-protected activity extends it without extending eight-hour cap', function () {
        $app = fixture(); $setup = enroll($app); $auth = $app['auth']; $done = $setup['done'];
        check($done['session'] === ['idleTimeoutMs' => 900000, 'idleExpiresAt' => TEST_NOW + 900000, 'expiresAt' => TEST_NOW + 28800000, 'serverNow' => TEST_NOW]);
        $app['clock']->now += 899999;
        check($auth->status($done['token'])['authenticated']);
        check($auth->requireSession($done['token']) !== null);
        expectError(fn() => $auth->activity($done['token'], 'bad'), 'csrf');
        $app['clock']->now++;
        check(!$auth->status($done['token'], $done['deviceToken'])['authenticated']);
        check($auth->status(null, $done['deviceToken'])['trustedUsername'] === 'v.utra@yandex.ru');
        expectError(fn() => $auth->activity($done['token'], $done['csrfToken']), 'unauthorized');
        $pending = $auth->resume($done['deviceToken'], 'peer');
        $done = $auth->verify(['challengeToken' => $pending['challengeToken'], 'code' => CafeAuth::totp($setup['started']['secret'], $app['clock']->now)], 'peer', $done['deviceToken']);
        $absolute = $done['session']['expiresAt'];
        for ($i = 0; $i < 35; $i++) {
            $app['clock']->now += 800000;
            $activity = $auth->activity($done['token'], $done['csrfToken']);
            check($activity['authenticated'] && $activity['session']['expiresAt'] === $absolute);
            check($activity['session']['idleExpiresAt'] === min($app['clock']->now + 900000, $absolute));
        }
        $app['clock']->now = $absolute;
        expectError(fn() => $auth->activity($done['token'], $done['csrfToken']), 'unauthorized');
        check($auth->status(null, $done['deviceToken'])['trustedUsername'] === 'v.utra@yandex.ru');
    });
    runTest('legacy device upgrades only after valid OTP; expired old device never becomes persistent', function () {
        $app = fixture(); $setup = enroll($app); $auth = $app['auth']; $token = $setup['done']['deviceToken'];
        $saved = state($app); $key = hash('sha256', $token);
        unset($saved['devices'][$key]['persistent']); $saved['devices'][$key]['expiresAt'] = TEST_NOW + 2592000000;
        $expired = bin2hex(random_bytes(32));
        $saved['devices'][hash('sha256', $expired)] = array_replace($saved['devices'][$key], ['expiresAt' => TEST_NOW - 1]);
        CafeStorage::atomicJson($app['directory'] . '/auth-state.json', $saved);
        expectError(fn() => $auth->resume($expired, 'peer'), 'device_expired');
        check($auth->status(null, $token)['trustedUsername'] === 'v.utra@yandex.ru');
        check(!isset(state($app)['devices'][$key]['persistent']));
        $app['clock']->now += 30000;
        $pending = $auth->resume($token, 'peer');
        expectError(fn() => $auth->verify(['challengeToken' => $pending['challengeToken'], 'code' => 'bad'], 'peer', $token), 'invalid_code');
        check(!isset(state($app)['devices'][$key]['persistent']));
        $done = $auth->verify(['challengeToken' => $pending['challengeToken'], 'code' => CafeAuth::totp($setup['started']['secret'], $app['clock']->now)], 'peer', $token);
        check(state($app)['devices'][hash('sha256', $done['deviceToken'])]['persistent'] === true);
    });
    runTest('mutations reauthorize after body receipt and cannot commit after idle expiry or logout', function () {
        $app = fixture(); $setup = enroll($app); $auth = $app['auth']; $done = $setup['done'];
        $committed = false;
        $operation = function () use (&$committed) { $committed = true; return 'saved'; };
        check($auth->authorizedOperation($done['token'], $done['csrfToken'], $operation) === 'saved');
        $committed = false;
        expectError(fn() => $auth->authorizedOperation($done['token'], 'bad', $operation), 'csrf');
        check(!$committed);
        $app['clock']->now += 900000;
        expectError(fn() => $auth->authorizedOperation($done['token'], $done['csrfToken'], $operation), 'unauthorized');
        check(!$committed);
        $pending = $auth->resume($done['deviceToken'], 'peer');
        $done = $auth->verify(['challengeToken' => $pending['challengeToken'], 'code' => CafeAuth::totp($setup['started']['secret'], $app['clock']->now)], 'peer', $done['deviceToken']);
        $auth->logout($done['token'], 'peer');
        expectError(fn() => $auth->authorizedOperation($done['token'], $done['csrfToken'], $operation), 'unauthorized');
        check(!$committed);
    });
    runTest('password mode keeps existing accounts, ignores old devices and rejects every MFA entry point', function () {
        $app=fixture();$setup=enroll($app);$before=state($app)['account'];
        $auth=new CafeAuth($app['directory'],array_replace($app['config'],['auth_mode'=>'password']));
        $status=$auth->status(null,$setup['done']['deviceToken']);
        check($status['authMode']==='password' && $status['mfaRequired']===false && $status['ready'] && !isset($status['trustedUsername']));
        expectError(fn()=>$auth->login(credentials('wrong-password'),'peer'),'invalid_credentials');
        $session=$auth->login(credentials(),'peer');check($session['authenticated'] && $session['authMode']==='password' && !isset($session['challengeToken'],$session['deviceToken']));
        check(state($app)['account']===$before,'Existing credentials changed');
        expectError(fn()=>$auth->resume($setup['done']['deviceToken'],'peer'),'auth_method_disabled');
        expectError(fn()=>$auth->verify(['challengeToken'=>$setup['pending']['challengeToken'],'code'=>'123456'],'peer'),'auth_method_disabled');
        expectError(fn()=>$auth->enrollStart([],'peer'),'auth_method_disabled');
        expectError(fn()=>$auth->enrollConfirm([],'peer'),'auth_method_disabled');
        check($auth->requireSession($session['token'],$session['csrfToken'],true)['username']==='v.utra@yandex.ru');
        expectError(fn()=>$auth->requireSession($session['token'],'bad',true),'csrf');
        $auth->logout($session['token'],'peer');check(!$auth->status($session['token'],$setup['done']['deviceToken'])['authenticated']);
    });
    runTest('password mode persists verified bootstrap and still enforces rate limits and idle expiry', function () {
        $app=fixture(['auth_mode'=>'password']);$auth=$app['auth'];
        check($auth->status()['ready'] && !$auth->status()['enrollmentAvailable']);
        for($i=0;$i<8;$i++)expectError(fn()=>$auth->login(credentials('wrong-password'),'blocked-peer'),'invalid_credentials');
        expectError(fn()=>$auth->login(credentials(),'blocked-peer'),'rate_limit');
        $session=$auth->login(credentials(),'other-peer');check(state($app)['account']['username']==='v.utra@yandex.ru');
        $app['clock']->now+=900000;check($auth->session($session['token'])===null);
        $next=$auth->login(credentials(),'other-peer');check($next['authenticated'] && $next['token']!==$session['token']);
    });
    runTest('temporary password must be replaced without QR before opening any session', function () {
        global $passwordHash;$app=fixture(['auth_mode'=>'password']);$auth=$app['auth'];
        $auth->installAccount(['version'=>1,'username'=>'v.utra@yandex.ru','passwordHash'=>$passwordHash,'credentialVersion'=>str_repeat('27',32),'totp'=>null,'recovery'=>[], 'temporaryPassword'=>true,'initialExpiresAt'=>TEST_NOW+600000]);
        $pending=$auth->login(credentials(),'peer');check($pending['passwordChangeRequired'] && !isset($pending['token']) && state($app)['sessions']===[]);
        expectError(fn()=>$auth->completePasswordReset(['passwordToken'=>$pending['passwordToken'],'password'=>TEST_PASSWORD],'peer'),'invalid_password');
        $auth->completePasswordReset(['passwordToken'=>$pending['passwordToken'],'password'=>'new-password-for-fixture'],'peer');
        expectError(fn()=>$auth->login(credentials(),'peer'),'invalid_credentials');
        check($auth->login(credentials('new-password-for-fixture'),'peer')['authenticated']);
        check(!isset(state($app)['account']['temporaryPassword']));
        expectError(fn()=>$auth->completePasswordReset(['passwordToken'=>$pending['passwordToken'],'password'=>'another-password'],'peer'),'invalid_reset');
    });
    echo "{$passed} PHP authentication tests passed.\n";
} finally {
    foreach ($directories as $directory) removeFixture($directory);
}
