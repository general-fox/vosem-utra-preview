<?php
declare(strict_types=1);
require_once __DIR__.'/../hosting/php/orders.php';
$job = json_decode(file_get_contents($argv[1]),true,512,JSON_THROW_ON_ERROR);
$site = $job['site']; $site['orders_clock'] = static fn(): int => $job['now'];
$api = new CafeOrders($job['directory'],$site,static fn(): array => json_decode(file_get_contents($job['directory'].'/menu.json'),true,512,JSON_THROW_ON_ERROR),$job['config']);
try {
    $result = $api->{$job['method']}($job['body'],$job['guest'],$job['csrf'],$job['peer']);
    echo json_encode(['ok'=>true,'result'=>$result],JSON_THROW_ON_ERROR);
} catch (CafeOrderException $error) { echo json_encode(['ok'=>false,'code'=>$error->errorCode,'status'=>$error->status],JSON_THROW_ON_ERROR); }
