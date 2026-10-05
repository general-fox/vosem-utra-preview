<?php
declare(strict_types=1);
require_once __DIR__.'/../hosting/php/menu.php';

function availabilityCheck(bool $value, string $message): void { if (!$value) throw new RuntimeException($message); }
function availabilityError(callable $fn, string $code): void {
    try { $fn(); } catch (CafeMenuException $error) { availabilityCheck($error->errorCode === $code, 'Unexpected error '.$error->errorCode); return; }
    throw new RuntimeException('Expected '.$code);
}
$root = dirname(__DIR__).'/.php-preview/availability-'.bin2hex(random_bytes(6));
mkdir($root.'/app/seed', 0700, true);
$org = '49184a17-69b6-4be6-af7e-b7fa86d0e080';
$config = ['enabled'=>true, 'baseUrl'=>'https://kds.example/api/v1', 'organizationId'=>$org, 'serviceName'=>'fixture', 'servicePassword'=>'fictional-secret', 'menuMap'=>['mapped'=>'102']];
$calls = []; $time = 1800000000; $failure = false;
$rests = ['forbidden'=>[['externalId'=>'101','prohibited'=>true]], 'limited'=>[['externalId'=>'102','quantity'=>2500,'prohibited'=>false], ['externalId'=>'103','quantity'=>0], ['externalId'=>'104','quantity'=>500]]];
$transport = static function (string $url, string $method) use (&$calls, &$rests, &$failure): array {
    $calls[] = [$url, $method];
    if (str_ends_with($url, '/clients/service-token')) return ['status'=>200, 'body'=>'{"accessToken":"fixture-token"}'];
    availabilityCheck(str_contains($url, '/external/get-dish-rests?'), 'Only dish rests may be requested');
    if ($failure) throw new RuntimeException('fictional-secret upstream error');
    return ['status'=>200, 'body'=>json_encode($rests, JSON_THROW_ON_ERROR)];
};
$clock = static function () use (&$time): int { return $time; };
$dish = static fn(string $id, ?string $external = null, bool $available = true): array => ['id'=>$id,'name'=>'Блюдо '.$id,'description'=>'Текст','price'=>100,'category'=>'breakfast','image'=>'','order'=>0,'published'=>true,'availableForOrder'=>$available]
    + ($external === null ? [] : ['source'=>['provider'=>'kds','organizationId'=>$org,'externalId'=>$external]]);
