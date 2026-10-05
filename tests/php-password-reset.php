<?php
declare(strict_types=1);
require_once __DIR__.'/../hosting/php/auth.php';
require_once __DIR__.'/../hosting/php/password-reset-mail.php';
$roots = []; $count = 0; $hash = CafeAuth::hashPassword('old-test-password');
function ok(bool $condition, string $message='Assertion failed'): void { if (!$condition) throw new RuntimeException($message); }
function errorIs(callable $run, string $code): void {
    try { $run(); } catch (CafeAuthException $e) { ok($e->errorCode === $code, 'Unexpected error '.$e->errorCode); return; }
    throw new RuntimeException('Expected '.$code);
}
function fixture(bool $installed=true, bool $send=true): array {
    global $roots,$hash;
    $root = sys_get_temp_dir().'/cafe-reset-test-'.bin2hex(random_bytes(8)); mkdir($root,0700); $roots[]=$root;
    $clock=(object)['now'=>1800000000000]; $mail=(object)['messages'=>[]];
    $config=['public_origin'=>'https://cafe.example','encryption_key'=>str_repeat('45',32),
        'bootstrap_username'=>'owner@example.test','bootstrap_password_hash'=>$hash,
        'clock'=>fn()=>$clock->now,'password_reset_response_floor_ms'=>0,
        'password_reset_sender'=>function($to,$subject,$body) use ($mail,$send): bool { $mail->messages[]=compact('to','subject','body'); return $send; }];
    $auth=new CafeAuth($root.'/admin-data',$config);
    if($installed) $auth->installAccount(['version'=>1,'username'=>'owner@example.test','passwordHash'=>$hash,'credentialVersion'=>str_repeat('17',32),'totp'=>null,'recovery'=>[]]);
    return compact('root','clock','mail','config','auth');
}
function saved(array $f): array { return CafeStorage::readJson($f['root'].'/admin-data/auth-state.json'); }
function requestCode(array $f, string $email='owner@example.test'): array {
    $result=$f['auth']->requestPasswordReset(['email'=>$email], 'request-peer');
    $last=end($f['mail']->messages);
    preg_match('/пароля: ([0-9]{8})/', $last['body']??'', $match);
    return ['resetToken'=>$result['resetToken'],'code'=>$match[1]??''];
}
function grant(array $f): array { return $f['auth']->verifyPasswordReset(requestCode($f), 'verify-peer'); }
function test(string $name, callable $run): void { global $count; $run(); $count++; echo "PASS: $name\n"; }
function parallelReset(array $f, string $method, array $body): array {
    $config=$f['config']; unset($config['clock'],$config['password_reset_sender']); $jobs=[];
    for($i=0;$i<2;$i++) {
        $file=$f['root'].'/job'.$i.'.json';
        CafeStorage::atomicJson($file,['directory'=>$f['root'].'/admin-data','config'=>$config,'now'=>$f['clock']->now,'method'=>$method,'body'=>$body,'peer'=>'worker']);
        $process=proc_open([PHP_BINARY,__DIR__.'/php-auth-worker.php',$file],[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']],$pipes,null,null,['bypass_shell'=>true]);
        fclose($pipes[0]); $jobs[]=[$process,$pipes];
    }
    $statuses=[];
    foreach($jobs as [$process,$pipes]) { $out=stream_get_contents($pipes[1]);$err=stream_get_contents($pipes[2]);fclose($pipes[1]);fclose($pipes[2]);ok(proc_close($process)===0 && $err==='','Worker failed');$statuses[]=json_decode($out,true,16,JSON_THROW_ON_ERROR)['status']; }
    sort($statuses); return $statuses;
}
try {
    test('full reset preserves MFA, invalidates owner sessions/devices and leaves another admin unchanged', function() {
        global $hash; $f=fixture(); $auth=$f['auth'];
        $login=$auth->login(['username'=>'owner@example.test','password'=>'old-test-password'],'peer');
        $enroll=$auth->enrollStart(['challengeToken'=>$login['challengeToken'],'username'=>'owner@example.test'],'peer');
        $session=$auth->enrollConfirm(['enrollmentToken'=>$enroll['enrollmentToken'],'code'=>CafeAuth::totp($enroll['secret'],$f['clock']->now)],'peer');
        $auth->installAdditionalAccount(['version'=>1,'username'=>'other@example.test','passwordHash'=>$hash,'credentialVersion'=>str_repeat('29',32),'totp'=>null,'recovery'=>[]]);
        $before=saved($f); $g=grant($f);
        $result=$auth->completePasswordReset(['passwordToken'=>$g['passwordToken'],'password'=>'new-test-password','email'=>'other@example.test'],'peer');
        ok($result===['passwordChanged'=>true]);$after=saved($f);
        ok($before['account']['totp']===$after['account']['totp']);ok($before['account']['recovery']===$after['account']['recovery']);
        ok($before['accounts']===$after['accounts']);ok($after['devices']===[] && $after['sessions']===[] && $after['passwordResets']===[]);
        ok($auth->session($session['token'])===null);
        errorIs(fn()=>$auth->login(['username'=>'owner@example.test','password'=>'old-test-password'],'peer'),'invalid_credentials');
        $next=$auth->login(['username'=>'owner@example.test','password'=>'new-test-password'],'peer');ok(($next['mfaRequired']??false) && !isset($next['token']));
        errorIs(fn()=>$auth->completePasswordReset(['passwordToken'=>$g['passwordToken'],'password'=>'another-password'],'peer'),'invalid_reset');
        ok(count($f['mail']->messages)===2 && str_contains($f['mail']->messages[1]['subject'],'пароль изменён'));
    });
    test('unknown and bootstrap-only addresses get no email and indistinguishable response shape', function() {
        $known=fixture();$unknown=fixture(false);
        $a=$known['auth']->requestPasswordReset(['email'=>'owner@example.test'],'peer');
        $b=$unknown['auth']->requestPasswordReset(['email'=>'owner@example.test'],'peer');
        unset($a['resetToken'],$b['resetToken']);ok($a===$b);ok(count($unknown['mail']->messages)===0);
        $c=$known['auth']->requestPasswordReset(['email'=>'nobody@example.test'],'peer');ok(count($known['mail']->messages)===1);
        errorIs(fn()=>$known['auth']->verifyPasswordReset(['resetToken'=>$c['resetToken'],'code'=>'00000000'],'peer'),'invalid_reset');
        errorIs(fn()=>$known['auth']->requestPasswordReset(['email'=>"x@example.test\r\nBcc: x@example.test"],'peer'),'invalid_username');
    });
    test('only HMAC is stored; random request handles and email codes are never logged', function() {
        $f=fixture();$r=requestCode($f);$state=file_get_contents($f['root'].'/admin-data/auth-state.json');
        $log=file_get_contents($f['root'].'/admin-data/security-audit.jsonl');
        foreach([$state,$log] as $bytes) { ok(!str_contains($bytes,$r['resetToken']));ok(!str_contains($bytes,$r['code'])); }
        $g=$f['auth']->verifyPasswordReset($r,'peer');ok(strlen($g['passwordToken'])===64);
        errorIs(fn()=>$f['auth']->verifyPasswordReset($r,'peer'),'invalid_reset');
    });
    test('five wrong codes exhaust a challenge without locking normal password login', function() {
        $f=fixture();$r=requestCode($f);$bad=$r;$bad['code']=$r['code']==='00000000'?'11111111':'00000000';
        for($i=0;$i<5;$i++)errorIs(fn()=>$f['auth']->verifyPasswordReset($bad,'peer'),'invalid_reset');
        errorIs(fn()=>$f['auth']->verifyPasswordReset($r,'peer'),'invalid_reset');
        ok($f['auth']->login(['username'=>'owner@example.test','password'=>'old-test-password'],'peer')['enrollmentRequired']);
    });
    test('code expires after ten minutes and password grant after five minutes', function() {
        $f=fixture();$r=requestCode($f);$f['clock']->now+=600001;
        errorIs(fn()=>$f['auth']->verifyPasswordReset($r,'peer'),'invalid_reset');
        $g=grant($f);$f['clock']->now+=300001;
        errorIs(fn()=>$f['auth']->completePasswordReset(['passwordToken'=>$g['passwordToken'],'password'=>'new-test-password'],'peer'),'invalid_reset');
    });
    test('mail throttles apply equally to unknown addresses; requests never change the password', function() {
        foreach(['owner@example.test','unknown@example.test'] as $email) {
            $f=fixture();$before=saved($f)['account'];
            $f['auth']->requestPasswordReset(['email'=>$email],'peer');
            errorIs(fn()=>$f['auth']->requestPasswordReset(['email'=>$email],'peer'),'rate_limit');
            for($i=0;$i<2;$i++) { $f['clock']->now+=61000;$f['auth']->requestPasswordReset(['email'=>$email],'peer'); }
            $f['clock']->now+=61000;ok($f['auth']->requestPasswordReset(['email'=>$email],'another-peer')['retryAfter']===60);
            ok(saved($f)['account']===$before);
        }
    });
    test('early resends do not extend or consume mail limits and a pending code remains usable', function() {
        $f=fixture();$r=requestCode($f);$before=saved($f)['buckets'];
        for($i=0;$i<12;$i++) {
            try { $f['auth']->requestPasswordReset(['email'=>'owner@example.test'],'request-peer'); throw new LogicException('Throttle missing'); }
            catch(CafeAuthException $e) { ok($e->errorCode==='rate_limit' && $e->retryAfter===60); }
        }
        ok(saved($f)['buckets']===$before,'Rejected resends consumed or extended a limit');
        ok(strlen($f['auth']->verifyPasswordReset($r,'request-peer')['passwordToken'])===64);
        $f['clock']->now+=60000;
        ok($f['auth']->requestPasswordReset(['email'=>'owner@example.test'],'request-peer')['retryAfter']===60);
        $f['clock']->now+=60000;
        $third=$f['auth']->requestPasswordReset(['email'=>'owner@example.test'],'request-peer');
        ok($third['retryAfter']===60 && $third['expiresIn']===600);
        $last=end($f['mail']->messages);preg_match('/пароля: ([0-9]{8})/',$last['body'],$match);
        errorIs(fn()=>$f['auth']->requestPasswordReset(['email'=>'owner@example.test'],'request-peer'),'rate_limit');
        ok(strlen($f['auth']->verifyPasswordReset(['resetToken'=>$third['resetToken'],'code'=>$match[1]],'request-peer')['passwordToken'])===64);
        $f['clock']->now+=60000;
        ok($f['auth']->requestPasswordReset(['email'=>'owner@example.test'],'request-peer')['retryAfter']===60);
    });
    test('email and a valid code work without a request token, consume all codes and never send another email', function() {
        $f=fixture();$first=requestCode($f);$f['clock']->now+=61000;requestCode($f);
        $count=count($f['mail']->messages);
        $g=$f['auth']->verifyPasswordReset(['email'=>'OWNER@example.test','code'=>$first['code']],'new-browser');
        ok(strlen($g['passwordToken'])===64 && count($f['mail']->messages)===$count);
        errorIs(fn()=>$f['auth']->verifyPasswordReset(['email'=>'owner@example.test','code'=>$first['code']],'another-browser'),'invalid_reset');
        ok(count(saved($f)['passwordResets'])===1);
        $f['auth']->completePasswordReset(['passwordToken'=>$g['passwordToken'],'password'=>'new-test-password'],'new-browser');
        ok($f['auth']->login(['username'=>'owner@example.test','password'=>'new-test-password'],'new-browser')['enrollmentRequired']);
    });
    test('email code attempts are shared across IPs and waits never exceed three minutes', function() {
        foreach(['owner@example.test','unknown@example.test'] as $email) {
            $f=fixture();$r=requestCode($f);$bad=$r['code']==='00000000'?'11111111':'00000000';
            for($i=0;$i<5;$i++)errorIs(fn()=>$f['auth']->verifyPasswordReset(['email'=>$email,'code'=>$bad],'peer-'.$i),'invalid_reset');
            try { $f['auth']->verifyPasswordReset(['email'=>$email,'code'=>$r['code']],'different-peer'); throw new LogicException('Missing limit'); }
            catch(CafeAuthException $e) { ok($e->errorCode==='rate_limit' && $e->retryAfter===180); }
            $f['clock']->now+=180000;
            errorIs(fn()=>$f['auth']->verifyPasswordReset(['email'=>$email,'code'=>$r['code']],'another-peer'),'invalid_reset');
        }
    });
    test('older hourly and fifteen-minute mail limits migrate without prolonging the original wait', function() {
        $f=fixture();$state=saved($f);$now=$f['clock']->now;
        $state['buckets']['reset_address:'.hash('sha256','owner@example.test')]=['count'=>3,'last'=>$now-61000,'until'=>$now+1800000];
        foreach(['reset_request:peer:'.hash('sha256','request-peer'),'reset_request:global'] as $id) $state['buckets'][$id]=['count'=>40,'until'=>$now+600000];
        CafeStorage::atomicJson($f['root'].'/admin-data/auth-state.json',$state);
        ok($f['auth']->requestPasswordReset(['email'=>'owner@example.test'],'request-peer')['retryAfter']===60);
        // An old IP limit started one minute ago: only two minutes remain.
        $state=saved($f);$state['buckets']['reset_request:peer:'.hash('sha256','old-peer')]=['count'=>8,'until'=>$now+840000];
        CafeStorage::atomicJson($f['root'].'/admin-data/auth-state.json',$state);
        try { $f['auth']->requestPasswordReset(['email'=>'another@example.test'],'old-peer'); throw new LogicException('Missing limit'); }
        catch(CafeAuthException $e) { ok($e->retryAfter===120); }
        $f['clock']->now+=120000;
        ok(isset($f['auth']->requestPasswordReset(['email'=>'another@example.test'],'old-peer')['resetToken']));
    });
    test('new peer request limit unlocks after three minutes and legacy codes still work with their handle', function() {
        $f=fixture();
        for($i=0;$i<8;$i++)$f['auth']->requestPasswordReset(['email'=>'address'.$i.'@example.test'],'burst-peer');
        try { $f['auth']->requestPasswordReset(['email'=>'ninth@example.test'],'burst-peer'); throw new LogicException('Missing limit'); }
        catch(CafeAuthException $e) { ok($e->retryAfter===180); }
        $f['clock']->now+=180000;ok(isset($f['auth']->requestPasswordReset(['email'=>'ninth@example.test'],'burst-peer')['resetToken']));
        $r=requestCode($f);$state=saved($f);$key=hash('sha256',$r['resetToken']);
        unset($state['passwordResets'][$key]['codeHashVersion']);
        $state['passwordResets'][$key]['codeHash']=hash_hmac('sha256',$r['resetToken'].':'.$r['code'],hex2bin($f['config']['encryption_key']));
        CafeStorage::atomicJson($f['root'].'/admin-data/auth-state.json',$state);
        ok(strlen($f['auth']->verifyPasswordReset($r,'legacy-peer')['passwordToken'])===64);
    });
    test('mail enqueue failure does not reveal an account or issue a usable challenge', function() {
        $f=fixture(true,false);$r=requestCode($f);
        errorIs(fn()=>$f['auth']->verifyPasswordReset($r,'peer'),'invalid_reset');
        ok(str_contains(file_get_contents($f['root'].'/admin-data/security-audit.jsonl'),'mail_failed'));
    });
    test('weak password rejected; a newer credential version invalidates every old recovery grant', function() {
        $f=fixture();$g=grant($f);
        errorIs(fn()=>$f['auth']->completePasswordReset(['passwordToken'=>$g['passwordToken'],'password'=>'short'],'peer'),'invalid_password');
        $f['clock']->now+=61000;$other=grant($f);
        $f['auth']->completePasswordReset(['passwordToken'=>$g['passwordToken'],'password'=>'new-test-password'],'peer');
        errorIs(fn()=>$f['auth']->completePasswordReset(['passwordToken'=>$other['passwordToken'],'password'=>'another-test-password'],'peer'),'invalid_reset');
    });
    test('concurrent code use and concurrent password changes each succeed exactly once', function() {
        $f=fixture();$r=requestCode($f);ok(parallelReset($f,'verifyPasswordReset',$r)===[202,400]);
        $f['clock']->now+=61000;$g=grant($f);
        ok(parallelReset($f,'completePasswordReset',['passwordToken'=>$g['passwordToken'],'password'=>'new-test-password'])===[202,400]);
    });
    test('cron working directory is not a document root; real public roots stay forbidden', function() {
        $f=fixture(); $previous=getcwd(); $oldRoot=$_SERVER['DOCUMENT_ROOT']??null;
        $settings=['transport'=>'smtp','from'=>'sender@example.test','host'=>'smtp.example.test','port'=>465,'encryption'=>'smtps','username'=>'sender','password'=>'test-only'];
        try {
            chdir($f['root']); $_SERVER['DOCUMENT_ROOT']='';
            $queue=new CafeResetMail($f['root'],$settings,$f['config']);
            ok($queue->drain(fn()=>throw new RuntimeException('Unexpected email'))['sent']===0);
            $_SERVER['DOCUMENT_ROOT']=$f['root'];
            $rejected=false;
            try { new CafeResetMail($f['root'],$settings,$f['config']); }
            catch(RuntimeException $error){$rejected=$error->getMessage()==='Mail storage must be private.';}
            ok($rejected,'An actual public document root must remain forbidden');
        } finally {
            chdir($previous);
            if($oldRoot===null)unset($_SERVER['DOCUMENT_ROOT']);else $_SERVER['DOCUMENT_ROOT']=$oldRoot;
        }
    });
    test('SMTP outbox encrypts recipients and codes; worker drains once without SMTP in HTTP', function() {
        $f=fixture();$settings=['transport'=>'smtp','from'=>'sender@example.test','host'=>'smtp.example.test','port'=>465,'encryption'=>'smtps','username'=>'sender','password'=>'test-only-app-password'];
        $queue=new CafeResetMail($f['root'],$settings,$f['config']);
        ok($queue->enqueue('owner@example.test','Test code','Code 01234567'));
        $file=glob($f['root'].'/admin-data/reset-mail/*.json')[0];$bytes=file_get_contents($file);
        foreach(['01234567','owner@example.test','test-only-app-password'] as $secret)ok(!str_contains($bytes,$secret));
        $received=[];$result=$queue->drain(function($message)use(&$received){$received[]=$message;return true;});
        ok($result['sent']===1 && $received[0]['body']==='Code 01234567');ok($queue->drain(fn()=>throw new RuntimeException('Duplicate'))['sent']===0);
        ok(!$queue->enqueue("owner@example.test\r\nBcc: other@example.test",'Test','test'));
        $settings['encryption']='none';try { new CafeResetMail($f['root'],$settings,$f['config']);throw new LogicException('Plain SMTP accepted'); }catch(RuntimeException $e){ok(!($e instanceof LogicException));}
    });
    test('mail error diagnostics expose only fixed codes, never raw server errors',function(){
        ok(CafeResetMail::diagnosticCode(new RuntimeException('Could not authenticate: private-password and code 12345678'))==='smtp_authentication');
        ok(CafeResetMail::diagnosticCode(new RuntimeException('certificate verify failed: secret'))==='smtp_tls');
        ok(CafeResetMail::diagnosticCode(new RuntimeException('Failed to connect: private.host'))==='smtp_connection');
        ok(CafeResetMail::diagnosticCode(new RuntimeException('Some arbitrary secret'))==='mail_send_or_runtime');
    });
    test('SMTP retry is bounded and expired encrypted messages are removed',function(){
        $f=fixture();$queue=new CafeResetMail($f['root'],['transport'=>'smtp','from'=>'sender@example.test','host'=>'smtp.example.test','port'=>465,'encryption'=>'smtps','username'=>'sender','password'=>'test'],$f['config']);
        $queue->enqueue('owner@example.test','Test','Test');
        for($i=0;$i<3;$i++){
            $file=glob($f['root'].'/admin-data/reset-mail/*.json')[0];$job=CafeStorage::readJson($file);$job['nextAttempt']=0;CafeStorage::atomicJson($file,$job);
            ok($queue->drain(fn()=>false)['failed']===1);
        }
        ok(glob($f['root'].'/admin-data/reset-mail/*.json')===[]);
        $queue->enqueue('owner@example.test','Expired','Test');$file=glob($f['root'].'/admin-data/reset-mail/*.json')[0];$job=CafeStorage::readJson($file);$job['expiresAt']=time()-1;CafeStorage::atomicJson($file,$job);
        ok($queue->drain(fn()=>throw new RuntimeException('Sent expired mail'))['expired']===1);
    });
    echo "$count password recovery tests passed.\n";
} finally {
    foreach($roots as $root) {
        $resolved=realpath($root);$temp=realpath(sys_get_temp_dir());
        if(!$resolved || dirname($resolved)!==$temp || !str_starts_with(basename($resolved),'cafe-reset-test-'))throw new RuntimeException('Unsafe cleanup');
        foreach(new RecursiveIteratorIterator(new RecursiveDirectoryIterator($resolved,FilesystemIterator::SKIP_DOTS),RecursiveIteratorIterator::CHILD_FIRST)as $file){if($file->isDir())rmdir($file->getPathname());else unlink($file->getPathname());}rmdir($resolved);
    }
}
