<?php
declare(strict_types=1);
require_once __DIR__.'/../hosting/php/telegram.php';
require_once __DIR__.'/../hosting/php/staff-orders.php';

$directories=[]; $passed=0;
function tgCheck(bool $value,string $message='Assertion failed'): void { if (!$value) throw new RuntimeException($message); }
function tgError(callable $fn,string $code,?int $status=null): void { try { $fn(); } catch (CafeTelegramException $e) { tgCheck($e->errorCode===$code,'Unexpected code '.$e->errorCode); if ($status!==null) tgCheck($e->status===$status); return; } throw new RuntimeException('Expected '.$code); }
function tgTest(string $name,callable $fn): void { global $passed; $fn();$passed++;echo "PASS: {$name}\n"; }
function tgConfig(): array {
    // Deliberately non-working token and fictional staff, used only with injected transport.
    return ['enabled'=>true,'environment'=>'production','botToken'=>'123456789:'.str_repeat('A',35),'botUsername'=>'vosem_utra_bot','webhookSecret'=>str_repeat('b',64),'webAppUrl'=>'https://cafe.example/staff.html',
        'notifications'=>['mode'=>'private','groupChatId'=>null,'miniAppName'=>''],'staff'=>[
            ['id'=>'100001','name'=>'Тестовый руководитель','role'=>'manager','active'=>true],['id'=>'100002','name'=>'Тестовый сотрудник','role'=>'employee','active'=>true]],'responsibleContact'=>'Тестовый ответственный'];
}
function tgSaveConfig(array $app,array $config): void { file_put_contents($app['directory'].'/telegram-config.php',"<?php\nreturn ".var_export($config,true).";\n"); }
function tgFixture(?callable $transport=null,?array $config=null): array {
    global $directories; $directory=sys_get_temp_dir().'/cafe-telegram-'.bin2hex(random_bytes(8)); mkdir($directory,0700,true);$directories[]=$directory;
    $clock=(object)['now'=>1800000000]; $calls=(object)['items'=>[],'nextId'=>100];
    $db=new PDO('sqlite:'.$directory.'/test.sqlite',null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC]);
    $db->exec("CREATE TABLE orders(id TEXT PRIMARY KEY,number TEXT,status TEXT,created_at INTEGER,snapshot TEXT,original_request TEXT,staff_snapshot TEXT,version INTEGER DEFAULT 1,environment TEXT NOT NULL DEFAULT 'production'); CREATE TABLE notifications(id TEXT PRIMARY KEY,order_id TEXT,channel TEXT,status TEXT,created_at INTEGER,attempts INTEGER DEFAULT 0);");
    $site=['public_origin'=>'https://cafe.example','telegram_clock'=>static fn(): int=>$clock->now];
    $app=compact('directory','clock','calls','db','site'); tgSaveConfig($app,$config??tgConfig());
    $send=$transport??static function(string $method,array $body)use($calls):array{$calls->items[]=compact('method','body');return ['ok'=>true,'result'=>['message_id'=>++$calls->nextId]];};
    $app['api']=new CafeTelegram($directory,$site,$db,$send); return $app;
}
function tgSigned(array $app,array $fields=[]): string {
    $fields+=['auth_date'=>(string)$app['clock']->now,'query_id'=>'AA+&fictional','user'=>json_encode(['id'=>100001,'first_name'=>'Тест <>& + 🍳'],JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES)];
    ksort($fields,SORT_STRING);$check=[];foreach($fields as$key=>$value)$check[]=$key.'='.$value;
    $secret=hash_hmac('sha256',tgConfig()['botToken'],'WebAppData',true);$fields['hash']=hash_hmac('sha256',implode("\n",$check),$secret);
    return http_build_query($fields,'','&',PHP_QUERY_RFC3986);
}
function tgUpdate(int $update,string $command='/start',int $user=100001,?int $chat=null,string $type='private'): array {return ['update_id'=>$update,'message'=>['from'=>['id'=>$user,'is_bot'=>false],'chat'=>['id'=>$chat??$user,'type'=>$type],'text'=>$command]];}
function tgHook(array $a,array $update): void {$a['api']->webhook(tgConfig()['webhookSecret'],$update);}
function tgStart(array $a,int $user=100001): void {tgHook($a,tgUpdate($user,'/start',$user));$a['api']->work();$a['calls']->items=[];}
function tgOrder(array $a,?array $value=null): array {
    $id=str_repeat('a',32);$order=$value??['id'=>$id,'version'=>1,'number'=>'TEST-1','status'=>'new','createdAt'=>'2027-01-15T08:00:00+03:00','currency'=>'RUB','items'=>[['id'=>'dish','name'=>'Яйцо <b>тест</b>','quantity'=>2,'unitPriceMinor'=>47025,'lineTotalMinor'=>94050]],'subtotalMinor'=>94050,'deliveryFeeMinor'=>null,'totalMinor'=>null,
        'contact'=>['name'=>'Вымышленный гость','phone'=>'+70000000000'],'fulfilment'=>['type'=>'delivery','timing'=>'asap','requestedAt'=>null,'confirmedAt'=>null,'address'=>['city'=>'Тестовый город','streetHouse'=>'Не настоящий адрес'],'courierInstructions'=>'Тестовый вход'],
        'orderComment'=>'<a href="https://bad.example">НЕ ссылка</a>','staffNote'=>'SECRET_INTERNAL_NOTE','assignee'=>null];
    $s=$a['db']->prepare('INSERT INTO orders(id,number,status,created_at,snapshot,original_request,staff_snapshot,version) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET staff_snapshot=excluded.staff_snapshot,version=excluded.version,status=excluded.status');
    $s->execute([$id,$order['number'],$order['status'],$a['clock']->now,json_encode($order),json_encode(['contact'=>$order['contact'],'orderComment'=>$order['orderComment']]),json_encode($order),$order['version']]);
    $s=$a['db']->prepare('INSERT INTO notifications VALUES(?,?,NULL,\'pending\',?,0)');$s->execute([bin2hex(random_bytes(16)),$id,$a['clock']->now]);return $order;
}
function tgCount(array $a,string $table): int{return (int)$a['db']->query('SELECT COUNT(*) FROM '.$table)->fetchColumn();}
function tgClean(string $path): void {foreach(new RecursiveIteratorIterator(new RecursiveDirectoryIterator($path,FilesystemIterator::SKIP_DOTS),RecursiveIteratorIterator::CHILD_FIRST)as$file){$file->isDir()?rmdir($file->getPathname()):unlink($file->getPathname());}rmdir($path);}

