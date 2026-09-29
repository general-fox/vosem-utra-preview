<?php
declare(strict_types=1);

ini_set('display_errors', '0');
$secret = getenv('CAFE_DEV_BRIDGE');
$supplied = $_SERVER['HTTP_X_CAFE_DEV_BRIDGE'] ?? '';
if (!is_string($secret) || strlen($secret) !== 64 || !hash_equals($secret, $supplied)
    || !in_array($_SERVER['REMOTE_ADDR'] ?? '', ['127.0.0.1','::1'], true)) {
    http_response_code(404); exit;
}
if (($_SERVER['REQUEST_URI'] ?? '') === '/__health') {
    http_response_code(in_array('sqlite', PDO::getAvailableDrivers(), true) ? 204 : 503); exit;
}
require_once __DIR__.'/php/menu.php';
require_once __DIR__.'/php/orders.php';
try {
    $origin = $_SERVER['HTTP_X_CAFE_DEV_ORIGIN'] ?? '';
    if (!preg_match('~^http://(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$~D', $origin)) throw new RuntimeException('Invalid development origin');
    $root = getenv('CAFE_DEV_PROJECT');
    if (!is_string($root) || !is_dir($root)) throw new RuntimeException('Invalid project');
    // Only the authenticated local bridge can supply this original browser host.
    $_SERVER['HTTP_HOST'] = substr($origin, 7);
    $catalog = static function () use ($root): array {
        $savedPath = $root.'/.data/menu.json';
        $saved = CafeStorage::readJson(is_file($savedPath) ? $savedPath : $root.'/public/data/menu.json');
        $revision = $saved['revision'] ?? 1;
        if (!is_int($revision) || $revision < 1) throw new RuntimeException('Invalid menu revision');
        $items = array_values(array_filter(cafe_validate_items($saved['items'] ?? null), static fn(array $item): bool => $item['published']));
        usort($items, static fn(array $a, array $b): int => $a['order'] <=> $b['order']);
        return ['items'=>$items, 'revision'=>$revision];
    };
    $orders = new CafeOrders($root.'/.data/orders-development', ['public_origin'=>$origin, 'production'=>false, 'allow_http_dev'=>true], $catalog, CafeOrders::developmentConfig());
    $path = explode('?', $_SERVER['REQUEST_URI'] ?? '/')[0];
    if (!$orders->dispatch($path, $_SERVER['REQUEST_METHOD'] ?? 'GET')) cafe_json_response(['error'=>'Страница не найдена.','code'=>'not_found'], 404);
} catch (Throwable) {
    cafe_json_response(['error'=>'Тестовое оформление временно недоступно.','code'=>'ordering_unavailable'], 503);
}
