<?php
declare(strict_types=1);
require_once __DIR__.'/../hosting/php/core.php';
require_once __DIR__.'/../hosting/php/staff-orders.php';
$directories=[];$passed=0;
function check(bool$condition,string$message='Assertion failed'):void{if(!$condition)throw new RuntimeException($message);}
function errorCode(callable$operation,string$code,?int$status=null):CafeOrderException{try{$operation();}catch(CafeOrderException$error){check($error->errorCode===$code,'Unexpected '.$error->errorCode.' instead of '.$code);if($status!==null)check($error->status===$status);return$error;}throw new RuntimeException('Expected '.$code);}
function roster(array$app,?array$value=null):array{$path=$app['directory'].'/staff.json';if($value!==null)file_put_contents($path,json_encode($value,JSON_THROW_ON_ERROR));return json_decode(file_get_contents($path),true,512,JSON_THROW_ON_ERROR);}
function catalog(array$app,?array$value=null):array{$path=$app['directory'].'/menu.json';if($value!==null)CafeStorage::locked($app['directory'].'/menu.lock',static fn()=>file_put_contents($path,json_encode($value,JSON_THROW_ON_ERROR)));return json_decode(file_get_contents($path),true,512,JSON_THROW_ON_ERROR);}
function fixture():array{
    global$directories;$directory=sys_get_temp_dir().'/cafe-php-staff-'.bin2hex(random_bytes(8));mkdir($directory,0700,true);mkdir($directory.'/www');$directories[]=$directory;
    $clock=(object)['now'=>(new DateTimeImmutable('2026-09-28T10:00:00+03:00'))->getTimestamp()];
    $config=array_replace(CafeOrders::developmentConfig(),['mode'=>'production','termsApproved'=>true]);
    $site=['public_origin'=>'https://cafe.example','document_root'=>$directory.'/www','orders_environment'=>'staging','orders_clock'=>static fn():int=>$clock->now];
    $app=compact('directory','clock','config','site');
    roster($app,['101'=>['id'=>'101','name'=>'Тестовый сотрудник А','role'=>'employee','active'=>true],'102'=>['id'=>'102','name'=>'Тестовый сотрудник Б','role'=>'employee','active'=>true],'900'=>['id'=>'900','name'=>'Тестовый руководитель','role'=>'manager','active'=>true]]);
    catalog($app,['revision'=>1,'items'=>[['id'=>'test-breakfast','name'=>'Тестовый завтрак','price'=>100,'published'=>true,'availableForOrder'=>true],['id'=>'test-toast','name'=>'Тестовый тост','price'=>200,'published'=>true,'availableForOrder'=>true]]]);
    $provider=static fn():array=>json_decode(file_get_contents($directory.'/menu.json'),true,512,JSON_THROW_ON_ERROR);
    $locker=static fn(callable$operation):mixed=>CafeStorage::locked($directory.'/menu.lock',static fn():mixed=>$operation($provider()));
    $app['orders']=new CafeOrders($directory,$site,$provider,$config,$locker);
    $app['resolver']=static fn(string$id):?array=>json_decode(file_get_contents($directory.'/staff.json'),true,512,JSON_THROW_ON_ERROR)[$id]??null;
    $app['staff']=new CafeStaffOrders($app['orders'],[],$app['resolver']);
    $guest=$app['orders']->settings(null,'guest');$app['guest']=$guest['_guestToken'];$app['csrf']=$guest['csrfToken'];
    return$app;
}
function who(array$app,string$id='101'):array{return roster($app)[$id];}
function guestDraft(array$app,bool$delivery=false):array{return['items'=>[['id'=>'test-breakfast','quantity'=>2]],'contact'=>['phone'=>'+70000000000','name'=>'Тестовый гость'],'fulfilment'=>['type'=>$delivery?'delivery':'pickup','timing'=>'asap','requestedAt'=>null,'address'=>$delivery?['city'=>'Тестовый город','streetHouse'=>'Вымышленная улица, 1']:null,'courierInstructions'=>''],'orderComment'=>'Тестовая заявка','consent'=>['accepted'=>true,'version'=>$app['config']['consent']['version']]];}
function newOrder(array$app,bool$delivery=false):array{
    $body=guestDraft($app,$delivery);$quote=$app['orders']->quote($body,$app['guest'],$app['csrf'],'guest')['quote'];$body+=['quoteId'=>$quote['quoteId'],'idempotencyKey'=>bin2hex(random_bytes(16))];$created=$app['orders']->create($body,$app['guest'],$app['csrf'],'guest');
    $id=$app['orders']->connection()->query('SELECT id FROM orders ORDER BY rowid DESC LIMIT 1')->fetchColumn();return$app['staff']->detail($id,who($app))['order'];
}
function cmd(array$app,string$action,array$order,array$body=[],string$employee='101'):array{return$app['staff']->command($action,$order['id'],$body+['expectedVersion'=>$order['version']],who($app,$employee));}
function claim(array$app,array$order,string$employee='101'):array{return cmd($app,'claim',$order,[],$employee)['order'];}
function editBody(array$order):array{return['expectedVersion'=>$order['version'],'items'=>array_map(static fn(array$item):array=>['id'=>$item['id'],'quantity'=>$item['quantity']],$order['items']),'contact'=>$order['contact'],'fulfilment'=>$order['fulfilment'],'deliveryFeeMinor'=>$order['deliveryFeeMinor'],'staffNote'=>$order['staffNote'],'fulfillmentComment'=>$order['fulfillmentComment']];}
function prepared(array$app,bool$delivery=false):array{$order=claim($app,newOrder($app,$delivery));$body=editBody($order);$body['fulfilment']['confirmedAt']='2026-09-28T13:00:00+03:00';if($delivery)$body['deliveryFeeMinor']=15000;$body['staffNote']='Внутренняя заметка, не передавать';$body['fulfillmentComment']='Согласованный комментарий для выполнения';return cmd($app,'save',$order,$body)['order'];}
function acceptBody(array$order):array{return['expectedVersion'=>$order['version'],'agreed'=>true,'idempotencyKey'=>bin2hex(random_bytes(16))];}
function countRows(array$app,string$table):int{return(int)$app['orders']->connection()->query('SELECT COUNT(*) FROM '.$table)->fetchColumn();}
function spawnWorker(array$app,array$job):array{
    $file=$app['directory'].'/worker-'.bin2hex(random_bytes(6)).'.json';$site=$app['site'];unset($site['orders_clock']);file_put_contents($file,json_encode($job+['directory'=>$app['directory'],'site'=>$site,'config'=>$app['config'],'now'=>$app['clock']->now],JSON_THROW_ON_ERROR));
    $pipes=[];$process=proc_open([PHP_BINARY,__DIR__.'/php-staff-orders-worker.php',$file],[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']],$pipes,null,null,['bypass_shell'=>true]);if(!is_resource($process))throw new RuntimeException('Cannot start worker');fclose($pipes[0]);return[$process,$pipes,$file];
}
function finishWorker(array$running):array{[$process,$pipes,$file]=$running;$output=stream_get_contents($pipes[1]);$error=stream_get_contents($pipes[2]);fclose($pipes[1]);fclose($pipes[2]);$exit=proc_close($process);unlink($file);check($exit===0&&$error==='','Worker error '.$error);return json_decode($output,true,512,JSON_THROW_ON_ERROR);}
function parallel(array$app,array$jobs):array{$running=[];foreach($jobs as$job)$running[]=spawnWorker($app,$job);return array_map('finishWorker',$running);}
function runTest(string$name,callable$operation):void{global$passed;$operation();$passed++;echo"PASS: {$name}\n";}
function cleanFixture(string$directory):void{$real=realpath($directory);$tmp=realpath(sys_get_temp_dir());if(!$real||!$tmp||dirname($real)!==$tmp||!str_starts_with(basename($real),'cafe-php-staff-'))throw new RuntimeException('Unsafe cleanup');$iterator=new RecursiveIteratorIterator(new RecursiveDirectoryIterator($real,FilesystemIterator::SKIP_DOTS),RecursiveIteratorIterator::CHILD_FIRST);foreach($iterator as$entry){if($entry->isLink())unlink($entry->getPathname());elseif($entry->isDir())rmdir($entry->getPathname());else unlink($entry->getPathname());}rmdir($real);}

try{
    runTest('sequential numbers are atomic and migration preserves legacy receipts',function():void{
        $app=fixture();$first=newOrder($app);$second=newOrder($app);check($first['number']==='TEST-000001'&&$second['number']==='TEST-000002');
        $db=$app['orders']->connection();$row=$db->query('SELECT id,snapshot FROM orders ORDER BY rowid LIMIT 1')->fetch(PDO::FETCH_ASSOC);$receipt=json_decode($row['snapshot'],true);$receipt['number']='260928-AB12CD34';$statement=$db->prepare('UPDATE orders SET number=?,snapshot=? WHERE id=?');$statement->execute([$receipt['number'],json_encode($receipt),$row['id']]);
        $reopened=new CafeOrders($app['directory'],$app['site'],fn()=>catalog($app),$app['config']);check(in_array('260928-AB12CD34',array_map(static fn(array$r):string=>$r['order']['number'],$reopened->list()['orders']),true));
        $jobs=[];for($i=0;$i<4;$i++){$body=guestDraft($app);$q=$app['orders']->quote($body,$app['guest'],$app['csrf'],'guest')['quote'];$jobs[]=['mode'=>'create','body'=>$body+['quoteId'=>$q['quoteId'],'idempotencyKey'=>bin2hex(random_bytes(16))],'guest'=>$app['guest'],'csrf'=>$app['csrf']];}
        $results=parallel($app,$jobs);$numbers=[];foreach($results as$r){check($r['ok']);$numbers[]=$r['result']['order']['number'];}sort($numbers);check($numbers===['TEST-000003','TEST-000004','TEST-000005','TEST-000006']);
    });
    runTest('search, detail and history require current active identity and keep phone in body',function():void{
        $app=fixture();$order=newOrder($app);$list=$app['staff']->search(['query'=>'8 (000) 000-00-00','date'=>'2026-09-28','page'=>1,'pageSize'=>1],who($app));check($list['total']===1&&$list['orders'][0]['id']===$order['id']);
        check($app['staff']->detail($order['id'],who($app))['history'][0]['author']['id']==='guest');
        errorCode(fn()=>$app['staff']->detail($order['id'],['id'=>'unapproved','role'=>'manager','active'=>true,'name'=>'forged']),'access_revoked',403);
        $identity=who($app);$people=roster($app);$people['101']['active']=false;roster($app,$people);errorCode(fn()=>$app['staff']->search([],$identity),'access_revoked',403);errorCode(fn()=>$app['staff']->detail($order['id'],$identity),'access_revoked',403);
    });
    runTest('legacy nine-column database migrates once and staff cannot cross environments',function():void{
        $app=fixture();$order=newOrder($app);$row=$app['orders']->connection()->query('SELECT id,number,guest_hash,idempotency_hash,payload_hash,status,created_at,original_request,snapshot FROM orders')->fetch(PDO::FETCH_ASSOC);
        $directory=$app['directory'].'/legacy';mkdir($directory);mkdir($directory.'/orders-data');$db=new PDO('sqlite:'.$directory.'/orders-data/orders.sqlite');
        $db->exec('CREATE TABLE orders(id TEXT PRIMARY KEY,number TEXT UNIQUE NOT NULL,guest_hash TEXT NOT NULL,idempotency_hash TEXT UNIQUE NOT NULL,payload_hash TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,original_request TEXT NOT NULL,snapshot TEXT NOT NULL)');$db->prepare('INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?)')->execute(array_values($row));$db=null;
        $migrated=new CafeOrders($directory,$app['site'],fn()=>catalog($app),$app['config']);$saved=$migrated->connection()->query('SELECT * FROM orders')->fetch(PDO::FETCH_ASSOC);check($saved['snapshot']===$row['snapshot']&&$saved['number']===$row['number']&&(int)$saved['version']===1&&$saved['environment']==='staging');
        $site=$app['site'];$site['orders_environment']='production';$wrong=new CafeStaffOrders(new CafeOrders($app['directory'],$site,fn()=>catalog($app),$app['config']),[],$app['resolver']);check($wrong->search([],who($app))['total']===0);errorCode(fn()=>$wrong->detail($order['id'],who($app)),'not_found',404);
    });
    runTest('two concurrent claims have one winner and preserve losing context',function():void{
        $app=fixture();$order=newOrder($app);$jobs=[];foreach(['101','102']as$id)$jobs[]=['action'=>'claim','id'=>$order['id'],'body'=>['expectedVersion'=>1],'identity'=>who($app,$id)];$results=parallel($app,$jobs);check(count(array_filter($results,fn($r)=>$r['ok']))===1);$failed=array_values(array_filter($results,fn($r)=>!$r['ok']));check($failed[0]['code']==='version_conflict');
        $detail=$app['staff']->detail($order['id'],who($app));check($detail['order']['version']===2&&count($detail['history'])===2);check(countRows($app,'integration_events')===0);
    });
    runTest('ownership, manager reassignment with reason, release and revoked target are enforced',function():void{
        $app=fixture();$order=claim($app,newOrder($app));
        errorCode(fn()=>cmd($app,'save',$order,editBody($order),'102'),'not_assignee',403);errorCode(fn()=>cmd($app,'save',$order,editBody($order),'900'),'not_assignee',403);
        $forged=who($app);$forged['role']='manager';errorCode(fn()=>$app['staff']->command('reassign',$order['id'],['expectedVersion'=>$order['version'],'assigneeId'=>'102','reason'=>'Тест'],$forged),'forbidden',403);
        errorCode(fn()=>cmd($app,'reassign',$order,['assigneeId'=>'102','reason'=>''],'900'),'invalid_order',422);
        $order=cmd($app,'reassign',$order,['assigneeId'=>'102','reason'=>'Смена сотрудника'],'900')['order'];check($order['assignee']['id']==='102');
        $order=cmd($app,'release',$order,[],'102')['order'];check($order['status']==='new'&&$order['assignee']===null);
        $people=roster($app);$people['102']['active']=false;roster($app,$people);errorCode(fn()=>cmd($app,'reassign',$order,['assigneeId'=>'102','reason'=>'Тест'],'900'),'invalid_assignee',422);
    });
    runTest('save recalculates trusted amounts and leaves original receipt immutable without an accepted event',function():void{
        $app=fixture();$order=claim($app,newOrder($app,true));$db=$app['orders']->connection();$original=$db->query('SELECT snapshot,original_request FROM orders')->fetch(PDO::FETCH_ASSOC);
        $body=editBody($order);$body['items']=[['id'=>'test-toast','quantity'=>3,'unitPriceMinor'=>1]];$body['fulfilment']['type']='pickup';$body['fulfilment']['address']=null;$body['deliveryFeeMinor']=99999;$body['staffNote']='Внутреннее';
        $result=cmd($app,'save',$order,$body);check($result['order']['subtotalMinor']===60000&&$result['order']['deliveryFeeMinor']===0);check($result['order']['fulfilment']['address']===null);check(countRows($app,'integration_events')===0);
        check($db->query('SELECT snapshot,original_request FROM orders')->fetch(PDO::FETCH_ASSOC)===$original);check(isset($result['history'][2]['changes']['items']));
        errorCode(fn()=>cmd($app,'save',$order,$body),'version_conflict',409);
    });
    runTest('current price differences require explicit bound one-use confirmation and no hidden repricing',function():void{
        $app=fixture();$order=claim($app,newOrder($app));$menu=catalog($app);$menu['items'][0]['price']=120;$menu['revision']=2;catalog($app,$menu);$body=editBody($order);
        $e=errorCode(fn()=>cmd($app,'save',$order,$body),'prices_changed',409);check($e->details['changes'][0]['previousUnitPriceMinor']===10000&&$e->details['preview']['subtotalMinor']===24000);check($app['staff']->detail($order['id'],who($app))['order']['subtotalMinor']===20000);
        $altered=$body;$altered['staffNote']='Поменял тело';$altered['priceConfirmationToken']=$e->details['priceConfirmationToken'];errorCode(fn()=>cmd($app,'save',$order,$altered),'prices_changed',409);
        $body['priceConfirmationToken']=$e->details['priceConfirmationToken'];$saved=cmd($app,'save',$order,$body)['order'];check($saved['subtotalMinor']===24000&&$saved['version']===3);
        errorCode(fn()=>cmd($app,'save',$order,$body),'version_conflict',409);
    });
    runTest('accept requires explicit guest agreement, concrete future time, known delivery and available dishes',function():void{
        $app=fixture();$order=claim($app,newOrder($app,true));$body=acceptBody($order);$body['agreed']=false;errorCode(fn()=>cmd($app,'accept',$order,$body),'agreement_required',422);
        errorCode(fn()=>cmd($app,'accept',$order,acceptBody($order)),'confirmed_time_required',422);
        $edit=editBody($order);$edit['fulfilment']['confirmedAt']='2026-09-28T13:00:00+03:00';$order=cmd($app,'save',$order,$edit)['order'];errorCode(fn()=>cmd($app,'accept',$order,acceptBody($order)),'delivery_fee_required',422);
        $edit=editBody($order);$edit['deliveryFeeMinor']=15000;$order=cmd($app,'save',$order,$edit)['order'];$menu=catalog($app);$menu['items'][0]['availableForOrder']=false;catalog($app,$menu);errorCode(fn()=>cmd($app,'accept',$order,acceptBody($order)),'item_unavailable',409);check(countRows($app,'integration_events')===0);
        $menu['items'][0]['availableForOrder']=true;catalog($app,$menu);$app['clock']->now=(new DateTimeImmutable('2026-09-28T12:01:00+03:00'))->getTimestamp();errorCode(fn()=>cmd($app,'accept',$order,acceptBody($order)),'invalid_time',422);
    });
    runTest('accept detects price changes then saves/reconfirms before producing immutable payload without internal notes',function():void{
        $app=fixture();$order=prepared($app,true);$menu=catalog($app);$menu['items'][0]['price']=125;$menu['revision']=2;catalog($app,$menu);
        $e=errorCode(fn()=>cmd($app,'accept',$order,acceptBody($order)),'prices_changed',409);check(countRows($app,'integration_events')===0);
        $edit=editBody($order);$edit['priceConfirmationToken']=$e->details['priceConfirmationToken'];$order=cmd($app,'save',$order,$edit)['order'];$accepted=cmd($app,'accept',$order,acceptBody($order));check($accepted['order']['status']==='accepted'&&$accepted['integration']['status']==='waiting_configuration');check($accepted['integration']['cashRegisterStatus']==='not_configured');
        $payload=json_decode($app['orders']->connection()->query('SELECT payload FROM integration_events')->fetchColumn(),true);check($payload['order']['totals']['totalMinor']===40000);check($payload['order']['fulfillment']['confirmedAt']==='2026-09-28T10:00:00Z');check($payload['order']['fulfillment']['requestedAt']===null);check($payload['order']['customer']['phone']==='+70000000000');check($payload['order']['fulfillment']['address']['streetHouse']==='Вымышленная улица, 1');check(!str_contains(json_encode($payload,JSON_UNESCAPED_UNICODE),'Внутренняя заметка'));check(!isset($payload['order']['staffNote']));check($payload['order']['payment']['status']==='not_configured');
        $stored=$app['orders']->connection()->query('SELECT payload FROM integration_events')->fetchColumn();$menu['items'][0]['price']=1;catalog($app,$menu);check($app['orders']->connection()->query('SELECT payload FROM integration_events')->fetchColumn()===$stored);
    });
    runTest('parallel acceptance and response-loss retries leave exactly one final snapshot and event',function():void{
        $app=fixture();$order=prepared($app);$body=acceptBody($order);$jobs=array_fill(0,4,['action'=>'accept','id'=>$order['id'],'body'=>$body,'identity'=>who($app)]);$results=parallel($app,$jobs);$events=[];foreach($results as$r){check($r['ok']);$events[]=$r['result']['integration']['eventId'];}check(count(array_unique($events))===1&&countRows($app,'integration_events')===1);
        $saved=$results[0]['result'];$brokenOrders=new CafeOrders($app['directory'],$app['site'],static function():array{throw new RuntimeException('Catalog offline');},$app['config']);$brokenStaff=new CafeStaffOrders($brokenOrders,[],$app['resolver']);check($brokenStaff->command('accept',$order['id'],$body,who($app))===$saved);
        $changed=$body;$changed['expectedVersion']++;errorCode(fn()=>cmd($app,'accept',$order,$changed),'idempotency_conflict',409);
        $newKey=$body;$newKey['idempotencyKey']=bin2hex(random_bytes(16));check($brokenStaff->command('accept',$order['id'],$newKey,who($app))['integration']['eventId']===$events[0]);check(countRows($app,'integration_events')===1);
        $current=$saved['order'];foreach(['save','release','cancel']as$action)errorCode(fn()=>cmd($app,$action,$current,$action==='save'?editBody($current):[]),'read_only',409);
    });
    runTest('accept rollback includes status, history, notification, final snapshot and integration event',function():void{
        $app=fixture();$order=prepared($app);$db=$app['orders']->connection();$history=countRows($app,'order_history');$notifications=countRows($app,'notifications');$db->exec("CREATE TRIGGER fail_event BEFORE INSERT ON integration_events BEGIN SELECT RAISE(ABORT,'test'); END");$body=acceptBody($order);
        try{cmd($app,'accept',$order,$body);throw new LogicException('Expected SQL failure');}catch(PDOException){}
        check($app['staff']->detail($order['id'],who($app))['order']===$order);check(countRows($app,'order_history')===$history&&countRows($app,'notifications')===$notifications&&countRows($app,'integration_events')===0&&countRows($app,'staff_idempotency')===0);check($db->query('SELECT accepted_snapshot FROM orders')->fetchColumn()===null);
        $db->exec('DROP TRIGGER fail_event');check(cmd($app,'accept',$order,$body)['order']['status']==='accepted');
    });
    runTest('contact attempts and reasoned cancellation retain history and do not create acceptance',function():void{
        $app=fixture();$free=newOrder($app);errorCode(fn()=>cmd($app,'cancel',$free,['confirmed'=>true,'reason'=>'guest_declined']),'forbidden',403);
        $order=claim($app,$free);$result=cmd($app,'contact-attempts',$order,['comment'=>'Не ответили, повторить позже']);$order=$result['order'];check($order['status']==='processing'&&$result['history'][2]['comment']==='Не ответили, повторить позже');
        errorCode(fn()=>cmd($app,'cancel',$order,['confirmed'=>true,'reason'=>'other','comment'=>'']),'invalid_order',422);
        $result=cmd($app,'cancel',$order,['confirmed'=>true,'reason'=>'other','comment'=>'Тестовая причина']);check($result['order']['status']==='cancelled'&&countRows($app,'integration_events')===0);
        $free=newOrder($app);check(cmd($app,'cancel',$free,['confirmed'=>true,'reason'=>'duplicate','duplicateOf'=>$order['id']],'900')['order']['status']==='cancelled');
    });
    runTest('access is rechecked after waiting for the shared menu lock',function():void{
        $app=fixture();$order=prepared($app);$stream=fopen($app['directory'].'/menu.lock','c+b');flock($stream,LOCK_EX);
        $worker=spawnWorker($app,['action'=>'accept','id'=>$order['id'],'body'=>acceptBody($order),'identity'=>who($app)]);usleep(150000);$people=roster($app);$people['101']['active']=false;roster($app,$people);flock($stream,LOCK_UN);fclose($stream);$result=finishWorker($worker);check(!$result['ok']&&$result['code']==='access_revoked');check(countRows($app,'integration_events')===0);
    });
    runTest('menu writes cannot race price validation and accepted commit',function():void{
        $app=fixture();$order=prepared($app);$directory=$app['directory'];$menu=catalog($app);$menu['items'][0]['price']=999;$menu['revision']=2;
        $worker=null;$provider=fn():array=>catalog($app);
        $locker=function(callable$operation)use($app,$directory,$menu,&$worker,$provider):mixed{return CafeStorage::locked($directory.'/menu.lock',function()use($app,$menu,&$worker,$provider,$operation):mixed{$snapshot=$provider();$worker=spawnWorker($app,['mode'=>'menu-update','catalog'=>$menu]);usleep(100000);$result=$operation($snapshot);check(catalog($app)['revision']===1,'Menu changed while acceptance held its lock');return$result;});};
        $orders=new CafeOrders($directory,$app['site'],$provider,$app['config'],$locker);$staff=new CafeStaffOrders($orders,[],$app['resolver']);$result=$staff->command('accept',$order['id'],acceptBody($order),who($app));check($result['order']['subtotalMinor']===20000);check(finishWorker($worker)['ok']);check(catalog($app)['revision']===2);$payload=json_decode($orders->connection()->query('SELECT payload FROM integration_events')->fetchColumn(),true);check($payload['order']['totals']['subtotalMinor']===20000);
    });
    runTest('manager retries preserve event identity, immutable payload and accepted version',function():void{
        $app=fixture();$order=prepared($app);$result=cmd($app,'accept',$order,acceptBody($order));$event=$result['integration']['eventId'];$accepted=$result['order'];$db=$app['orders']->connection();$db->exec("UPDATE integration_events SET status='failed',last_error='redacted'");$payload=$db->query('SELECT payload FROM integration_events')->fetchColumn();
        errorCode(fn()=>$app['staff']->retry($event,['expectedVersion'=>$accepted['version']],who($app)),'forbidden',403);$retry=$app['staff']->retry($event,['expectedVersion'=>$accepted['version']],who($app,'900'));check($retry['integration']['eventId']===$event&&$retry['integration']['status']==='waiting_configuration');check($retry['order']['version']===$accepted['version']&&countRows($app,'integration_events')===1);check($db->query('SELECT payload FROM integration_events')->fetchColumn()===$payload);
    });
    echo"{$passed} PHP staff order tests passed.\n";
}finally{foreach($directories as$directory)cleanFixture($directory);}