try {
    tgTest('Telegram HMAC preserves raw decoded values and excludes only hash',function():void{
        $a=tgFixture();$raw=tgSigned($a,['signature'=>'test_ed25519_field_+']);tgCheck(CafeTelegram::verifyInitData($raw,tgConfig()['botToken'],$a['clock']->now)==='100001');
        tgError(fn()=>CafeTelegram::verifyInitData(str_replace('AA%2B','AB%2B',$raw),tgConfig()['botToken'],$a['clock']->now),'telegram_auth',401);
        tgError(fn()=>CafeTelegram::verifyInitData($raw,str_replace('A','B',tgConfig()['botToken']),$a['clock']->now),'telegram_auth');
    });
    tgTest('strict launch parser rejects ambiguity, malformed encoding and stale/future data',function():void{
        $a=tgFixture();$raw=tgSigned($a);
        foreach([$raw.'&user=%7B%7D',$raw.'&%75ser=%7B%7D',$raw.'&hash='.str_repeat('a',64),$raw.'&bad',$raw.'&',$raw.'&extra=%Q0',$raw.'&extra=%00',$raw.'&extra=%0A',str_repeat('x',17000),'']as$bad)tgError(fn()=>CafeTelegram::verifyInitData($bad,tgConfig()['botToken'],$a['clock']->now),'telegram_auth');
        foreach([-301,31]as$offset)tgError(fn()=>CafeTelegram::verifyInitData(tgSigned($a,['auth_date'=>(string)($a['clock']->now+$offset)]),tgConfig()['botToken'],$a['clock']->now),'telegram_auth');
        foreach([-300,30]as$offset)tgCheck(CafeTelegram::verifyInitData(tgSigned($a,['auth_date'=>(string)($a['clock']->now+$offset)]),tgConfig()['botToken'],$a['clock']->now)==='100001');
        foreach([['id'=>1.5],['id'=>100001,'is_bot'=>true],['id'=>0]]as$user)tgError(fn()=>CafeTelegram::verifyInitData(tgSigned($a,['user'=>json_encode($user)]),tgConfig()['botToken'],$a['clock']->now),'telegram_auth');
    });
    tgTest('opaque sessions store only a hash and recheck active numeric staff every request',function():void{
        $a=tgFixture();$raw=tgSigned($a);$auth=$a['api']->authenticate($raw,'peer');tgCheck(preg_match('/^[a-f0-9]{64}$/D',$auth['token'])===1);tgCheck($auth['staff']['role']==='manager');
        $row=$a['db']->query('SELECT * FROM telegram_sessions')->fetch();tgCheck($row['token_hash']===hash('sha256',$auth['token']));tgCheck(!str_contains(json_encode($row),$auth['token'])&&!str_contains(json_encode($row),$raw));
        $config=tgConfig();$config['staff'][0]['name']='Новое имя';$config['staff'][0]['role']='employee';tgSaveConfig($a,$config);tgCheck($a['api']->session($auth['token'])['name']==='Новое имя');tgCheck($a['api']->session($auth['token'])['role']==='employee');
        $config['staff'][0]['active']=false;tgSaveConfig($a,$config);tgError(fn()=>$a['api']->session($auth['token']),'staff_denied',403);tgCheck($a['api']->staffMember('100001')===null);
        tgError(fn()=>$a['api']->authenticate($raw,'peer'),'staff_denied');
    });
    tgTest('username cannot enroll, session expiry/logout and bot rotation revoke tokens',function():void{
        $a=tgFixture();tgError(fn()=>$a['api']->authenticate(tgSigned($a,['user'=>json_encode(['id'=>999999,'username'=>'boo_katan'])])),'staff_denied');
        $auth=$a['api']->authenticate(tgSigned($a));$a['clock']->now+=7200;tgError(fn()=>$a['api']->session($auth['token']),'session_expired');
        $auth=$a['api']->authenticate(tgSigned($a));$a['api']->logout($auth['token']);tgError(fn()=>$a['api']->session($auth['token']),'session_expired');
        $auth=$a['api']->authenticate(tgSigned($a));$config=tgConfig();$config['botToken']='123456789:'.str_repeat('C',35);tgSaveConfig($a,$config);tgError(fn()=>$a['api']->session($auth['token']),'session_expired');
    });
    tgTest('login attempts are persisted and bounded, disabled configuration is fail closed',function():void{
        $a=tgFixture();for($n=0;$n<30;$n++)tgError(fn()=>$a['api']->authenticate('bad','one-peer'),'telegram_auth');tgError(fn()=>$a['api']->authenticate(tgSigned($a),'one-peer'),'rate_limited',429);
        $a['clock']->now+=300;tgCheck(isset($a['api']->authenticate(tgSigned($a),'one-peer')['token']));$c=tgConfig();$c['enabled']=false;tgSaveConfig($a,$c);tgError(fn()=>$a['api']->authenticate(tgSigned($a)),'telegram_disabled',503);tgCheck($a['api']->work()===['enabled'=>false,'processed'=>0]);
    });
    tgTest('HTTPS and exact same-origin mutation policy has only explicit loopback development exception',function():void{
        $a=tgFixture();$a['api']->checkRequestSecurity('https://cafe.example','same-origin',true,'203.0.113.1',true);
        tgError(fn()=>$a['api']->checkRequestSecurity('https://cafe.example','same-origin',false,'127.0.0.1',true),'https_required');
        foreach([['https://evil.example','cross-site'],[null,null],['https://cafe.example','same-site']]as[$origin,$site])tgError(fn()=>$a['api']->checkRequestSecurity($origin,$site,true,'127.0.0.1',true),'origin');
        $dev=new CafeTelegram($a['directory'],['public_origin'=>'http://127.0.0.1:4444','allow_http_dev'=>true],$a['db'],fn()=>[]);$dev->checkRequestSecurity('http://127.0.0.1:4444','same-origin',false,'127.0.0.1',true);tgError(fn()=>$dev->checkRequestSecurity('http://127.0.0.1:4444','same-origin',false,'203.0.113.1',true),'https_required');
    });
    tgTest('webhook authenticates before queuing, deduplicates update ID and does not call network',function():void{
        $a=tgFixture();tgError(fn()=>$a['api']->webhook('wrong',tgUpdate(1)),'webhook_secret',403);tgHook($a,tgUpdate(1));tgHook($a,tgUpdate(1));tgCheck(tgCount($a,'telegram_updates')===1);tgCheck($a['calls']->items===[]);$a['api']->work();tgCheck(count($a['calls']->items)===1);tgCheck(tgCount($a,'telegram_chats')===1);$a['api']->work();tgCheck(count($a['calls']->items)===1);
        $button=$a['calls']->items[0]['body']['reply_markup']['inline_keyboard'][0][0];tgCheck($button['web_app']['url']==='https://cafe.example/staff.html');
    });
    tgTest('outsiders can only learn their own ID and never register or see order data',function():void{
        $a=tgFixture();tgHook($a,tgUpdate(1,'/start',999999));tgHook($a,tgUpdate(2,'/id',999999));tgHook($a,tgUpdate(3,'/start',100001,100002));tgHook($a,tgUpdate(4,'/start@different_bot',100001));$a['api']->work();
        tgCheck(count($a['calls']->items)===2);tgCheck(str_starts_with($a['calls']->items[0]['body']['text'],'Доступ только для сотрудников'));tgCheck(str_contains($a['calls']->items[1]['body']['text'],'999999'));tgCheck(!isset($a['calls']->items[0]['body']['reply_markup']));tgCheck(tgCount($a,'telegram_chats')===0);
    });
    tgTest('new notification is durable, safely escaped, linked to opaque ID and sent once',function():void{
        $a=tgFixture();tgStart($a);$order=tgOrder($a);$a['api']->work();tgCheck(count($a['calls']->items)===1);$body=$a['calls']->items[0]['body'];tgCheck(str_contains($body['text'],'+70000000000'));tgCheck(str_contains($body['text'],'&lt;a href=')&&!str_contains($body['text'],'<a '));tgCheck(str_contains($body['text'],'после подтверждения'));tgCheck(!str_contains($body['text'],'SECRET_INTERNAL_NOTE'));tgCheck(str_ends_with($body['reply_markup']['inline_keyboard'][0][0]['web_app']['url'],'?order='.$order['id']));
        $row=$a['db']->query('SELECT * FROM telegram_messages')->fetch();tgCheck($row['status']==='sent'&&(int)$row['message_id']>0);$a['api']->work();tgCheck(count($a['calls']->items)===1);
    });
    tgTest('edits read the current order instead of the original queued notification',function():void{
        $a=tgFixture();tgStart($a);$order=tgOrder($a);$a['api']->work();$firstId=(int)$a['db']->query('SELECT message_id FROM telegram_messages')->fetchColumn();$order['version']=2;$order['status']='accepted';$order['contact']['phone']='+71111111111';$order['fulfilment']['confirmedAt']='2027-01-15T12:00:00+03:00';$order['deliveryFeeMinor']=10000;$order['totalMinor']=104050;tgOrder($a,$order);$a['api']->work();tgCheck(count($a['calls']->items)===2);$call=$a['calls']->items[1];tgCheck($call['method']==='editMessageText');tgCheck(str_contains($call['body']['text'],'Принят')&&str_contains($call['body']['text'],'+71111111111'));tgCheck(!str_contains($call['body']['text'],'+70000000000'));tgCheck($call['body']['message_id']===$firstId);
    });
    tgTest('group notifications contain no guest contact/address/comment and use URL Mini App buttons',function():void{
        $c=tgConfig();$c['notifications']=['mode'=>'group','groupChatId'=>'-100123456789','miniAppName'=>''];$a=tgFixture(null,$c);tgOrder($a);$a['api']->work();$body=$a['calls']->items[0]['body'];foreach(['+70000000000','Тестовый город','Не настоящий адрес','НЕ ссылка','Вымышленный гость','SECRET_INTERNAL_NOTE']as$secret)tgCheck(!str_contains($body['text'],$secret));$button=$body['reply_markup']['inline_keyboard'][0][0];tgCheck(!isset($button['web_app'])&&$button['url']==='https://t.me/vosem_utra_bot?startapp=order_'.str_repeat('a',32));
    });
    tgTest('revoking staff prevents queued notification delivery and diagnostics rechecks manager role',function():void{
        $a=tgFixture();tgStart($a);tgOrder($a);$c=tgConfig();$c['staff'][0]['active']=false;tgSaveConfig($a,$c);$a['api']->work();tgCheck($a['calls']->items===[]);tgError(fn()=>$a['api']->diagnostics(['id'=>'100001','role'=>'manager']),'manager_required');tgError(fn()=>$a['api']->diagnostics(['id'=>'100002','role'=>'manager']),'manager_required');
    });
    tgTest('429 respects retry_after and private retry reads fresh snapshot',function():void{
        $calls=[];$fail=false;$transport=function($method,$body)use(&$calls,&$fail){$calls[]=compact('method','body');if($fail){$fail=false;return ['ok'=>false,'error_code'=>429,'parameters'=>['retry_after'=>90]];}return ['ok'=>true,'result'=>['message_id'=>101]];};$a=tgFixture($transport);tgStart($a);$calls=[];$fail=true;$order=tgOrder($a);$a['api']->work();tgCheck(count($calls)===1);$a['clock']->now+=89;$a['api']->work();tgCheck(count($calls)===1);$order['version']=2;$order['contact']['phone']='+72222222222';tgOrder($a,$order);$a['clock']->now++;$a['api']->work();tgCheck(count($calls)===2&&str_contains($calls[1]['body']['text'],'+72222222222'));
    });
    tgTest('network failure is persisted safely and manager can retry without creating a new order',function():void{
        $fail=false;$a=tgFixture(function()use(&$fail){if($fail)throw new RuntimeException('Sensitive transport details should never persist');return ['ok'=>true,'result'=>['message_id'=>101]];});tgStart($a);tgOrder($a);$fail=true;for($n=0;$n<8;$n++){$a['api']->work();$a['clock']->now+=4000;}$diag=$a['api']->diagnostics(['id'=>'100001']);tgCheck(count($diag['failures'])===1);$failure=$diag['failures'][0];tgCheck($failure['status']==='failed'&&$failure['error']==='network_unknown');tgCheck(!str_contains(json_encode($diag),'Sensitive'));$a['api']->retryNotification(['id'=>'100001'],(int)$failure['id']);$fail=false;$a['api']->work();tgCheck(tgCount($a,'orders')===1);tgCheck($a['db']->query('SELECT status FROM telegram_messages')->fetchColumn()==='sent');
    });
    tgTest('deleted message creates a replacement; unchanged edit is an acknowledged success',function():void{
        $response=null;$calls=[];$a=tgFixture(function($method,$body)use(&$response,&$calls){$calls[]=compact('method','body');if($response){$r=$response;$response=null;return$r;}return['ok'=>true,'result'=>['message_id'=>101+count($calls)]];});tgStart($a);$calls=[];$o=tgOrder($a);$a['api']->work();$o['version']=2;$o['status']='processing';tgOrder($a,$o);$response=['ok'=>false,'error_code'=>400,'description'=>'Bad Request: message to edit not found'];$a['api']->work(1);tgCheck($a['db']->query('SELECT message_id FROM telegram_messages')->fetchColumn()===null);$a['api']->work();tgCheck(end($calls)['method']==='sendMessage');$o['version']=3;$o['status']='accepted';tgOrder($a,$o);$response=['ok'=>false,'error_code'=>400,'description'=>'Bad Request: message is not modified'];$a['api']->work();tgCheck($a['db']->query('SELECT status FROM telegram_messages')->fetchColumn()==='sent');
    });
    tgTest('notification generation preserves an update queued during an in-flight send',function():void{
        $a=tgFixture();tgStart($a);$order=tgOrder($a);$calls=[];$second=new CafeTelegram($a['directory'],$a['site'],$a['db'],fn()=>throw new RuntimeException('Lease must prevent another send'));
        $first=new CafeTelegram($a['directory'],$a['site'],$a['db'],function($method,$body)use(&$calls,$a,$order,$second){$calls[]=compact('method','body');if(count($calls)===1){$fresh=$order;$fresh['version']=2;$fresh['status']='processing';tgOrder($a,$fresh);$second->work(1);}return['ok'=>true,'result'=>['message_id'=>123]];});
        $first->work(1);tgCheck(count($calls)===1&&$a['db']->query('SELECT status FROM telegram_messages')->fetchColumn()==='pending');$first->work();tgCheck(count($calls)===2&&$calls[1]['method']==='editMessageText'&&str_contains($calls[1]['body']['text'],'На согласовании'));
    });
    tgTest('UTF-16-safe notification bounds keep emoji text below Telegram message limit',function():void{
        $a=tgFixture();$o=tgOrder($a);$o['contact']['name']=str_repeat('😀',4000);$text=CafeTelegram::notificationText($o,true);$plain=html_entity_decode($text,ENT_QUOTES|ENT_HTML5,'UTF-8');preg_match_all('/./us',$plain,$chars);$units=0;foreach($chars[0]as$char)$units+=strlen($char)===4?2:1;tgCheck($units<=3500);
    });
    tgTest('operator setup is no-network by default and never returns secrets',function():void{
        $a=tgFixture();$plan=$a['api']->setup();tgCheck($a['calls']->items===[]&&$plan['applied']===false);tgCheck(!str_contains(json_encode($plan),tgConfig()['botToken'])&&!str_contains(json_encode($plan),tgConfig()['webhookSecret']));$result=$a['api']->setup(true);tgCheck($result['applied']===true&&count($a['calls']->items)===3);tgCheck($a['calls']->items[0]['method']==='setWebhook');tgCheck($a['calls']->items[0]['body']['secret_token']===tgConfig()['webhookSecret']);tgCheck($a['calls']->items[0]['body']['drop_pending_updates']===false);
    });
    tgTest('production and staging share no sessions, notifications or message queue claims',function():void{
        $a=tgFixture();tgStart($a);$prodAuth=$a['api']->authenticate(tgSigned($a));$order=tgOrder($a);$a['db']->exec("UPDATE orders SET environment='staging'");$a['api']->work();tgCheck($a['calls']->items===[]&&tgCount($a,'telegram_messages')===0);
        $staging=tgConfig();$staging['environment']='staging';$stageCalls=[];$site=$a['site']+['telegram_environment'=>'staging'];$stage=new CafeTelegram($a['directory'],$site,$a['db'],function($method,$body)use(&$stageCalls){$stageCalls[]=compact('method','body');return['ok'=>true,'result'=>['message_id'=>300]];},static fn():array=>$staging);
        tgError(fn()=>$stage->session($prodAuth['token']),'session_expired');$stage->webhook($staging['webhookSecret'],tgUpdate(900));$stage->work();tgCheck(count($stageCalls)===2);tgCheck(tgCount($a,'telegram_chats')===2);tgCheck($a['api']->diagnostics(['id'=>'100001'])['counts']===[]);
        $a['api']->work();tgCheck($a['calls']->items===[]);$mismatch=new CafeTelegram($a['directory'],$a['site'],$a['db'],fn()=>throw new RuntimeException('No network'),static fn():array=>$staging);tgError(fn()=>$mismatch->authenticate(tgSigned($a)),'telegram_disabled');
    });
    tgTest('new generation survives final retry failure with a fresh attempt budget',function():void{
        $a=tgFixture();tgStart($a);$order=tgOrder($a);$seed=new CafeTelegram($a['directory'],$a['site'],$a['db'],fn()=>throw new RuntimeException('mock unavailable'));$seed->work(1);$a['db']->exec("UPDATE telegram_messages SET attempts=7,next_attempt_at=0");
        $second=new CafeTelegram($a['directory'],$a['site'],$a['db'],fn()=>throw new RuntimeException('Lease should prevent this'));
        $api=new CafeTelegram($a['directory'],$a['site'],$a['db'],function()use($a,$order,$second){$o=$order;$o['version']=2;$o['status']='processing';tgOrder($a,$o);$second->work(1);throw new RuntimeException('old send fails');});$api->work(1);$row=$a['db']->query('SELECT status,attempts FROM telegram_messages')->fetch();tgCheck($row['status']==='pending'&&(int)$row['attempts']===0);
    });
    tgTest('real CafeOrders schema and CafeStaffOrders snapshots integrate without rebuilding or guest-data changes',function():void{
        $a=tgFixture();$site=$a['site']+['orders_clock'=>static fn():int=>$a['clock']->now];$config=CafeOrders::developmentConfig();$config['mode']='production';$config['termsApproved']=true;
        $orders=new CafeOrders($a['directory'],$site,static fn():array=>['revision'=>1,'items'=>[['id'=>'Test_Dish','name'=>'Тестовый омлет','price'=>470.25,'published'=>true,'availableForOrder'=>true]]],$config);
        $a['db']=$orders->connection();$send=function($method,$body)use($a){$a['calls']->items[]=compact('method','body');return['ok'=>true,'result'=>['message_id'=>++$a['calls']->nextId]];};
        $a['api']=new CafeTelegram($a['directory'],$site+['telegram_environment'=>$orders->environment()],$a['db'],$send);tgStart($a);
        $settings=$orders->settings(null,'test');$body=['items'=>[['id'=>'Test_Dish','quantity'=>1]],'fulfilment'=>['type'=>'pickup','timing'=>'asap','requestedAt'=>null,'address'=>null,'courierInstructions'=>''],'contact'=>['phone'=>'+70000000000','name'=>'Вымышленный гость'],'orderComment'=>'Тестовый комментарий','consent'=>['accepted'=>true,'version'=>$config['consent']['version']]];
        $quote=$orders->quote($body,$settings['_guestToken'],$settings['csrfToken'],'test')['quote'];$result=$orders->create($body+['quoteId'=>$quote['quoteId'],'idempotencyKey'=>str_repeat('d',32)],$settings['_guestToken'],$settings['csrfToken'],'test');$id=$a['db']->query('SELECT id FROM orders')->fetchColumn();$original=$a['db']->query('SELECT snapshot FROM orders')->fetchColumn();
        $a['api']->work();tgCheck(count($a['calls']->items)===1&&str_contains($a['calls']->items[0]['body']['text'],'+70000000000')&&str_contains($a['calls']->items[0]['body']['text'],'Тестовый комментарий'));
        $staff=new CafeStaffOrders($orders,[],fn($id)=>$a['api']->staffMember($id));$staff->command('claim',$id,['expectedVersion'=>1],$a['api']->staffMember('100001'));
        $api=new CafeTelegram($a['directory'],$site+['telegram_environment'=>$orders->environment()],$a['db'],$send,null,[$staff,'snapshotForNotification']);$api->work();tgCheck(count($a['calls']->items)===2&&$a['calls']->items[1]['method']==='editMessageText');tgCheck(str_contains($a['calls']->items[1]['body']['text'],'На согласовании')&&str_contains($a['calls']->items[1]['body']['text'],'Тестовый руководитель'));tgCheck($a['db']->query('SELECT snapshot FROM orders')->fetchColumn()===$original);
    });
    tgTest('CLI --plan on an isolated mock configuration performs no setup or order-database writes',function():void{
        $a=tgFixture();file_put_contents($a['directory'].'/admin-config.php',"<?php return ['publicOrigin'=>'https://cafe.example'];");$pipes=[];$process=proc_open([PHP_BINARY,__DIR__.'/../hosting/telegram-setup.php','--private-dir='.$a['directory'],'--plan'],[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']],$pipes);tgCheck(is_resource($process));fclose($pipes[0]);$out=stream_get_contents($pipes[1]);$err=stream_get_contents($pipes[2]);fclose($pipes[1]);fclose($pipes[2]);tgCheck(proc_close($process)===0,'Setup plan failed: '.$err);tgCheck(str_contains($out,'"applied": false'));tgCheck(!str_contains($out,tgConfig()['botToken'])&&!str_contains($out,tgConfig()['webhookSecret']));tgCheck(!is_dir($a['directory'].'/orders-data'));
    });
    tgTest('CLI plan honors explicit HTTPS staging override and loads the orders configuration class',function():void{
        $c=tgConfig();$c['environment']='staging';$a=tgFixture(null,$c);file_put_contents($a['directory'].'/admin-config.php',"<?php return ['publicOrigin'=>'https://stage.cafe.example','orders_environment'=>'staging'];");file_put_contents($a['directory'].'/orders-config.php',"<?php return array_replace(CafeOrders::developmentConfig(), ['mode'=>'production']);");
        $pipes=[];$process=proc_open([PHP_BINARY,__DIR__.'/../hosting/telegram-setup.php','--private-dir='.$a['directory'],'--plan'],[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']],$pipes);tgCheck(is_resource($process));fclose($pipes[0]);$out=stream_get_contents($pipes[1]);$err=stream_get_contents($pipes[2]);fclose($pipes[1]);fclose($pipes[2]);tgCheck(proc_close($process)===0,'Staging setup plan failed: '.$err);tgCheck(str_contains($out,'"environment": "staging"')&&str_contains($out,'https://stage.cafe.example/api/telegram/webhook'));tgCheck(!is_dir($a['directory'].'/orders-data'));
    });
    tgTest('separate workers acquire one notification lease and recover an expired lease',function():void{
        $a=tgFixture();tgStart($a);tgOrder($a);$input=$a['directory'].'/worker.json';file_put_contents($input,json_encode(['directory'=>$a['directory'],'now'=>$a['clock']->now]));$running=[];
        for($n=0;$n<4;$n++){$pipes=[];$process=proc_open([PHP_BINARY,__DIR__.'/php-telegram-worker.php',$input],[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']],$pipes);tgCheck(is_resource($process));fclose($pipes[0]);$running[]=[$process,$pipes];}
        foreach($running as[$process,$pipes]){$stdout=stream_get_contents($pipes[1]);$stderr=stream_get_contents($pipes[2]);fclose($pipes[1]);fclose($pipes[2]);tgCheck(proc_close($process)===0,'Worker failed: '.$stdout.$stderr);}
        $log=file($a['directory'].'/calls.log',FILE_IGNORE_NEW_LINES);tgCheck(count($log)===1);tgCheck($a['db']->query('SELECT status FROM telegram_messages')->fetchColumn()==='sent');
        $a['db']->exec("UPDATE telegram_messages SET status='sending',lease_token='dead',lease_until=0,message_id=NULL,sent_hash=NULL");$a['api']->work();tgCheck(count($a['calls']->items)===1&&$a['db']->query('SELECT status FROM telegram_messages')->fetchColumn()==='sent');
    });
    echo "{$passed} PHP Telegram tests passed. No real network calls.\n";
} finally {gc_collect_cycles();foreach($directories as$directory)tgClean($directory);}
