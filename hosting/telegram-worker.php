<?php
declare(strict_types=1);

// Install outside the public directory. Cron may overlap; SQLite leases arbitrate jobs.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
$options = getopt('', ['private-dir:', 'limit:']);
$directory = $options['private-dir'] ?? '';
if (!is_string($directory) || !is_dir($directory)) { fwrite(STDERR,"Usage: php telegram-worker.php --private-dir=/absolute/vosem-utra-private [--limit=20]\n"); exit(1); }
$directory = realpath($directory);
$library = is_file(__DIR__.'/php/telegram.php') ? __DIR__.'/php' : $directory.'/app';
require_once $library.'/telegram.php';
require_once $library.'/orders.php';
if (is_file($library.'/staff-orders.php')) require_once $library.'/staff-orders.php';
try {
    $privateConfig = is_file($directory.'/admin-config.php') ? require $directory.'/admin-config.php' : [];
    $site = ['public_origin'=>$privateConfig['publicOrigin'] ?? $privateConfig['public_origin'] ?? 'https://vosem-utra.ru'];
    if (in_array($privateConfig['orders_environment'] ?? null,['staging','production'],true)) $site['orders_environment']=$privateConfig['orders_environment'];
    $orders = new CafeOrders($directory,$site,static fn(): array => ['revision'=>0,'items'=>[]]);
    $site['telegram_environment']=$orders->environment();
    $staff = class_exists('CafeStaffOrders') ? new CafeStaffOrders($orders) : null;
    $telegram = new CafeTelegram($directory,$site,$orders->connection(),null,null,$staff ? [$staff,'snapshotForNotification'] : null);
    $result = $telegram->work(isset($options['limit']) ? (int)$options['limit'] : 20);
    echo json_encode($result,JSON_THROW_ON_ERROR)."\n";
} catch (Throwable) { fwrite(STDERR,"Telegram worker failed. Check private configuration, PHP extensions and storage permissions. No order was removed.\n"); exit(1); }
