import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {phpBinary,phpEnvironment} from '../scripts/php-runtime.mjs';

test('PHP call verification gates registration, survives reload and cannot submit a staging guest to FlexBonus',{timeout:30000},async()=>{
  const root=process.cwd(),temp=await mkdtemp(path.join(os.tmpdir(),'cafe-phone-http-'));
  const privateDir=path.join(temp,'vosem-utra-private'),site=path.join(temp,'site');
  const socket=net.createServer().listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  let server,cookie='',csrf='',log='';
  async function request(body,{method=body?'POST':'GET',headers={}}={}) {
    const response=await fetch(`http://127.0.0.1:${port}/api/register.php`,{method,headers:{Origin:'https://test888.ru',Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined});
    if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
    const text=await response.text();let data;try{data=JSON.parse(text);}catch{assert.fail('Not JSON: '+text+log);}return {status:response.status,data,text};
  }
  try {
    await cp(path.join(root,'dist-reg-test'),temp,{recursive:true});
    // Exercise the opt-in handler even when the default staging build still disables registration.
    await cp(path.join(root,'hosting/legacy-public/api/register.php'),path.join(site,'api/register.php'));
    await writeFile(path.join(privateDir,'loyalty-phone-policy.php'),"<?php return ['required'=>true,'testOnly'=>true,'publicOrigin'=>'https://test888.ru'];");
    const config={serviceId:'123',secretKey:'isolated-http-fixture-not-real',trustedPhone:'79990000001',publicOrigin:'https://test888.ru',mode:'test',dailyCallLimit:10};
    await writeFile(path.join(privateDir,'ucaller-config.json'),JSON.stringify(config));
    const module=path.join(privateDir,'app/loyalty-phone.php');let source=await readFile(module,'utf8');
    source=source.replace(/function loyalty_ucaller_request\([\s\S]*?\nfinal class LoyaltyPhone/,`function loyalty_ucaller_request(array $config,string $method,array $body=[]):array {
      if ($method==='getService') return ['status'=>true,'owner'=>'private-provider-field'];
      file_put_contents(__DIR__.'/../fixture-calls.json',json_encode($body)."\\n",FILE_APPEND);
      return ['status'=>true,'ucaller_id'=>1,'code'=>$body['code']];
    }
    final class LoyaltyPhone`);
    await writeFile(module,source);
    await writeFile(path.join(privateDir,'loyalty.php'),"<?php throw new RuntimeException('FlexBonus credentials must never be loaded on this test');");
    const router=path.join(temp,'router.php');await writeFile(router,`<?php $_SERVER['HTTPS']='on';$_SERVER['HTTP_HOST']='test888.ru';require __DIR__.'/site/api/register.php';`);
    server=spawn(phpBinary,['-S',`127.0.0.1:${port}`,'-t',site,router],{windowsHide:true,env:phpEnvironment,stdio:['ignore','ignore','pipe']});server.stderr.on('data',chunk=>log+=chunk);
    let ready;for(let i=0;i<50;i++){try{ready=await request();break;}catch(e){if(i===49)throw e;await new Promise(r=>setTimeout(r,50));}}
    assert.equal(ready.status,200,ready.text+log);csrf=ready.data.csrf;
    assert.equal(ready.data.phoneVerificationRequired,true);assert.equal(ready.data.recaptchaRequired,false);
    const payload={FirstName:'Тест',LastName:'Тестов',BirthDate:'1990-01-01',Phone:'+79990000001',Consent:true,PhoneConsent:true,ConsentVersion:ready.data.consentVersion,CaptchaConsent:false};
    assert.equal((await request(payload)).data.Code,'phone_confirmation_required');
    assert.equal((await request({...payload,Action:'phone-start'},{headers:{'X-CSRF-Token':'wrong'}})).status,403);
    assert.equal((await request({...payload,Action:'phone-start'},{headers:{Origin:'https://foreign.invalid'}})).status,403);
    assert.equal((await request({...payload,Action:'phone-start',PhoneConsent:false})).status,422);
    assert.equal((await request({...payload,Action:'phone-start',Phone:'+79990000002'})).data.Code,'test_number_only');
    assert.equal((await request({...payload,Action:'phone-check'},{headers:{'X-CSRF-Token':'wrong'}})).status,403);
    assert.equal((await request({...payload,Action:'phone-check'},{headers:{Origin:'https://foreign.invalid'}})).status,403);
    const checked=await request({...payload,Action:'phone-check'});assert.equal(checked.status,200);assert.equal(checked.data.connection.callsStarted,0);assert.equal(checked.text.includes('private-provider-field'),false);
    const started=await request({...payload,Action:'phone-start'});assert.equal(started.status,200,started.text+log);
    const challenge=started.data.phoneVerification;
    const calls=()=>readFile(path.join(privateDir,'fixture-calls.json'),'utf8').then(text=>text.trim().split('\n').map(JSON.parse));
    const first=(await calls())[0];assert.equal(challenge.verified,false);assert.equal(challenge.code,undefined);assert.equal(started.text.includes(config.secretKey),false);
    await request();const duplicate=await request({...payload,Action:'phone-start'});assert.equal(duplicate.data.phoneVerification.challengeId,challenge.challengeId);assert.equal((await calls()).length,1);
    const resend=await request({...payload,Action:'phone-resend'});assert.equal(resend.status,429);
    const wrong=first.code==='1234'?'4321':'1234';assert.equal((await request({...payload,Action:'phone-verify',ChallengeId:challenge.challengeId,Code:wrong})).status,422);
    const verified=await request({...payload,Action:'phone-verify',ChallengeId:challenge.challengeId,Code:first.code});assert.equal(verified.data.phoneVerification.verified,true,verified.text+log);
    const completed=await request(payload);assert.equal(completed.status,200,completed.text+log);assert.equal(completed.data.TestMode,true);assert.match(completed.data.Message,/не отправлена/);
    assert.deepEqual((await request(payload)).data,completed.data,'An exact retry reads its receipt without reusing confirmation');
    assert.equal((await request({...payload,FirstName:'Другой'})).data.Code,'phone_confirmation_required');
    assert.equal((await calls()).length,1);
    await rm(path.join(privateDir,'ucaller-config.json'));
    const missing=await request(payload);
    assert.equal(missing.status,503,'Missing required config never falls back to direct FlexBonus');
    assert.equal(missing.data.Code,'phone_config_missing');assert.match(missing.data.Message,/ucaller-config\.json/);
    assert.equal(missing.text.includes(config.secretKey),false);
    assert.doesNotMatch(log,/Warning|Fatal error/);
  }finally{
    if(server){server.kill();await once(server,'exit');}
    await rm(temp,{recursive:true,force:true});
  }
});
