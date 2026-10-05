<?php
declare(strict_types=1);
require_once __DIR__.'/../hosting/php/orders.php';

$directories = []; $passed = 0;
function check(bool $condition, string $message = 'Assertion failed'): void { if (!$condition) throw new RuntimeException($message); }
function errorCode(callable $operation, string $code, ?int $status = null): CafeOrderException {
    try { $operation(); } catch (CafeOrderException $error) { check($error->errorCode === $code,'Unexpected order error: '.$error->errorCode.' instead of '.$code); if ($status !== null) check($error->status === $status); return $error; }
    throw new RuntimeException('Expected order error '.$code);
}
function menu(array $app, ?array $value = null): array {
    $path = $app['directory'].'/menu.json';
    if ($value !== null) file_put_contents($path,json_encode($value,JSON_THROW_ON_ERROR));
    return json_decode(file_get_contents($path),true,512,JSON_THROW_ON_ERROR);
}
function fixture(array $overrides = [], array $siteOverrides = []): array {
    global $directories;
    $directory = sys_get_temp_dir().'/cafe-php-orders-'.bin2hex(random_bytes(8)); mkdir($directory,0700,true); $directories[] = $directory;
    $config = array_replace_recursive(CafeOrders::developmentConfig(),['mode'=>'production','termsApproved'=>true],$overrides);
    $clock = (object)['now'=>(new DateTimeImmutable('2026-09-28T09:05:00+03:00'))->getTimestamp()];
    $site = array_replace(['public_origin'=>'https://cafe.example','document_root'=>$directory.'/www'],$siteOverrides);
    mkdir($directory.'/www'); $site['orders_clock'] = static fn(): int => $clock->now;
    $app = compact('directory','config','site','clock');
    menu($app,['revision'=>1,'items'=>[
        ['id'=>'breakfast','name'=>'Тестовый завтрак','price'=>470.25,'published'=>true,'availableForOrder'=>true],
        ['id'=>'dessert','name'=>'Тестовый десерт','price'=>99.99,'published'=>true,'availableForOrder'=>true],
        ['id'=>'hidden','name'=>'Скрытая позиция','price'=>1,'published'=>false,'availableForOrder'=>true],
        ['id'=>'sold-out','name'=>'Недоступная позиция','price'=>1,'published'=>true,'availableForOrder'=>false],
    ]]);
    $app['api'] = new CafeOrders($directory,$site,static fn(): array => json_decode(file_get_contents($directory.'/menu.json'),true,512,JSON_THROW_ON_ERROR),$config);
    $settings = $app['api']->settings(null,'peer');
    $app['settings'] = $settings; $app['guest'] = $settings['_guestToken'] ?? ''; $app['csrf'] = $settings['csrfToken'] ?? '';
    return $app;
}
function draft(array $app, string $type = 'pickup'): array {
    return ['items'=>[['id'=>'breakfast','quantity'=>2],['id'=>'dessert','quantity'=>1]],
        'fulfilment'=>['type'=>$type,'timing'=>'asap','requestedAt'=>null,'address'=>$type === 'pickup' ? null : ['city'=>'Тестовый город','streetHouse'=>'Вымышленная улица, дом 1'],'courierInstructions'=>''],
        'contact'=>['phone'=>'8 (000) 000-00-00','name'=>'Тестовый гость'], 'orderComment'=>'Только тест, не исполнять', 'consent'=>['accepted'=>true,'version'=>$app['config']['consent']['version']]];
}
function quote(array $app, ?array $body = null): array { return $app['api']->quote($body ?? draft($app),$app['guest'],$app['csrf'],'peer')['quote']; }
function request(array $app, ?array $body = null): array { $body ??= draft($app); return $body + ['quoteId'=>quote($app,$body)['quoteId'],'idempotencyKey'=>bin2hex(random_bytes(16))]; }
function create(array $app, array $body): array { return $app['api']->create($body,$app['guest'],$app['csrf'],'peer'); }
function database(array $app): PDO { return new PDO('sqlite:'.$app['directory'].'/orders-data/orders.sqlite',null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]); }
function countRows(PDO $db,string $table): int { return (int)$db->query('SELECT COUNT(*) FROM '.$table)->fetchColumn(); }
function runTest(string $name, callable $operation): void { global $passed; $operation(); $passed++; echo "PASS: {$name}\n"; }
function parallel(array $app,array $jobs): array {
    $running = [];
    foreach ($jobs as $job) {
        $file = $app['directory'].'/worker-'.bin2hex(random_bytes(8)).'.json'; $site = $app['site']; unset($site['orders_clock']);
        file_put_contents($file,json_encode($job + ['directory'=>$app['directory'],'site'=>$site,'config'=>$app['config'],'now'=>$app['clock']->now,'guest'=>$app['guest'],'csrf'=>$app['csrf'],'peer'=>'peer'],JSON_THROW_ON_ERROR));
        $pipes = []; $process = proc_open([PHP_BINARY,__DIR__.'/php-orders-worker.php',$file],[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']],$pipes,null,null,['bypass_shell'=>true]);
        if (!is_resource($process)) throw new RuntimeException('Unable to start PHP worker');
        fclose($pipes[0]); $running[] = [$process,$pipes,$file];
    }
    $results = [];
    foreach ($running as [$process,$pipes,$file]) {
        $out = stream_get_contents($pipes[1]); $err = stream_get_contents($pipes[2]); fclose($pipes[1]); fclose($pipes[2]); $exit = proc_close($process); unlink($file);
        check($exit === 0 && $err === '', 'Worker failed: '.$err); $results[] = json_decode($out,true,512,JSON_THROW_ON_ERROR);
    }
    return $results;
}
function cleanFixture(string $directory): void {
    $real = realpath($directory); $temporary = realpath(sys_get_temp_dir());
    if (!$real || !$temporary || dirname($real) !== $temporary || !str_starts_with(basename($real),'cafe-php-orders-')) throw new RuntimeException('Unsafe test cleanup');
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($real,FilesystemIterator::SKIP_DOTS),RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($iterator as $entry) { if ($entry->isLink()) unlink($entry->getPathname()); elseif ($entry->isDir()) rmdir($entry->getPathname()); else unlink($entry->getPathname()); }
    rmdir($real);
}

try {
    runTest('ordering fails closed without approved complete production terms and HTTPS',function (): void {
        foreach ([['enabled'=>false],['termsApproved'=>false],['delivery'=>['mode'=>null]],['minDelayMinutes'=>['pickup'=>null]],['consent'=>['url'=>'https://outside.example']],['timezone'=>'invalid'],['closedDates'=>['bad-date']]] as $override) {
            $app = fixture($override); check(!$app['settings']['enabled']); check($app['settings']['csrfToken'] === null); check(!is_dir($app['directory'].'/orders-data'));
            errorCode(fn()=>quote($app),'ordering_disabled',503);
        }
        $app = fixture([],['public_origin'=>'http://cafe.example']); check(!$app['settings']['enabled']);
        $app = fixture(['mode'=>'development'],['public_origin'=>'https://cafe.example','allow_http_dev'=>true]); check(!$app['settings']['enabled']);
        $app = fixture(['mode'=>'development','termsApproved'=>false],['public_origin'=>'http://localhost:5173','allow_http_dev'=>true]); check($app['settings']['enabled']); check(str_contains($app['settings']['notice'],'Тестовое'));
    });
    runTest('security boundary enforces exact origin, HTTPS, CSRF and private storage',function (): void {
        $app = fixture(); $api = $app['api'];
        $api->checkRequestSecurity('https://cafe.example','same-origin',true,'peer',true);
        errorCode(fn()=>$api->checkRequestSecurity('https://evil.example','cross-site',true,'peer',true),'origin',403);
        errorCode(fn()=>$api->checkRequestSecurity(null,null,true,'peer',true),'origin',403);
        errorCode(fn()=>$api->checkRequestSecurity('https://cafe.example','same-origin',false,'peer',true),'https_required',400);
        errorCode(fn()=>$api->quote(draft($app),$app['guest'],'wrong','peer'),'csrf',403);
        errorCode(fn()=>$api->quote(draft($app),null,$app['csrf'],'peer'),'csrf',403);
        $other = $api->settings(null,'other'); $body = request($app);
        errorCode(fn()=>$api->create($body,$other['_guestToken'],$other['csrfToken'],'other'),'quote_expired',410);
        $badSite = $app['site']; $badSite['document_root'] = $app['directory'];
        $bad = new CafeOrders($app['directory'],$badSite,fn()=>menu($app),$app['config']);
        try { $bad->settings(); throw new LogicException('Storage exposed'); } catch (RuntimeException $e) { check(!$e instanceof LogicException); }
    });
    runTest('server minor-unit pricing ignores browser money and preserves source menu IDs',function (): void {
        $app = fixture(); $body = draft($app); $body['subtotalMinor'] = 1; $body['items'][0]['unitPriceMinor'] = 1; $body['items'][0]['price'] = 0;
        $result = quote($app,$body); check($result['subtotalMinor'] === 104049); check($result['totalMinor'] === 104049); check($result['deliveryFeeMinor'] === 0); check($result['currency'] === 'RUB');
        check($result['items'][0]['unitPriceMinor'] === 47025 && $result['items'][0]['lineTotalMinor'] === 94050);
        $catalog = menu($app); $id = 'A_'.str_repeat('x',98); $catalog['items'][0]['id'] = $id; menu($app,$catalog); $body['items'][0]['id'] = $id;
        check(quote($app,$body)['items'][0]['id'] === $id);
        $catalog['items'][0]['price'] = 1.111; menu($app,$catalog); errorCode(fn()=>quote($app,$body),'menu_unavailable',503);
    });
    runTest('delivery null total, fixed fees, free threshold and minimum are distinct',function (): void {
        $app = fixture(); $q = quote($app,draft($app,'delivery')); check($q['deliveryFeeMinor'] === null && $q['totalMinor'] === null);
        $app = fixture(['delivery'=>['mode'=>'fixed','feeMinor'=>25000,'freeFromMinor'=>null]]); $q = quote($app,draft($app,'delivery')); check($q['totalMinor'] === 129049 && $q['deliveryFeeMinor'] === 25000);
        $app = fixture(['delivery'=>['mode'=>'fixed','feeMinor'=>25000,'freeFromMinor'=>100000]]); check(quote($app,draft($app,'delivery'))['deliveryFeeMinor'] === 0);
        $app = fixture(['minimumSubtotalMinor'=>['delivery'=>200000]]); errorCode(fn()=>quote($app,draft($app,'delivery')),'minimum_not_met',422); check(quote($app)['deliveryFeeMinor'] === 0);
    });
    runTest('draft validation rejects malformed identity, address, quantities and consent',function (): void {
        $app = fixture(); $cases = [];
        $b = draft($app); unset($b['fulfilment']['type']); $cases[]=$b;
        $b = draft($app); $b['fulfilment']['address']=['city'=>'x']; $cases[]=$b;
        $b = draft($app,'delivery'); $b['fulfilment']['address']['streetHouse']=''; $cases[]=$b;
        $b = draft($app); $b['items'][0]['quantity']=1.5; $cases[]=$b;
        $b = draft($app); $b['items'][0]['quantity']=100; $cases[]=$b;
        $b = draft($app); $b['items'][]=$b['items'][0]; $cases[]=$b;
        $b = draft($app); $b['items'][0]['id']='../path'; $cases[]=$b;
        $b = draft($app); $b['contact']['phone']='+10000000000'; $cases[]=$b;
        $b = draft($app); $b['contact']['name']="bad\0field"; $cases[]=$b;
        $b = draft($app); $b['orderComment']=str_repeat('я',1001); $cases[]=$b;
        foreach ($cases as $b) errorCode(fn()=>quote($app,$b),'invalid_order',422);
        $b = draft($app); $b['consent']['accepted']=false; errorCode(fn()=>quote($app,$b),'consent_required',422);
        $b['consent']=['accepted'=>true,'version'=>'old']; errorCode(fn()=>quote($app,$b),'consent_required',422);
        $b = draft($app); $b['contact']['name']=''; check(quote($app,$b)['totalMinor'] === 104049);
        $body = request($app,$b); create($app,$body); $stored = json_decode(database($app)->query('SELECT original_request FROM orders')->fetchColumn(),true); check($stored['contact']['phone'] === '+70000000000');
    });
    runTest('schedule validates timezone, slots, preparation, holidays and closed-hour preorder',function (): void {
        $week = array_fill(1,7,[['10:00','18:00']]); $app = fixture(['schedule'=>['acceptance'=>$week,'pickup'=>$week,'delivery'=>$week]]);
        check(!$app['settings']['availability']['pickup']['asap']); check(count($app['settings']['availability']['pickup']['slots']) > 0);
        errorCode(fn()=>quote($app),'invalid_time',422);
        $b = draft($app); $b['fulfilment']['timing']='scheduled'; $b['fulfilment']['requestedAt']=$app['settings']['availability']['pickup']['slots'][0]; check(quote($app,$b)['fulfilment']['requestedAt'] === '2026-09-28T10:00:00+03:00');
        foreach ([null,'','2026-09-28T10:00','2026-09-27T12:00:00+03:00','2026-09-28T09:30:00+03:00','2026-09-28T10:01:00+03:00','2026-09-28T18:00:00+03:00','2026-10-06T12:00:00+03:00','2026-09-31T12:00:00+03:00'] as $date) { $b['fulfilment']['requestedAt']=$date; errorCode(fn()=>quote($app,$b),'invalid_time',422); }
        $b['fulfilment']['requestedAt']='2026-09-28T10:00:00+03:00'; $app['clock']->now=(new DateTimeImmutable('2026-09-28T09:40:00+03:00'))->getTimestamp(); errorCode(fn()=>quote($app,$b),'invalid_time',422);
        $app = fixture(['schedule'=>['acceptance'=>$week,'pickup'=>$week,'delivery'=>$week],'allowPreorderOutsideHours'=>false]); check($app['settings']['availability']['pickup']['slots'] === []);
        $app = fixture(['closedDates'=>['2026-09-28']]); check(!$app['settings']['availability']['pickup']['asap']); check(!str_starts_with($app['settings']['availability']['pickup']['slots'][0],'2026-09-28'));
        $b = draft($app); $b['fulfilment']['timing']='scheduled'; $b['fulfilment']['requestedAt']='2026-09-28T12:00:00+03:00'; errorCode(fn()=>quote($app,$b),'invalid_time',422);
    });
    runTest('quote rechecks published and order availability without exposing hidden details',function (): void {
        $app = fixture(); foreach (['hidden','sold-out','missing'] as $id) { $b=draft($app);$b['items'][0]['id']=$id; $e=errorCode(fn()=>quote($app,$b),'item_unavailable',409);check($e->details===['items'=>[['id'=>$id,'available'=>false]]]); }
        $body=request($app); $catalog=menu($app);$catalog['items'][0]['availableForOrder']=false;menu($app,$catalog);errorCode(fn()=>create($app,$body),'item_unavailable',409);check(countRows(database($app),'orders')===0);
    });
    runTest('synced fractional stock limits quantities before quoting and cannot be forged by the browser',function (): void {
        $app=fixture();$catalog=menu($app);$catalog['items'][0]['keeperAvailability']=['remaining'=>2.5,'forbidden'=>false,'stockKey'=>str_repeat('a',64)];menu($app,$catalog);
        $body=draft($app);$body['items'][0]['quantity']=3;$body['items'][0]['keeperAvailability']=['remaining'=>999];
        $error=errorCode(fn()=>quote($app,$body),'item_limited',409);
        check($error->details===['items'=>[['id'=>'breakfast','available'=>true,'maxQuantity'=>2]]]);
        check(countRows(database($app),'quotes')===0&&countRows(database($app),'orders')===0);
        $body['items'][0]['quantity']=2;$created=create($app,request($app,$body));check($created['order']['items'][0]['quantity']===2);
        check(!str_contains(json_encode($created),'stockKey'),'Internal stock identities must not enter order snapshots');
    });
    runTest('cached stock is rechecked at create even when the menu revision stays unchanged',function (): void {
        $app=fixture();$catalog=menu($app);$catalog['items'][0]['keeperAvailability']=['remaining'=>2.5,'forbidden'=>false];menu($app,$catalog);
        $body=request($app);$catalog['items'][0]['keeperAvailability']['remaining']=1;menu($app,$catalog);
        errorCode(fn()=>create($app,$body),'item_limited',409);
        $db=database($app);check(countRows($db,'orders')===0&&$db->query('SELECT order_id FROM quotes')->fetchColumn()===null);
        $smaller=draft($app);$smaller['items'][0]['quantity']=1;$retry=request($app,$smaller);$created=create($app,$retry);
        $catalog['items'][0]['keeperAvailability']['remaining']=0;menu($app,$catalog);
        check(create($app,$retry)['_replayed'],'A completed idempotent retry must not duplicate or invalidate its order');
        check(countRows($db,'orders')===1);
    });
    runTest('website aliases share one stock allowance while separate cash identities remain independent',function (): void {
        $app=fixture();$catalog=menu($app);
        foreach([0,1] as $index)$catalog['items'][$index]['keeperAvailability']=['remaining'=>2.5,'forbidden'=>false,'stockKey'=>str_repeat('b',64)];
        menu($app,$catalog);$error=errorCode(fn()=>quote($app),'item_limited',409);
        check($error->details===['items'=>[['id'=>'breakfast','available'=>true,'maxQuantity'=>2],['id'=>'dessert','available'=>true,'maxQuantity'=>2]]]);
        $body=draft($app);$body['items'][0]['quantity']=1;check(count(quote($app,$body)['items'])===2);
        $catalog['items'][1]['keeperAvailability']['stockKey']=str_repeat('c',64);menu($app,$catalog);check(count(quote($app)['items'])===2);
        foreach([0,1] as $index){unset($catalog['items'][$index]['keeperAvailability']['stockKey']);$catalog['items'][$index]['source']=['provider'=>'kds','organizationId'=>'same-org','externalId'=>'same-dish'];}
        menu($app,$catalog);errorCode(fn()=>quote($app),'item_limited',409);
        $catalog['items'][1]['source']['organizationId']='other-org';menu($app,$catalog);check(count(quote($app)['items'])===2);
    });
    runTest('stale quote requires explicit fresh quote submission, address and timing changes conflict',function (): void {
        $app=fixture();$body=request($app);$catalog=menu($app);$catalog['revision']=2;$catalog['items'][0]['price']=500;menu($app,$catalog);
        $e=errorCode(fn()=>create($app,$body),'quote_changed',409);check($e->details['quote']['subtotalMinor']===109999);check(countRows(database($app),'orders')===0);
        $body['quoteId']=$e->details['quote']['quoteId'];$result=create($app,$body);check($result['order']['subtotalMinor']===109999);
        $body=request($app,draft($app,'delivery'));$body['fulfilment']['address']['streetHouse']='Другая тестовая улица, 2';errorCode(fn()=>create($app,$body),'quote_changed',409);
        $body=request($app);$body['fulfilment']['timing']='scheduled';$body['fulfilment']['requestedAt']=$app['settings']['availability']['pickup']['slots'][0];errorCode(fn()=>create($app,$body),'quote_changed',409);
    });
    runTest('quote expiration and submission-time preparation validation cannot silently fall back',function (): void {
        $app=fixture();$body=request($app);$app['clock']->now+=300;errorCode(fn()=>create($app,$body),'quote_expired',410);check(countRows(database($app),'orders')===0);
        $app=fixture();$b=draft($app);$b['fulfilment']['timing']='scheduled';$b['fulfilment']['requestedAt']='2026-09-28T10:00:00+03:00';$body=request($app,$b);$app['clock']->now+=60;check(create($app,$body)['order']['fulfilment']['requestedAt']==='2026-09-28T10:00:00+03:00');
        $app=fixture();$app['clock']->now=(new DateTimeImmutable('2026-09-28T09:29:00+03:00'))->getTimestamp();$b=draft($app);$b['fulfilment']['timing']='scheduled';$b['fulfilment']['requestedAt']='2026-09-28T10:00:00+03:00';$body=request($app,$b);$app['clock']->now+=61;errorCode(fn()=>create($app,$body),'invalid_time',422);
    });
    runTest('durable immutable order, initial history, pending notification and outbox commit together',function (): void {
        $app=fixture();$body=request($app,draft($app,'delivery'));$result=create($app,$body);$order=$result['order'];check($order['status']==='new');check($order['payment']===['method'=>null,'status'=>'not_configured','paidAmountMinor'=>null]);check($order['totalMinor']===null);check(!isset($order['contact']));
        $db=database($app);foreach(['orders','order_history','notifications','outbox']as$table)check(countRows($db,$table)===1);
        check($db->query('SELECT status FROM notifications')->fetchColumn()==='pending');check($db->query('SELECT event FROM outbox')->fetchColumn()==='order.created');check($db->query('SELECT author FROM order_history')->fetchColumn()==='guest');
        $original=$db->query('SELECT original_request FROM orders')->fetchColumn();$catalog=menu($app);$catalog['items'][0]['price']=1;menu($app,$catalog);
        $fresh=new CafeOrders($app['directory'],$app['site'],fn()=>menu($app),$app['config']);check($fresh->list()['orders'][0]['order']===$order);check($db->query('SELECT original_request FROM orders')->fetchColumn()===$original);
    });
    runTest('idempotent retry survives menu changes and quote expiry, changed payload is conflict',function (): void {
        $app=fixture();$body=request($app);$first=create($app,$body);$app['clock']->now+=301;$catalog=menu($app);$catalog['items'][0]['published']=false;menu($app,$catalog);
        $retry=create($app,$body);check($retry['_replayed']&&$retry['order']===$first['order']);
        $changed=$body;$changed['contact']['name']='Другой тест';errorCode(fn()=>create($app,$changed),'idempotency_conflict',409);
        $changed=$body;$changed['items'][0]['price']=999;errorCode(fn()=>create($app,$changed),'idempotency_conflict',409);check(countRows(database($app),'orders')===1);
    });
    runTest('SQL failure rolls back the entire order and retry creates exactly one',function (): void {
        $app=fixture();$body=request($app);$db=database($app);$db->exec("CREATE TRIGGER fail_notification BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'test failure'); END");
        try{create($app,$body);throw new LogicException('Expected failure');}catch(PDOException){}
        foreach(['orders','order_history','notifications','outbox']as$table)check(countRows($db,$table)===0);
        check($db->query('SELECT order_id FROM quotes')->fetchColumn()===null);$db->exec('DROP TRIGGER fail_notification');check(!create($app,$body)['_replayed']);check(countRows($db,'orders')===1);
    });
    runTest('parallel identical requests create one durable order and changed payload never overwrites',function (): void {
        $app=fixture();$body=request($app);$jobs=array_fill(0,5,['method'=>'create','body'=>$body]);$results=parallel($app,$jobs);$numbers=[];$created=0;
        foreach($results as$result){check($result['ok']);$numbers[]=$result['result']['order']['number'];if(!$result['result']['_replayed'])$created++;}check(count(array_unique($numbers))===1&&$created===1);
        $db=database($app);foreach(['orders','order_history','notifications','outbox']as$table)check(countRows($db,$table)===1);
        $app=fixture();$body=request($app);$changed=$body;$changed['contact']['name']='Другой тест';$results=parallel($app,[['method'=>'create','body'=>$body],['method'=>'create','body'=>$changed]]);check(count(array_filter($results,fn($r)=>$r['ok']))===1);check(countRows(database($app),'orders')===1);
    });
    runTest('same quote cannot create two orders with separate parallel idempotency keys',function (): void {
        $app=fixture();$body=request($app);$other=$body;$other['idempotencyKey']=bin2hex(random_bytes(16));$results=parallel($app,[['method'=>'create','body'=>$body],['method'=>'create','body'=>$other]]);
        check(count(array_filter($results,fn($r)=>$r['ok']))===1);$failed=array_values(array_filter($results,fn($r)=>!$r['ok']));check($failed[0]['code']==='quote_used');check(countRows(database($app),'orders')===1);
    });
    runTest('persistent rate reservation is atomic across processes and has bounded expiry',function (): void {
        $app=fixture();for($i=0;$i<58;$i++)quote($app);$results=parallel($app,array_fill(0,5,['method'=>'quote','body'=>draft($app)]));check(count(array_filter($results,fn($r)=>$r['ok']))===2);check(count(array_filter($results,fn($r)=>($r['code']??'')==='rate_limited'))===3);
        errorCode(fn()=>quote($app),'rate_limited',429);$app['clock']->now+=900;check(isset(quote($app)['quoteId']));
    });
    echo "{$passed} PHP order tests passed.\n";
} finally { foreach($directories as$directory)cleanFixture($directory); }
