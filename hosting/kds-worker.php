<?php
declare(strict_types=1);
// Place beside kds-config.json, outside the public website directory.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
ini_set('display_errors', '0');
$options = getopt('', ['private-dir:', 'limit:']);
$directory = $options['private-dir'] ?? __DIR__;
if (!is_string($directory) || !is_dir($directory)) { fwrite(STDERR,"Usage: php kds-worker.php --private-dir=/absolute/vosem-utra-private\n"); exit(1); }
$directory = realpath($directory);
$library = is_file(__DIR__.'/php/site.php') ? __DIR__.'/php' : $directory.'/app';
require_once $library.'/site.php';
try {
    putenv('CAFE_ENV=');
    $site = cafe_site_config($directory);
    $config = CafeKdsDelivery::loadConfig($directory,$site);
    if ($config === null) { echo "KDS disabled.\n"; exit; }
    $menu = new CafeMenu($directory,$site + ['orderable_ids'=>array_keys($config['menuMap']),'kds_test_items'=>$config['testItems'] ?? []]);
    $orders = new CafeOrders($directory,$site,static fn(): array => $menu->catalog());
    $delivery = new CafeKdsDelivery($directory,$orders,$config);
    $lock = fopen($directory.'/orders-data/kds-worker.lock','c');
    if (!$lock) throw new RuntimeException('Worker lock unavailable');
    if (!flock($lock,LOCK_EX|LOCK_NB)) { fclose($lock); echo "KDS worker already running.\n"; exit; }
    try { $states = $delivery->work(isset($options['limit']) ? (int)$options['limit'] : 5); }
    finally { flock($lock,LOCK_UN); fclose($lock); }
    echo json_encode(['checked'=>count($states),'states'=>array_count_values($states)],JSON_THROW_ON_ERROR)."\n";
} catch (Throwable) { fwrite(STDERR,"KDS worker failed. Check private configuration, PHP cURL/SQLite and file permissions. No order was deleted.\n"); exit(1); }
