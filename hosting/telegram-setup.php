<?php
declare(strict_types=1);

// Operator-only utility. Without --apply prints a safe plan and makes no network call.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
$options = getopt('', ['private-dir:', 'apply', 'plan']);
$directory = $options['private-dir'] ?? '';
if (!is_string($directory) || !is_dir($directory) || isset($options['apply'],$options['plan'])) { fwrite(STDERR,"Usage: php telegram-setup.php --private-dir=/absolute/vosem-utra-private [--plan OR --apply]\n"); exit(1); }
$directory = realpath($directory);
$library = is_file(__DIR__.'/php/telegram.php') ? __DIR__.'/php' : $directory.'/app';
require_once $library.'/telegram.php';
require_once $library.'/orders.php';
try {
    $privateConfig = is_file($directory.'/admin-config.php') ? require $directory.'/admin-config.php' : [];
    $site = ['public_origin'=>$privateConfig['publicOrigin'] ?? $privateConfig['public_origin'] ?? 'https://vosem-utra.ru'];
    $orderConfig=is_file($directory.'/orders-config.php') ? require $directory.'/orders-config.php' : [];
    $site['telegram_environment']=in_array($privateConfig['orders_environment'] ?? null,['staging','production'],true) ? $privateConfig['orders_environment'] : (($orderConfig['mode'] ?? 'production') === 'production' ? 'production' : 'staging');
    // Setup needs no orders or guest data, and must not create the orders database.
    $telegram = new CafeTelegram($directory,$site,new PDO('sqlite::memory:'));
    $result = $telegram->setup(array_key_exists('apply',$options));
    echo json_encode($result,JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR)."\n";
    echo "Configure the Main Mini App in BotFather as well. Staff must be explicitly allowlisted by numeric ID and send /start once.\n";
} catch (Throwable) { fwrite(STDERR,"Telegram setup failed. Check private configuration and HTTPS settings. No token or response body is printed.\n"); exit(1); }
