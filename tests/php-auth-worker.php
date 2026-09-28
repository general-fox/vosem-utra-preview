<?php
declare(strict_types=1);
require_once __DIR__ . '/../hosting/php/auth.php';
$job = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
$config = $job['config'];
$config['clock'] = static fn(): int => $job['now'];
$auth = new CafeAuth($job['directory'], $config);
try {
    $method = $job['method'];
    if (!in_array($method, ['login', 'verify', 'enrollConfirm'], true)) throw new RuntimeException('Invalid test operation.');
    $value = $auth->$method($job['body'], $job['peer']);
    echo json_encode(['status' => isset($value['authenticated']) ? 200 : 202, 'authenticated' => $value['authenticated'] ?? false], JSON_THROW_ON_ERROR);
} catch (CafeAuthException $error) {
    echo json_encode(['status' => $error->status, 'code' => $error->errorCode], JSON_THROW_ON_ERROR);
}
