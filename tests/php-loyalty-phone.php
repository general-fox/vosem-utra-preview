<?php
declare(strict_types=1);
require dirname(__DIR__).'/hosting/php/loyalty-phone.php';
function phoneAssert(bool $ok,string $message):void { if(!$ok) throw new RuntimeException($message); }
function phoneReject(callable $fn,string $reason):void {
    try { $fn(); } catch(LoyaltyPhoneError $e) { phoneAssert($e->reason===$reason,'Expected '.$reason.', got '.$e->reason); return; }
    throw new RuntimeException('Expected rejection '.$reason);
}
$root=dirname(__DIR__).'/.php-preview/phone-'.bin2hex(random_bytes(6)); mkdir($root,0700,true);
$config=['apiKey'=>'fixture-only-flashcall-key','publicOrigin'=>'https://test888.ru','dailyCallLimit'=>10,'testOnly'=>true];
$caller='+70000000001'; $destination='+70000000002'; $passed=[];
$fixture=function(string $name,array $patch=[])use($root,$config,$caller,$destination):array {
    $state=(object)['now'=>100000,'calls'=>[],'status'=>'PENDING','failStart'=>false,'failStatus'=>false,'providerId'=>null,'statusPatch'=>[],'caller'=>$caller];
    $transport=function(array $settings,string $method,array $body)use($state,$destination):array {
        phoneAssert(in_array($method,['get-phone','status'],true),'Only documented incoming-call methods are used');
        $state->calls[]=[$method,$body];
        if($method==='get-phone') {
            phoneAssert(array_keys($body)===['phone'],'No code, profile fields or credentials in the request body');
            if($state->failStart) throw new LoyaltyPhoneTransportError('fixture lost reply');
            $state->caller=$body['phone'];
            return ['id'=>$state->providerId ?? 'fixture-'.count($state->calls),'phone'=>$destination,'expiresIn'=>60];
        }
        phoneAssert(array_keys($body)===['id'],'Polling needs only the provider request ID');
        if($state->failStatus) throw new LoyaltyPhoneTransportError('fixture lost status');
        return array_replace(['id'=>$body['id'],'callerPhone'=>$state->caller,'status'=>$state->status,'expiresIn'=>60],$state->statusPatch);
    };
    return [new LoyaltyPhone(array_replace($config,$patch),$root.'/'.$name,$transport,fn()=>$state->now),$state];
};
$run=function(string $name,callable $test)use(&$passed):void { $test(); $passed[]=$name; };
try {
    $run('FlashCall policy, origin and configuration fail closed without leaking settings',function()use($root,$config):void {
        file_put_contents($root.'/loyalty-phone-policy.php',"<?php return ['provider'=>'flashcall','required'=>true,'testOnly'=>true,'publicOrigin'=>'https://test888.ru'];");
        file_put_contents($root.'/flashcall-config.json',json_encode($config));
        $loaded=loyalty_phone_config($root,'https://test888.ru');
        phoneAssert($loaded['enabled'] && $loaded['provider']==='flashcall' && $loaded['testOnly'],'Valid FlashCall config');
        phoneReject(fn()=>loyalty_phone_config($root,'https://vosem-utra.ru'),'phone_config_origin');
        rename($root.'/flashcall-config.json',$root.'/flashcall-config.example.json');
        phoneReject(fn()=>loyalty_phone_config($root,'https://test888.ru'),'phone_config_missing');
        rename($root.'/flashcall-config.example.json',$root.'/flashcall-config.json');
        file_put_contents($root.'/flashcall-config.json',"\xEF\xBB\xBF".json_encode($config));
        phoneAssert(loyalty_phone_config($root,'https://test888.ru')['enabled'],'UTF-8 BOM supported');
        foreach([['apiKey','short','phone_config_key'],['apiKey',"fixture secret",'phone_config_key'],['dailyCallLimit','10','phone_config_limit'],['dailyCallLimit',-1,'phone_config_limit']] as [$key,$value,$reason]) {
            file_put_contents($root.'/flashcall-config.json',json_encode(array_replace($config,[$key=>$value])));
            phoneReject(fn()=>loyalty_phone_config($root,'https://test888.ru'),$reason);
        }
        file_put_contents($root.'/flashcall-config.json','{"apiKey":"'.$config['apiKey'].'",}');
        try { loyalty_phone_config($root,'https://test888.ru'); throw new RuntimeException('Malformed JSON accepted'); }
        catch(LoyaltyPhoneError $e) { phoneAssert($e->reason==='phone_config_json' && !str_contains($e->getMessage(),$config['apiKey']),'No secret in diagnostics'); }
        file_put_contents($root.'/flashcall-config.json',json_encode($config));
        file_put_contents($root.'/loyalty-phone-policy.php',"<?php return ['provider'=>'ucaller','testOnly'=>true,'publicOrigin'=>'https://test888.ru'];");
        phoneReject(fn()=>loyalty_phone_config($root,'https://test888.ru'),'phone_config_policy');
    });
    $run('HTTP 201 is accepted and provider errors never expose response bodies',function()use($config):void {
        phoneAssert(loyalty_flashcall_response('{"id":"fixture"}',201,0)===['id'=>'fixture'],'get-phone returns 201 Created');
        foreach([401=>'provider_access',403=>'provider_access',404=>'provider_access',400=>'provider_rejected',429=>'provider_rate_limit'] as $status=>$reason) {
            try { loyalty_flashcall_response($config['apiKey'],$status,0); throw new RuntimeException('Provider failure accepted'); }
            catch(LoyaltyPhoneError $e) { phoneAssert($e->reason===$reason && !str_contains($e->getMessage(),$config['apiKey']),'Safe provider error'); if($status===429) phoneAssert($e->retryAfter===60,'Bounded retry'); }
        }
        foreach([[false,0,28],['<html>'.$config['apiKey'].'</html>',200,0],['[]',200,0],['{}',500,0],[str_repeat('x',65537),200,0]] as [$raw,$status,$error]) {
            try { loyalty_flashcall_response($raw,$status,$error); throw new RuntimeException('Transport failure accepted'); }
            catch(LoyaltyPhoneTransportError $e) { phoneAssert(!str_contains($e->getMessage(),$config['apiKey']),'No response/secret in transport error'); }
        }
        phoneAssert(!method_exists(LoyaltyPhone::class,'verify'),'There is no four-digit verification bypass');
    });
    $run('incoming verification is session-bound, polled, and consumed exactly once',function()use($fixture,$caller,$destination,$config):void {
        [$phone,$state]=$fixture('verification'); $session=[];
        phoneReject(fn()=>$phone->requireVerified($session,$caller),'phone_confirmation_required');
        $started=$phone->start($session,$caller,'fixture-ip');
        phoneAssert($started['method']==='incoming' && $started['phoneToCall']===$destination && $started['expiresIn']===60 && $started['retryAfter']===60,'Incoming-call public state');
        phoneAssert(!isset($started['code']) && !isset($started['providerId']) && !str_contains(json_encode($session),$config['apiKey']),'No code/provider token/secret leak');
        phoneAssert($phone->start($session,$caller,'fixture-ip',true)===$started && count($state->calls)===1,'Start/resend during an issued check never calls twice');
        $other=[];
        phoneReject(function()use($phone,&$other,$caller,$started){$phone->status($other,$caller,$started['challengeId'],'fixture-ip');},'phone_session');
        phoneReject(function()use($phone,&$session,$started){$phone->status($session,'+70000000003',$started['challengeId'],'fixture-ip');},'phone_session');
        $waiting=$phone->status($session,$caller,$started['challengeId'],'fixture-ip');
        phoneAssert(!$waiting['verified'] && $waiting['state']==='waiting','Pending does not authenticate');
        $phone->status($session,$caller,$started['challengeId'],'fixture-ip'); phoneAssert(count($state->calls)===2,'Poll throttled for two seconds');
        $state->now+=2; $state->status='CONFIRMED';
        $verified=$phone->status($session,$caller,$started['challengeId'],'fixture-ip');
        phoneAssert($verified['verified'] && $verified['proofExpiresIn']===300 && $verified['phoneToCall']==='','Provider confirmation establishes proof');
        $phone->requireVerified($session,$caller); $copied=$session; $phone->consume($session,$caller);
        phoneReject(fn()=>$phone->requireVerified($session,$caller),'phone_confirmation_required');
        phoneReject(fn()=>$phone->requireVerified($copied,$caller),'phone_already_claimed');
    });
    $run('provider IDs cannot be claimed by another session and caller mismatches never verify',function()use($fixture,$caller):void {
        [$phone,$state]=$fixture('claims'); $state->providerId='same-provider-check'; $session=[];
        $started=$phone->start($session,$caller,'fixture-ip'); $state->now+=61; $other=[];
        $claimed=$phone->start($other,$caller,'fixture-ip'); phoneAssert($claimed['state']==='failed' && !$claimed['verified'],'Duplicate provider ID rejected');
        $state->status='CONFIRMED'; $state->statusPatch=['callerPhone'=>'+70000000004'];
        $wrong=$phone->status($session,$caller,$started['challengeId'],'fixture-ip');
        phoneAssert(!$wrong['verified'] && $wrong['state']==='failed','Wrong caller cannot establish proof after timer');
        phoneReject(fn()=>$phone->requireVerified($session,$caller),'phone_confirmation_required');
    });
    $run('unknown requests require explicit retry and expired results cannot register',function()use($fixture,$caller):void {
        [$phone,$state]=$fixture('unknown'); $state->failStart=true; $session=[];
        $unknown=$phone->start($session,$caller,'fixture-ip'); phoneAssert($unknown['state']==='unknown' && $unknown['phoneToCall']==='','Lost reply is not success');
        $state->now+=61; $phone->start($session,$caller,'fixture-ip'); phoneAssert(count($state->calls)===1,'No silent retry of unknown request');
        $state->failStart=false; $retry=$phone->start($session,$caller,'fixture-ip',true);
        phoneAssert($retry['state']==='waiting' && $retry['challengeId']!==$unknown['challengeId'] && count($state->calls)===2,'Explicit retry starts a new bounded challenge');
        $state->now+=361; $state->status='CONFIRMED'; $expired=$phone->status($session,$caller,$retry['challengeId'],'fixture-ip');
        phoneAssert($expired['state']==='expired' && count($state->calls)===2,'Too-late callback is not polled or trusted');
        phoneReject(fn()=>$phone->requireVerified($session,$caller),'phone_confirmation_required');
    });
    $run('returning from a dialler may confirm after 60 seconds but proof expires at the hard deadline',function()use($fixture,$caller):void {
        [$phone,$state]=$fixture('returning'); $session=[]; $started=$phone->start($session,$caller,'fixture-ip');
        $state->now+=100; $state->status='CONFIRMED'; $verified=$phone->status($session,$caller,$started['challengeId'],'fixture-ip');
        phoneAssert($verified['verified'] && $verified['proofExpiresIn']===260,'Bound proof by original expiry + 300 seconds');
        $state->now+=260; phoneReject(fn()=>$phone->requireVerified($session,$caller),'phone_confirmation_required');
        phoneAssert(!$phone->status($session,$caller,$started['challengeId'],'fixture-ip')['verified'],'Expired proof public state');
    });
    $run('phone and shared budget limits survive fresh sessions; zero disables only the daily cap',function()use($fixture,$caller):void {
        [$phone,$state]=$fixture('rates',['dailyCallLimit'=>0]); $session=[]; $phone->start($session,$caller,'fixture-ip'); $fresh=[];
        phoneReject(function()use($phone,&$fresh,$caller){$phone->start($fresh,$caller,'fixture-ip');},'phone_rate_limit');
        for($i=1;$i<5;$i++) { $state->now+=61; $fresh=[]; $phone->start($fresh,$caller,'fixture-ip'); }
        $state->now+=61; $fresh=[]; phoneReject(function()use($phone,&$fresh,$caller){$phone->start($fresh,$caller,'fixture-ip');},'phone_rate_limit');
        phoneAssert(count($state->calls)===5,'Hourly calls bounded without daily cap');
        [$budget,$budgetState]=$fixture('budget',['dailyCallLimit'=>1]); $a=[]; $budget->start($a,$caller,'fixture-a'); $b=[];
        phoneReject(function()use($budget,&$b){$budget->start($b,'+70000000003','fixture-b');},'phone_budget_exhausted');
        phoneAssert(count($budgetState->calls)===1,'No provider request beyond site budget');
    });
    $run('a staging proof cannot authorize production even with the same provider key',function()use($fixture,$caller):void {
        [$phone,$state]=$fixture('scope'); $session=[]; $started=$phone->start($session,$caller,'fixture-ip'); $state->status='CONFIRMED';
        $phone->status($session,$caller,$started['challengeId'],'fixture-ip');
        [$production]=$fixture('scope',['publicOrigin'=>'https://vosem-utra.ru','testOnly'=>false]);
        phoneReject(fn()=>$production->requireVerified($session,$caller),'phone_confirmation_required');
    });
} finally {
    gc_collect_cycles();
    $resolved=realpath($root); $allowed=realpath(dirname(__DIR__).'/.php-preview');
    if($resolved&&$allowed&&str_starts_with(strtolower($resolved),strtolower($allowed.DIRECTORY_SEPARATOR))) {
        $entries=new RecursiveIteratorIterator(new RecursiveDirectoryIterator($resolved,FilesystemIterator::SKIP_DOTS),RecursiveIteratorIterator::CHILD_FIRST);
        foreach($entries as $entry) { if($entry->isDir()&&!$entry->isLink()) rmdir($entry->getPathname()); else unlink($entry->getPathname()); } rmdir($resolved);
    }
}
foreach($passed as $name) echo 'PASS '.$name.PHP_EOL;
echo count($passed).' FlashCall verification groups passed. Only injected mock transports; no network calls.'.PHP_EOL;