$catalog = ['revision'=>7, 'categories'=>cafe_default_categories(), 'sourceCategories'=>[], 'categoryMappings'=>[], 'items'=>[
    $dish('stopped','101'), $dish('mapped'), $dish('empty','103'), $dish('fraction','104'), $dish('manual-off','105',false), $dish('legacy'),
    array_replace($dish('other','101'), ['source'=>['provider'=>'kds','organizationId'=>'00000000-0000-4000-8000-000000000001','externalId'=>'101']]),
]];
$passed = [];
try {
    $missing = new CafeMenuAvailability($root, [], $transport, $clock);
    availabilityCheck($missing->decorate($catalog)['keeperSync']['configured'] === false, 'Missing config reported');
    availabilityError(fn() => $missing->sync(), 'keeper_not_configured');
    availabilityCheck($calls === [], 'Missing config makes no request');
    $passed[] = 'missing connection is explicit and causes no upstream requests';

    CafeStorage::atomicJson($root.'/kds-config.json', $config);
    $sync = new CafeMenuAvailability($root, [], $transport, $clock);
    availabilityCheck($sync->decorate($catalog)['keeperSync']['updatedAt'] === null && $calls === [], 'GET never syncs');
    $sync->sync();
    $admin = $sync->decorate($catalog); $public = $sync->decorate($catalog, true);
    availabilityCheck(count($calls) === 2 && $calls[0][1] === 'POST' && $calls[1][1] === 'GET', 'Only auth and rest read');
    availabilityCheck($admin['keeperSync']['matched'] === 5 && $admin['keeperSync']['forbidden'] === 1 && $admin['keeperSync']['limited'] === 3, 'Local summary counts');
    availabilityCheck($admin['items'][0]['availableForOrder'] && !$public['items'][0]['availableForOrder'], 'Editorial flag preserved, forbidden blocked');
    availabilityCheck($admin['items'][1]['keeperAvailability']['remaining'] === 2.5 && $public['items'][1]['availableForOrder'], 'Thousandths converted to portions');
    availabilityCheck(!$public['items'][2]['availableForOrder'] && !$public['items'][3]['availableForOrder'], 'Zero and less than a portion blocked');
    availabilityCheck(!$public['items'][4]['availableForOrder'], 'Manual disabled flag never reversed');
    availabilityCheck(!isset($admin['items'][5]['keeperAvailability'], $admin['items'][6]['keeperAvailability']) && $public['items'][6]['availableForOrder'], 'Unmapped and foreign organization unaffected');
    availabilityCheck($admin['revision'] === 7 && !isset($public['keeperSync']), 'Read-only metadata never changes menu revision');
    $passed[] = 'stop-list, portions, organization matching and manual availability are independent';

    $cache = $root.'/kds-data/menu-availability.json'; $bytes = file_get_contents($cache);
    availabilityCheck(!str_contains($bytes, 'fictional-secret') && !str_contains($bytes, 'fixture-token'), 'No credentials in cache');
    availabilityError(fn() => $sync->sync(), 'keeper_sync_recent');
    availabilityCheck(count($calls) === 2, 'Rate protection avoids duplicate upstream calls');
    $time += 11; $failure = true;
    availabilityError(fn() => $sync->sync(), 'keeper_sync_failed');
    availabilityCheck(file_get_contents($cache) === $bytes && $sync->decorate($catalog)['keeperSync']['updatedAt'] === $admin['keeperSync']['updatedAt'], 'Failure preserves exact successful snapshot');
    $failure = false; $rests['limited'][0]['quantity'] = 'invalid';
    availabilityError(fn() => $sync->sync(), 'keeper_sync_failed');
    availabilityCheck(file_get_contents($cache) === $bytes, 'Malformed response cannot partially clear restrictions');
    $passed[] = 'duplicate clicks, connection errors and invalid responses retain the successful snapshot';

    $lock = fopen($root.'/kds-data/menu-availability.lock', 'c+'); flock($lock, LOCK_EX);
    availabilityError(fn() => $sync->sync(), 'keeper_sync_busy'); flock($lock, LOCK_UN); fclose($lock);
    $rests = ['forbidden'=>[], 'limited'=>[]]; $time += 11; $sync->sync();
    $restored = $sync->decorate($catalog, true);
    availabilityCheck($restored['items'][0]['availableForOrder'] && $restored['items'][2]['availableForOrder'] && !$restored['items'][4]['availableForOrder'], 'Cleared restrictions restore only editorial availability');
    $passed[] = 'concurrent synchronization is refused and lifted stops restore availability';

    $rests = ['forbidden'=>[['externalId'=>'101']], 'limited'=>[['externalId'=>'101','quantity'=>2000], ['externalId'=>'102','quantity'=>3000], ['externalId'=>'102','quantity'=>1000,'prohibited'=>true]]];
    $time += 11; $sync->sync(); $merged = $sync->decorate($catalog);
    availabilityCheck($merged['items'][0]['keeperAvailability']['forbidden'] && $merged['items'][1]['keeperAvailability']['forbidden'] && $merged['items'][1]['keeperAvailability']['remaining'] == 1, 'Most restrictive value wins duplicate/overlapping rows');
    $passed[] = 'overlapping forbidden and limited rows keep the strongest restriction';

    $beforeRevocation = file_get_contents($cache); $time += 11;
    try {
        $sync->sync(static function (callable $save): void { throw new CafeAuthException(401, 'Session revoked', 'unauthorized'); });
        throw new RuntimeException('Revoked session must fail commit');
    } catch (CafeAuthException $error) { availabilityCheck($error->errorCode === 'unauthorized', 'Reauthorization error preserved'); }
    availabilityCheck(file_get_contents($cache) === $beforeRevocation, 'Session revoked during read cannot write snapshot');
    $passed[] = 'authorization is rechecked before persisting a completed network read';

    foreach (['baseUrl'=>'https://different.example/api/v1', 'organizationId'=>'00000000-0000-4000-8000-000000000002', 'enabled'=>false] as $field=>$value) {
        CafeStorage::atomicJson($root.'/kds-config.json', array_replace($config, [$field=>$value]));
        $changed = new CafeMenuAvailability($root, [], $transport, $clock);
        availabilityCheck($changed->decorate($catalog)['keeperSync']['updatedAt'] === null, 'Other connection never reuses old restrictions');
    }
    $passed[] = 'cache belongs to an exact API server and organization';

    CafeStorage::atomicJson($root.'/kds-config.json', $config);
    CafeStorage::atomicJson($root.'/app/seed/menu.json', $catalog);
    $menu = new CafeMenu($root, ['allow_http_dev'=>true]);
    availabilityCheck($menu->read()['items'][0]['availableForOrder'] && !$menu->catalog()['items'][0]['availableForOrder'], 'Real catalog applies snapshot without altering disk');
    $locked = $menu->withLockedSnapshot(static fn(array $snapshot): array => $snapshot);
    availabilityCheck(!$locked['items'][0]['availableForOrder'], 'Checkout locked snapshot observes restrictions');
    $persisted = $menu->update($merged['items'], $menu->read()['revision'], $catalog['categories']);
    availabilityCheck(!isset($persisted['items'][0]['keeperAvailability']), 'Admin cannot persist/forge computed metadata');
    $passed[] = 'public API and checkout apply restrictions while admin saves remain editorial';
    $dual = array_replace($config, ['environment'=>'staging', 'allowHttpForTest'=>true,
        'organizationId'=>'d840d3ea-e6b7-4097-9db3-8acd45259bf2',
        'baseUrl'=>'http://146.158.119.207:8081/api/v1', 'localBaseUrl'=>'http://192.168.2.117:8081/api/v1']);
    CafeStorage::atomicJson($root.'/kds-config.json', $dual);
    foreach ([['allow_http_dev'=>true], ['staging'=>true]] as $environment) {
        $calls = []; $time += 11;
        $site = $environment + ['indexing'=>false];
        $connection = new CafeMenuAvailability($root, $site, $transport, $clock);
        availabilityCheck($connection->decorate($catalog)['keeperSync']['updatedAt'] === null, 'Different endpoint drops cached restrictions');
        $connection->sync();
        $base = isset($site['allow_http_dev']) ? $dual['localBaseUrl'] : $dual['baseUrl'];
        availabilityCheck($calls === [[$base.'/clients/service-token','POST'], [$base.'/external/get-dish-rests?organizationId='.$dual['organizationId'],'GET']], 'Server environment selects exact endpoint');
    }
    $production = new CafeMenuAvailability($root, ['indexing'=>true], $transport, $clock);
    availabilityError(fn() => $production->sync(), 'keeper_not_configured');
    $passed[] = 'local refresh uses LAN, hosting uses public endpoint and production refuses HTTP';
    foreach ($passed as $name) echo 'PASS: '.$name."\n";
    echo count($passed)." menu availability tests passed. No external requests made.\n";
} finally {
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($iterator as $entry) $entry->isDir() ? rmdir($entry->getPathname()) : unlink($entry->getPathname());
    rmdir($root);
}
