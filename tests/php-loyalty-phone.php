<?php
declare(strict_types=1);
require dirname(__DIR__).'/hosting/php/loyalty-phone.php';
function phoneAssert(bool $ok,string $message):void {if(!$ok)throw new RuntimeException($message);}
function phoneReject(callable $fn,string $reason):void {try{$fn();}catch(LoyaltyPhoneError $e){phoneAssert($e->reason===$reason,'Expected '.$reason.', got '.$e->reason);return;}throw new RuntimeException('Expected rejection '.$reason);}
$root=dirname(__DIR__).'/.php-preview/phone-'.bin2hex(random_bytes(6));mkdir($root,0700,true);
$config=['serviceId'=>'123','secretKey'=>str_repeat('fixture-only-',4),'mode'=>'test','trustedPhone'=>'79990000001','publicOrigin'=>'https://test888.ru','dailyCallLimit'=>10];
$clock=100000;$calls=[];$fail=false;
$transport=function(array $c,string $method,array $body)use(&$calls,&$fail):array{
    phoneAssert($method==='initCall','Only initCall is used');$calls[]=$body;
    if($fail)throw new RuntimeException('simulated lost response');
    return ['status'=>true,'ucaller_id'=>count($calls),'code'=>$body['code']];
};
$passed=[];
try {
    file_put_contents($root.'/ucaller-config.json',json_encode($config));
    file_put_contents($root.'/loyalty-phone-policy.php',"<?php return ['required'=>true,'testOnly'=>true,'publicOrigin'=>'https://test888.ru'];");
    phoneAssert(loyalty_phone_config($root,'https://test888.ru')['enabled'],'Valid config');
    phoneReject(fn()=>loyalty_phone_config($root,'https://vosem-utra.ru'),'phone_config_origin');
    rename($root.'/ucaller-config.json',$root.'/ucaller-config.example.json');phoneReject(fn()=>loyalty_phone_config($root,'https://test888.ru'),'phone_config_missing');rename($root.'/ucaller-config.example.json',$root.'/ucaller-config.json');
    $passed[]='required config fails closed and stays bound to the staging origin';
    file_put_contents($root.'/ucaller-config.json',"\xEF\xBB\xBF".json_encode($config));
    phoneAssert(loyalty_phone_config($root,'https://test888.ru')['enabled'],'Windows UTF-8 BOM is supported');
    foreach ([['serviceId','', 'phone_config_service'],['secretKey','', 'phone_config_secret'],['trustedPhone','', 'phone_config_phone'],['mode','live', 'phone_config_mode'],['dailyCallLimit','10', 'phone_config_limit']] as [$field,$value,$reason]) {
        file_put_contents($root.'/ucaller-config.json',json_encode(array_replace($config,[$field=>$value])));
        phoneReject(fn()=>loyalty_phone_config($root,'https://test888.ru'),$reason);
    }
    file_put_contents($root.'/ucaller-config.json','{"secretKey":"'. $config['secretKey'] .'",}');
    try { loyalty_phone_config($root,'https://test888.ru'); throw new RuntimeException('Malformed JSON was accepted'); }
    catch (LoyaltyPhoneError $e) { phoneAssert($e->reason==='phone_config_json' && !str_contains($e->getMessage(),$config['secretKey']),'Malformed JSON diagnostics never disclose contents'); }
    file_put_contents($root.'/ucaller-config.json',json_encode($config));
    $passed[]='configuration errors identify the field without leaking secrets; example filenames are not active settings';
    foreach ([6=>'phone_dns',7=>'phone_connect',28=>'phone_timeout',60=>'phone_tls',77=>'phone_tls'] as $errno=>$reason) {
        try { loyalty_ucaller_response(false,0,$errno); throw new RuntimeException('Expected transport error'); }
        catch (LoyaltyPhoneTransportError $e) { phoneAssert($e->reason===$reason,'Transport diagnostics identify the failure'); }
    }
    phoneReject(fn()=>loyalty_ucaller_response(json_encode(['status'=>false,'code'=>1002,'error'=>$config['secretKey']]),200,0),'provider_1002');
    try { loyalty_ucaller_response(json_encode(['status'=>false,'code'=>401,'error'=>$config['secretKey']]),401,0); throw new RuntimeException('Expected provider error'); }
    catch (LoyaltyPhoneError $e) { phoneAssert($e->reason==='provider_401' && !str_contains($e->getMessage(),$config['secretKey']),'Provider response text never leaves the server'); }
    try { loyalty_ucaller_response('<html>'.$config['secretKey'].'</html>',200,0); throw new RuntimeException('Expected format error'); }
    catch (LoyaltyPhoneTransportError $e) { phoneAssert($e->reason==='phone_response' && !str_contains($e->getMessage(),$config['secretKey']),'Non-JSON bodies are not exposed'); }
    $checkCalls=[];$check=new LoyaltyPhone($config,$root,function(array $c,string $method,array $body)use(&$checkCalls){$checkCalls[]=[$method,$body];return ['status'=>true,'owner'=>'must-not-be-returned'];},function()use(&$clock){return $clock;});
    for($i=0;$i<3;$i++) { $health=$check->checkConnection('127.0.0.1'); phoneAssert($health['connected'] && $health['callsStarted']===0 && !isset($health['owner']),'Health check returns only a safe summary'); }
    phoneReject(fn()=>$check->checkConnection('127.0.0.1'),'phone_rate_limit');
    phoneAssert(count($checkCalls)===3 && $checkCalls[0]===['getService',[]],'Diagnostic cannot initiate a call or transmit a phone');
    $passed[]='safe transport/provider diagnostics and rate-limited read-only connection checks';
    $phone=new LoyaltyPhone($config,$root,$transport,function()use(&$clock){return $clock;});$session=[];
    phoneReject(fn()=>$phone->requireVerified($session,$config['trustedPhone']),'phone_confirmation_required');
    phoneReject(function()use($phone,&$session){$phone->start($session,'79990000002','127.0.0.1');},'test_number_only');phoneAssert(count($calls)===0,'Untrusted number never leaves server');
    $started=$phone->start($session,$config['trustedPhone'],'127.0.0.1');$code=$calls[0]['code'];
    phoneAssert(is_int($calls[0]['phone']) || is_float($calls[0]['phone']),'uCaller requires a numeric phone field; the code remains a string');
    phoneAssert(!isset($started['code'])&&!str_contains(json_encode($session),$config['secretKey']),'Secrets never in session or public state');
    phoneAssert($started['expiresIn']===300&&$started['retryAfter']===60,'Independent expiry and resend');
    phoneAssert($phone->start($session,$config['trustedPhone'],'127.0.0.1')===$started&&count($calls)===1,'Double click must not call twice');
    phoneReject(function()use($phone,&$session,$config){$phone->start($session,$config['trustedPhone'],'127.0.0.1',true);},'phone_wait');
    $other=[];phoneReject(function()use($phone,&$other,$config,$started,$code){$phone->verify($other,$config['trustedPhone'],$started['challengeId'],$code,'127.0.0.1');},'phone_expired');
    $wrong=$code==='1234'?'4321':'1234';phoneReject(function()use($phone,&$session,$config,$started,$wrong){$phone->verify($session,$config['trustedPhone'],$started['challengeId'],$wrong,'127.0.0.1');},'phone_code_invalid');
    $verified=$phone->verify($session,$config['trustedPhone'],$started['challengeId'],$code,'127.0.0.1');phoneAssert($verified['verified'],'Code can be entered during resend cooldown');
    $phone->requireVerified($session,$config['trustedPhone']);$phone->consume($session,$config['trustedPhone']);
    phoneReject(fn()=>$phone->requireVerified($session,$config['trustedPhone']),'phone_confirmation_required');
    $passed[]='session-bound verification, no bypass, no code leak and single consumption';
    $clock+=301;$fail=true;$pending=$phone->start($session,$config['trustedPhone'],'127.0.0.1');$request=$calls[array_key_last($calls)];
    phoneAssert($pending['pending'],'Uncertain transport retains pending request');
    $clock+=61;$fail=false;$recovered=$phone->start($session,$config['trustedPhone'],'127.0.0.1',true);
    phoneAssert($calls[array_key_last($calls)]===$request&&!$recovered['pending'],'Recovery reuses exactly the same UUID, code and number');
    $phone->verify($session,$config['trustedPhone'],$recovered['challengeId'],$request['code'],'127.0.0.1');
    $clock+=301;phoneReject(fn()=>$phone->requireVerified($session,$config['trustedPhone']),'phone_confirmation_required');
    $passed[]='uncertain replies recover idempotently; expired confirmations cannot register';
    $locked=$phone->start($session,$config['trustedPhone'],'127.0.0.1');$code=$calls[array_key_last($calls)]['code'];$wrong=$code==='1234'?'4321':'1234';
    for($i=0;$i<5;$i++)phoneReject(function()use($phone,&$session,$config,$locked,$wrong){$phone->verify($session,$config['trustedPhone'],$locked['challengeId'],$wrong,'127.0.0.1');},'phone_code_invalid');
    phoneReject(function()use($phone,&$session,$config,$locked,$code){$phone->verify($session,$config['trustedPhone'],$locked['challengeId'],$code,'127.0.0.1');},'phone_expired');
    $newSession=[];phoneReject(function()use($phone,&$newSession,$config){$phone->start($newSession,$config['trustedPhone'],'127.0.0.1');},'phone_rate_limit');
    $clock+=61;$new=$phone->start($newSession,$config['trustedPhone'],'127.0.0.1');$code=$calls[array_key_last($calls)]['code'];
    phoneReject(function()use($phone,&$newSession,$config,$new,$code){$phone->verify($newSession,$config['trustedPhone'],$new['challengeId'],$code,'127.0.0.1');},'phone_rate_limit');
    $clock+=120;$phone->verify($newSession,$config['trustedPhone'],$new['challengeId'],$code,'127.0.0.1');
    $passed[]='shared call and guess limits survive session changes and recover after three minutes';
    $config['mode']='live';$config['publicOrigin']='https://vosem-utra.ru';$live=new LoyaltyPhone($config,$root,$transport,function()use(&$clock){return $clock;});
    phoneReject(fn()=>$live->checkConnection('127.0.0.1'),'not_found');
    phoneReject(function()use($live,&$session){$live->start($session,'79000000001','127.0.0.1');},'phone_error');
    phoneReject(fn()=>$live->requireVerified($newSession,'79990000001'),'phone_confirmation_required');
    $passed[]='live mode rejects simulator numbers and test-mode confirmations';
}finally{
    unset($phone,$live,$check);gc_collect_cycles();
    $resolved=realpath($root);$allowed=realpath(dirname(__DIR__).'/.php-preview');
    if($resolved&&$allowed&&str_starts_with(strtolower($resolved),strtolower($allowed.DIRECTORY_SEPARATOR))){$entries=new RecursiveIteratorIterator(new RecursiveDirectoryIterator($resolved,FilesystemIterator::SKIP_DOTS),RecursiveIteratorIterator::CHILD_FIRST);foreach($entries as $entry){if($entry->isDir()&&!$entry->isLink())rmdir($entry->getPathname());else unlink($entry->getPathname());}rmdir($resolved);}
}
foreach($passed as $name)echo 'PASS '.$name.PHP_EOL;
echo count($passed).' phone verification groups passed. No network calls.'.PHP_EOL;
