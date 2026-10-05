<?php
declare(strict_types=1);
require_once __DIR__.'/../hosting/php/site.php';
$directories=[]; $passed=0;
const ORG='baa06e7a-b091-4296-97bc-275bc22d9af9';
const GUID='00000000-0000-4000-8000-000000000123';
function ck(bool $ok,string $message='Assertion failed'): void { if(!$ok) throw new RuntimeException($message); }
function testCase(string $name,callable $fn): void { global $passed; $fn(); ++$passed; echo "PASS: $name\n"; }
function fixture(bool $attached=true): object {
    global $directories;
    $dir=sys_get_temp_dir().'/cafe-kds-'.bin2hex(random_bytes(8)); mkdir($dir,0700); $directories[]=$dir;
    $app=(object)['directory'=>$dir,'clock'=>time(),'calls'=>[],'overrides'=>[],'pending'=>['pendingOrderId'=>'pending-1','status'=>0],
        'pos'=>['externalGuid'=>GUID,'kitchenStatus'=>'InProgress'],'lostCreate'=>false,'readError'=>0];
    $app->site=['public_origin'=>'https://test888.ru','staging'=>true,'indexing'=>false,'orders_environment'=>'staging','document_root'=>$dir.'/www','orders_clock'=>fn()=>$app->clock];
    $app->config=['enabled'=>true,'enableTestOrders'=>true,'environment'=>'staging','organizationId'=>ORG,'baseUrl'=>'https://kds.example/api/v1','serviceName'=>'fixture','servicePassword'=>'fixture-secret','menuMap'=>['porridge'=>'1012080']];
    $app->catalog=['revision'=>1,'items'=>[['id'=>'porridge','name'=>'Тест · Каша','description'=>'Вымышленный тест','price'=>200,'category'=>'porridge','image'=>'','published'=>true,'availableForOrder'=>true,'order'=>1]]];
    $app->transport=function($url,$method,$headers,$body)use($app):array {
        $route=basename(parse_url($url,PHP_URL_PATH)); $app->calls[]=[$route,$method,$body];
        if($route==='create-order' && $app->lostCreate) throw new RuntimeException('lost response');
        if(in_array($route,['get-pending-order','get-order'],true) && $app->readError) return ['status'=>$app->readError,'body'=>'{}'];
        $data=$app->overrides[$route] ?? match($route) {
            'service-token'=>['accessToken'=>'test-token'],
            'get-organizations'=>[['id'=>ORG,'defaultPayExternalId'=>'1043900','midServerOrderTypeCode'=>6]],
            'get-menu'=>['groups'=>[['items'=>[['externalId'=>'1012080','name'=>'Каша','price'=>200,'availabilityScheduleId'=>'0','modifierGroups'=>[]]],'childGroups'=>[]]],'periods'=>[]],
            'get-dish-rests'=>['forbidden'=>[],'limited'=>[]],
            'get-currencies'=>[['externalId'=>'1043900','name'=>'Тестовая предоплата','availabilityScheduleId'=>'0','allowedOrderTypeCodes'=>[6]]],
            'create-order'=>['pendingOrderId'=>'pending-1','pendingNumber'=>6,'pendingStatus'=>'Pending'],
            'get-pending-order'=>$app->pending,
            'get-order'=>$app->pos,
            default=>throw new RuntimeException('Unexpected request'),
        };
        return ['status'=>200,'body'=>json_encode($data,JSON_THROW_ON_ERROR)];
    };
    $app->orderConfig=array_replace(CafeOrders::developmentConfig(),['mode'=>'staging']);
    $app->api=new CafeOrders($dir,$app->site,fn()=>$app->catalog,$app->orderConfig);
    $app->delivery=new CafeKdsDelivery($dir,$app->api,$app->config,$app->transport);
    if($attached) $app->api->attachKds($app->delivery);
    $app->settings=$app->api->settings(null,'peer'); ck($app->settings['enabled']);
    $app->guest=$app->settings['_guestToken']; $app->csrf=$app->settings['csrfToken'];
    return $app;
}
function createOrder(object $a,bool $delivery=false):array {
    $draft=['items'=>[['id'=>'porridge','quantity'=>2]],'contact'=>['name'=>'Вымышленный гость','phone'=>'+70000000000'],
        'fulfilment'=>['type'=>$delivery?'delivery':'pickup','timing'=>'asap','requestedAt'=>null,'address'=>$delivery?['city'=>'Тестовый город','streetHouse'=>'Вымышленная улица, 1','apartment'=>'2','entrance'=>'3','floor'=>'4','intercom'=>'5']:null,'courierInstructions'=>$delivery?'Не доставлять':''],
        'orderComment'=>'Не готовить','consent'=>['accepted'=>true,'version'=>$a->orderConfig['consent']['version']]];
    $quote=$a->api->quote($draft,$a->guest,$a->csrf,'peer')['quote'];
    $a->body=$draft+['quoteId'=>$quote['quoteId'],'idempotencyKey'=>bin2hex(random_bytes(16))];
    return $a->api->create($a->body,$a->guest,$a->csrf,'peer')['order'];
}
function sends(object $a):array { return array_values(array_filter($a->calls,fn($v)=>$v[0]==='create-order')); }
function expectOrderError(callable $fn,int $status):void { try{$fn();}catch(CafeOrderException $e){ck($e->status===$status);return;} throw new RuntimeException('Expected rejection'); }
try {
testCase('fictional prepayment cannot be enabled on production or the wrong organization',function():void {
    $a=fixture(); $path=$a->directory.'/kds-config.json'; file_put_contents($path,json_encode($a->config));
    ck(CafeKdsDelivery::loadConfig($a->directory,$a->site)!==null);
    foreach([['orders_environment'=>'production'],['indexing'=>true],['staging'=>false]] as $patch) {
        try { CafeKdsDelivery::loadConfig($a->directory,array_replace($a->site,$patch)); throw new LogicException('Enabled'); } catch(RuntimeException $e) { ck(!$e instanceof LogicException); }
    }
    foreach([['environment'=>'production'],['organizationId'=>GUID],['menuMap'=>[]]] as $patch) {
        file_put_contents($path,json_encode(array_replace($a->config,$patch)));
        try { CafeKdsDelivery::loadConfig($a->directory,$a->site); throw new LogicException('Enabled'); } catch(RuntimeException $e) { ck(!$e instanceof LogicException); }
    }
    file_put_contents($path,json_encode(array_replace($a->config,['enableTestOrders'=>false,'organizationId'=>GUID])));
    ck(CafeKdsDelivery::loadConfig($a->directory,$a->site)===null, 'Read-only integrations never enable test order delivery');
});
testCase('atomic local creation queues once; Pending survives restart and repeated website submissions',function():void {
    $a=fixture(); $order=createOrder($a); $id=$order['trackingId']; ck(sends($a)===[]);
    ck($a->api->create($a->body,$a->guest,$a->csrf,'peer')['order']===$order);
    ck((int)$a->api->connection()->query('SELECT COUNT(*) FROM kds_jobs')->fetchColumn()===1);
    ck($a->delivery->sync($id)['state']==='Pending'); ck(count(sends($a))===1);
    $payload=json_decode(sends($a)[0][2],true); ck($payload['items'][0]['quantity']===2 && $payload['items'][0]['price']===200);
    ck($payload['pays'][0]['amount']===400 && $payload['pays'][0]['isPrepay']===true); ck(str_contains($payload['comment'],'НЕ ГОТОВИТЬ'));
    $again=new CafeKdsDelivery($a->directory,$a->api,$a->config,$a->transport);
    for($i=0;$i<4;$i++){ $a->clock+=6; ck($again->sync($id)['state']==='Pending'); }
    ck(count(sends($a))===1); ck(!str_contains(json_encode($a->api->track($id,$a->guest,null,'peer',false)),'fixture-secret'));
    $a->pending=['pendingOrderId'=>'pending-1','dailyNumber'=>6,'status'=>1,'order'=>['externalGuid'=>GUID,'kitchenStatus'=>'InProgress']];
    $a->clock+=6; ck($again->sync($id)['state']==='Accepted');
    $a->pos['kitchenStatus']='Ready'; $a->clock+=6; ck($again->sync($id)['state']==='Ready');
    $a->pos['kitchenStatus']='Closed'; $a->clock+=6; ck($again->sync($id)['state']==='Closed');
    $count=count($a->calls); $a->clock+=60; ck($again->work()===[] && count($a->calls)===$count); ck(count(sends($a))===1);
});
testCase('replacement profile selects the proper server and does not consume the previous organization queue',function():void {
    $a=fixture(); $order=createOrder($a);
    $next=array_replace($a->config,['organizationId'=>'d840d3ea-e6b7-4097-9db3-8acd45259bf2',
        'baseUrl'=>'http://146.158.119.207:8081/api/v1','localBaseUrl'=>'http://192.168.2.117:8081/api/v1','allowHttpForTest'=>true]);
    file_put_contents($a->directory.'/kds-config.json',json_encode($next));
    $local=CafeKdsDelivery::loadConfig($a->directory,array_replace($a->site,['allow_http_dev'=>true]));
    $hosted=CafeKdsDelivery::loadConfig($a->directory,$a->site);
    ck($local['baseUrl']===$next['localBaseUrl'] && $hosted['baseUrl']===$next['baseUrl']);
    $other=new CafeKdsDelivery($a->directory,$a->api,$local,$a->transport);
    ck($other->work()===[] && $other->state($order['trackingId'])['state']==='not_connected');
    ck($a->calls===[] && $a->delivery->state($order['trackingId'])['state']==='queued');
});
testCase('tracking is guest-owned, CSRF protected and environment isolated',function():void {
    $a=fixture(); $id=createOrder($a)['trackingId']; $other=$a->api->settings(null,'other');
    expectOrderError(fn()=>$a->api->track($id,null,null,'peer',false),403);
    expectOrderError(fn()=>$a->api->track($id,$other['_guestToken'],null,'peer',false),404);
    expectOrderError(fn()=>$a->api->track($id,$a->guest,'bad','peer',true),403);
    expectOrderError(fn()=>$a->api->track(str_repeat('a',32),$a->guest,null,'peer',false),404);
    ck($a->api->track($id,$a->guest,null,'peer',false)['delivery']['state']==='queued'); ck(sends($a)===[]);
    $b=new CafeOrders($a->directory,array_replace($a->site,['orders_environment'=>'production']),fn()=>$a->catalog,$a->orderConfig);
    expectOrderError(fn()=>$b->track($id,$a->guest,null,'peer',false),404);
});
testCase('lost create response and interrupted sending never cause a second POST',function():void {
    foreach([true,false] as $lost) {
        $a=fixture(); $id=createOrder($a)['trackingId'];
        if($lost){$a->lostCreate=true; ck($a->delivery->sync($id)['state']==='unknown');}
        else {$a->api->connection()->exec("UPDATE kds_jobs SET state='sending',next_at=0"); ck($a->delivery->sync($id)['state']==='unknown');}
        $a->clock+=600; $a->delivery->work(); $a->delivery->sync($id);
        ck(count(sends($a))===($lost?1:0));
    }
});
testCase('Pending read errors and missing or canceled Pending do not resubmit',function():void {
    $a=fixture(); $id=createOrder($a)['trackingId']; $a->delivery->sync($id);
    $a->readError=500; $a->clock+=6; ck($a->delivery->sync($id)['state']==='Pending');
    $a->readError=404; $a->clock+=16; ck($a->delivery->sync($id)['state']==='missing');
    $a->clock+=60; $a->delivery->work(); ck(count(sends($a))===1);
    foreach([['pendingStatus'=>'Canceled'],['status'=>2]] as $cancel) {
        $a=fixture(); $id=createOrder($a)['trackingId']; $a->delivery->sync($id); $a->clock+=6;
        $a->pending=['pendingOrderId'=>'pending-1']+$cancel; ck($a->delivery->sync($id)['state']==='Canceled'); ck(count(sends($a))===1);
    }
});
testCase('stop list, thousandth-portion limits, changed prices and mandatory modifiers block before sending',function():void {
    foreach(['stop','limit','price','modifier','period','currency'] as $case) {
        $a=fixture(); $id=createOrder($a)['trackingId'];
        if($case==='stop') $a->overrides['get-dish-rests']=['forbidden'=>[['externalId'=>'1012080']],'limited'=>[]];
        elseif($case==='limit') $a->overrides['get-dish-rests']=['forbidden'=>[],'limited'=>[['externalId'=>'1012080','quantity'=>1999]]];
        elseif($case==='currency') $a->overrides['get-currencies']=[];
        else $a->overrides['get-menu']=['groups'=>[['items'=>[['externalId'=>'1012080','name'=>'Каша','price'=>$case==='price'?201:200,'availabilityScheduleId'=>$case==='period'?'123':'0','modifierGroups'=>$case==='modifier'?[['minCount'=>1]]:[]]]]],'periods'=>[]];
        ck($a->delivery->sync($id)['state']==='blocked',$case); ck(sends($a)===[],$case);
    }
    $a=fixture(); $id=createOrder($a)['trackingId']; $a->overrides['get-dish-rests']=['forbidden'=>[],'limited'=>[['externalId'=>'1012080','quantity'=>2000]]];
    ck($a->delivery->sync($id)['state']==='Pending');
});
testCase('delivery address and wishes are preserved; uncertain delivery charge is not collected',function():void {
    $a=fixture(); $id=createOrder($a,true)['trackingId']; ck($a->delivery->sync($id)['state']==='Pending');
    $payload=json_decode(sends($a)[0][2],true);
    foreach(['Вымышленная улица, 1','Квартира: 2','Подъезд: 3','Этаж: 4','Домофон: 5','Не доставлять','Стоимость доставки не согласована'] as $text) ck(str_contains($payload['comment'],$text),$text);
    ck($payload['pays'][0]['amount']===400);
});
testCase('old saved website orders are not backfilled after KDS is enabled',function():void {
    $a=fixture(false); $old=createOrder($a); ck(!isset($old['trackingId']));
    $a->api->attachKds($a->delivery); ck($a->delivery->work()===[] && sends($a)===[]);
    ck($a->api->create($a->body,$a->guest,$a->csrf,'peer')['order']===$old);
});
testCase('test dishes append once without replacing existing menu, and only mapped dishes can be ordered',function():void {
    $a=fixture(); mkdir($a->directory.'/app/seed',0700,true);
    $original=$a->catalog['items'][0]; $original['id']='original';
    file_put_contents($a->directory.'/app/seed/menu.json',json_encode(['items'=>[$original]]));
    $menu=new CafeMenu($a->directory,$a->site+['orderable_ids'=>['porridge'],'kds_test_items'=>$a->catalog['items']]);
    $first=$menu->catalog(); ck(count($first['items'])===2); ck($first['items'][0]['availableForOrder']===false && $first['items'][1]['availableForOrder']===true);
    ck($menu->catalog()===$first); ck($menu->read()['items'][0]===cafe_validate_items([$original])[0]);
    $menu->withLockedSnapshot(function($value):void{ck(!$value['items'][0]['availableForOrder']);});
});
echo "$passed KDS delivery tests passed. No external requests made.\n";
} finally {
    gc_collect_cycles(); // Release PDO connections captured by fixture closures on Windows.
    foreach($directories as $directory) {
        $resolved=realpath($directory); ck($resolved!==false && dirname($resolved)===realpath(sys_get_temp_dir()) && str_starts_with(basename($resolved),'cafe-kds-'),'Unsafe cleanup');
        $it=new RecursiveIteratorIterator(new RecursiveDirectoryIterator($resolved,FilesystemIterator::SKIP_DOTS),RecursiveIteratorIterator::CHILD_FIRST);
        foreach($it as $entry) { if($entry->isDir()&&!$entry->isLink()) rmdir($entry->getPathname()); else unlink($entry->getPathname()); } rmdir($resolved);
    }
}
