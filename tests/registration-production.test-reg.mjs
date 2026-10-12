import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { phpBinary, phpEnvironment } from '../scripts/php-runtime.mjs';

test('production registration ignores copied phone settings, retains captcha and records a real-flow receipt', {timeout:30000}, async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'cafe-production-registration-'));
  const privateDir=path.join(temp,'vosem-utra-private'), site=path.join(temp,'site');
  const socket=net.createServer().listen(0,'127.0.0.1'); await once(socket,'listening');
  const port=socket.address().port; await new Promise(resolve=>socket.close(resolve));
  let server, cookie='', csrf='', log='';
  async function request(body) {
    const response=await fetch(`http://127.0.0.1:${port}/api/register.php`,{method:body?'POST':'GET',headers:{Origin:'https://vosem-utra.ru',Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    if(response.headers.get('set-cookie')) cookie=response.headers.get('set-cookie').split(';')[0];
    const text=await response.text(); let data; try{data=JSON.parse(text);}catch{assert.fail(text+log);}
    return {status:response.status,data,text};
  }
  try {
    await cp(path.resolve('dist-reg'),temp,{recursive:true});
    for(const file of ['loyalty-phone-policy.php','app/loyalty-phone.php']) await writeFile(path.join(privateDir,file),"<?php throw new RuntimeException('Excluded phone module was loaded');");
    await writeFile(path.join(privateDir,'ucaller-config.json'),'{invalid copied staging settings');
    await writeFile(path.join(privateDir,'loyalty.php'),"<?php return ['api_key'=>'fixture-only'];");
    // All external transport is replaced inside this temporary fixture; no call, email or guest is created.
    await writeFile(path.join(site,'api/recaptcha.php'),"<?php function captcha_config():array{return ['site_key'=>'fixture-site','secret_key'=>'fixture-secret','mode'=>'checkbox'];} function captcha_verify($token):bool{return $token==='fixture-captcha';}");
    const core=await readFile(path.join(site,'api/loyalty-core.php'),'utf8');
    const send=core.indexOf('function loyalty_send('); assert.ok(send>0);
    await writeFile(path.join(site,'api/loyalty-core.php'),core.slice(0,send)+`function loyalty_send(array $payload,string $apiKey):array {
      file_put_contents(__DIR__.'/../../vosem-utra-private/fixture-submitted.json',json_encode($payload));
      return ['IsSuccess'=>true];
    }`);
    const router=path.join(temp,'router.php');
    await writeFile(router,"<?php $_SERVER['HTTPS']='on'; $_SERVER['HTTP_HOST']='vosem-utra.ru'; require __DIR__.'/site/api/register.php';");
    server=spawn(phpBinary,['-S',`127.0.0.1:${port}`,'-t',site,router],{windowsHide:true,env:phpEnvironment,stdio:['ignore','ignore','pipe']});
    server.stderr.on('data',chunk=>log+=chunk);
    let ready; for(let i=0;i<60;i++){try{ready=await request();break;}catch(error){if(i===59)throw error;await new Promise(resolve=>setTimeout(resolve,50));}}
    assert.equal(ready.status,200,ready.text+log); csrf=ready.data.csrf;
    assert.equal(ready.data.phoneVerificationRequired,false); assert.equal(ready.data.phoneTestMode,false); assert.equal(ready.data.recaptchaRequired,true);
    const payload={FirstName:'Тест',LastName:'Тестов',BirthDate:'1990-01-01',Phone:'+79990000001',Consent:true,ConsentVersion:ready.data.consentVersion,CaptchaConsent:true,RecaptchaToken:'fixture-captcha'};
    for(const Action of ['phone-start','phone-resend','phone-verify','phone-check']) assert.equal((await request({...payload,Action})).status,404);
    assert.equal((await request({...payload,CaptchaConsent:false})).status,422);
    assert.equal((await request({...payload,Consent:false})).status,422);
    const done=await request(payload); assert.equal(done.status,200,done.text+log);
    assert.equal(done.data.IsSuccess,true); assert.equal(done.data.TestMode,undefined); assert.ok(done.data.Receipt);
    const submitted=JSON.parse(await readFile(path.join(privateDir,'fixture-submitted.json'),'utf8')); assert.equal(submitted.Phone,payload.Phone);
    assert.deepEqual((await request(payload)).data,done.data,'Repeated submit reuses its receipt');
    assert.doesNotMatch(log,/Warning|Fatal error|Excluded phone module/);
  }finally{
    if(server?.exitCode===null){const done=once(server,'exit');server.kill();await done;}
    assert.equal(path.dirname(temp),path.resolve(os.tmpdir())); assert.ok(path.basename(temp).startsWith('cafe-production-registration-'));
    await rm(temp,{recursive:true,force:true});
  }
});

test('registration browser code submits without phone DOM or phone module and rejects a mismatched server profile', async()=>{
  const source=(await readFile('dist-reg/site/registration.js','utf8')).replace(/^import .*cookieConsent.*;$/m,'');
  for(const mismatched of [false,true]) {
    const listeners=new Map(), elements=new Map(), requests=[];
    const element=()=>({value:'',checked:true,hidden:false,textContent:'',dataset:{},addEventListener(){},setCustomValidity(){},setAttribute(){},removeAttribute(){},focus(){}});
    for(const id of ['registration-form','submit-button','form-message','birth-date','phone','captcha-status','captcha-privacy','captcha-notice','registration-success']) elements.set(id,element());
    const fields=new Map(['ConsentVersion','Consent','FirstName','LastName','MiddleName','BirthDate','Comment'].map(name=>[name,element()]));
    fields.get('ConsentVersion').value='fixture-version'; fields.get('FirstName').value='Тест'; fields.get('LastName').value='Тестов'; fields.get('BirthDate').value='1990-01-01';
    const form=elements.get('registration-form'); form.elements={namedItem:name=>fields.get(name)};
    form.addEventListener=(type,callback)=>listeners.set(type,callback); form.reportValidity=()=>true; form.reset=()=>{}; form.classList={toggle(){}};
    elements.get('phone').value='+79990000001';
    const window={grecaptcha:{render:()=>0,getResponse:()=> 'fixture-captcha',reset(){}}};
    const document={getElementById:id=>elements.get(id)??null,querySelector:()=>element(),createElement:()=>element(),head:{appendChild(){window.onLoyaltyCaptchaLoad();}}};
    const cookieConsent={allowed:()=>true,request:async()=>true,subscribe(){}};
    const fetch=async(url,options)=>{
      requests.push(options);
      return {ok:true,status:200,json:async()=>options.method==='POST'?{IsSuccess:true}:{csrf:'fixture-csrf',consentVersion:'fixture-version',recaptchaRequired:true,recaptchaSiteKey:'fixture-site',recaptchaMode:'checkbox',phoneVerificationRequired:mismatched,phoneTestMode:false}};
    };
    class FormData { get(name){return name==='Consent'?'on':fields.get(name)?.value;} }
    const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
    await new AsyncFunction('document','window','cookieConsent','fetch','FormData','location',source)(document,window,cookieConsent,fetch,FormData,{href:'https://vosem-utra.ru/registration.html'});
    assert.equal(elements.get('submit-button').textContent,'Зарегистрироваться');
    await listeners.get('submit')({preventDefault(){}});
    const posts=requests.filter(request=>request.method==='POST');
    assert.equal(posts.length,mismatched?0:1);
    if(mismatched) assert.match(elements.get('form-message').textContent,/Настройки формы изменились/);
    else {
      const body=JSON.parse(posts[0].body); assert.equal(body.Phone,'+79990000001'); assert.equal(body.RecaptchaToken,'fixture-captcha'); assert.equal(body.PhoneConsent,false);
      assert.equal(form.hidden,true); assert.equal(elements.get('registration-success').hidden,false);
    }
  }
});
