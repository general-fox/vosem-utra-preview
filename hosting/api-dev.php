<?php
declare(strict_types=1);
ini_set('display_errors', '0');
$secret = getenv('CAFE_DEV_BRIDGE');
$supplied = $_SERVER['HTTP_X_CAFE_DEV_BRIDGE'] ?? '';
if (!is_string($secret) || strlen($secret) !== 64 || !hash_equals($secret, $supplied)
    || !in_array($_SERVER['REMOTE_ADDR'] ?? '', ['127.0.0.1','::1'], true)) { http_response_code(404); exit; }
if (($_SERVER['REQUEST_URI'] ?? '') === '/__health') {
    http_response_code(extension_loaded('openssl') && extension_loaded('gd') && in_array('sqlite', PDO::getAvailableDrivers(), true) ? 204 : 503); exit;
}
require_once __DIR__.'/php/site.php';
try {
    $origin = $_SERVER['HTTP_X_CAFE_DEV_ORIGIN'] ?? '';
    if (!preg_match('~^http://(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$~D', $origin)) throw new RuntimeException('Invalid development origin');
    $root = getenv('CAFE_DEV_PROJECT');
    if (!is_string($root) || !is_dir($root)) throw new RuntimeException('Invalid project');
    $privateDir = $root.'/.data/php-runtime';
    if (!is_file($privateDir.'/admin-config.php')) throw new RuntimeException('Run local:prepare first');
    // Only the secret-authenticated bridge may choose this local browser origin.
    $_SERVER['HTTP_HOST'] = substr($origin, 7);
    $config = cafe_site_config($privateDir);
    header('X-Cafe-Runtime: php');
    header('X-Robots-Tag: noindex, nofollow');
    cafe_security_headers(false);
    $menu = new CafeMenu($privateDir, $config);
    $path = explode('?', $_SERVER['REQUEST_URI'] ?? '/')[0];
    if (preg_match('~^/api/(?:ordering|orders(?:/.*)?)$~D', $path)) {
        // Local test orders remain opt-in and isolated from any transferred real DB.
        $orders = new CafeOrders($privateDir, $config, static fn(): array => $menu->catalog(), CafeOrders::developmentConfig());
        if ($orders->dispatch($path, $_SERVER['REQUEST_METHOD'] ?? 'GET')) exit;
    }
    if (!$menu->dispatch($path, $_SERVER['REQUEST_METHOD'] ?? 'GET')) cafe_json_response(['error'=>'Страница не найдена.','code'=>'not_found'], 404);
} catch (Throwable) {
    cafe_json_response(['error'=>'Локальный PHP-сервер требует настройки. Выполните npm run local:prepare.','code'=>'php_unavailable'], 503);
}
