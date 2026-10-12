import test from 'node:test';
import assert from 'node:assert/strict';
import { PhoneVerification } from '../hosting/legacy-public/phone-verification.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

function fixture() {
  const nodes=new Map(),requests=[],responses=[]; let now=0;
  const document={getElementById(id){if(!nodes.has(id))nodes.set(id,{value:'',hidden:true,handlers:{},addEventListener(type,fn){this.handlers[type]=fn;},focus(){this.focused=true;}});return nodes.get(id);}};
  const controller=new PhoneVerification({document,now:()=>now,setTimer:()=>1,clearTimer(){},request:async payload=>{requests.push(payload);const response=responses.shift();if(response instanceof Error)throw response;return response;}});
  controller.configure(true,true);
  return {controller,nodes,requests,responses,advance(ms){now+=ms;controller.renderTime();}};
}
const payload={Phone:'+79990000001',Consent:true,PhoneConsent:true};
const state={challengeId:'a'.repeat(32),phoneMask:'+7 ••• •••-00-01',expiresIn:300,retryAfter:60,verified:false,testMode:true};
test('first submit requests a call, never grants permission to register, and cooldown leaves code entry usable',async()=>{
  const f=fixture();f.responses.push({phoneVerification:state});
  assert.equal(await f.controller.confirm(payload),false);assert.equal(f.requests[0].Action,'phone-start');
  assert.equal(f.nodes.get('phone-consent').required,true);assert.equal(f.nodes.get('phone-test-note').hidden,false);
  assert.equal(f.nodes.get('phone-verification').hidden,false);assert.equal(f.nodes.get('phone-resend').disabled,true);
  f.nodes.get('phone-code').value='0123';f.responses.push({phoneVerification:{...state,verified:true}});
  assert.equal(await f.controller.confirm(payload),true);assert.equal(f.requests[1].Code,'0123');assert.equal(f.requests[1].Action,'phone-verify');
  assert.equal(f.nodes.get('phone-resend').disabled,true);
});
test('wrong and expired codes retain the form; expiry cannot silently buy another call',async()=>{
  const f=fixture();f.responses.push({phoneVerification:state});await f.controller.confirm(payload);
  f.nodes.get('phone-code').value='1111';f.responses.push(Error('Код не подошёл'));
  assert.equal(await f.controller.confirm(payload),false);assert.equal(f.nodes.get('phone-error').textContent,'Код не подошёл');
  f.advance(301000);assert.equal(await f.controller.confirm(payload),false);assert.equal(f.requests.length,2);
  assert.equal(f.nodes.get('phone-resend').disabled,false);assert.match(f.nodes.get('phone-error').textContent,/истёк/);
});
test('uncertain responses show the connection problem without claiming that a call started',async()=>{
  const f=fixture();f.responses.push({phoneVerification:{...state,pending:true,connectionMessage:'Хостинг не смог установить защищённое соединение с uCaller.'}});
  await f.controller.confirm(payload);assert.match(f.nodes.get('phone-status').textContent,/защищённое соединение/);assert.match(f.nodes.get('phone-status').textContent,/Начало звонка не подтверждено/);
  assert.equal(f.nodes.get('phone-check-panel').hidden,false);f.controller.configure(true,false);assert.equal(f.nodes.get('phone-check-panel').hidden,true);
});
test('changing phone invalidates old proof; resend limit never blocks entering the previous code',async()=>{
  const f=fixture();f.responses.push({phoneVerification:{...state,verified:true}});await f.controller.confirm(payload);
  f.responses.push({phoneVerification:{...state,challengeId:'b'.repeat(32)}});
  assert.equal(await f.controller.confirm({...payload,Phone:'+79990000002'}),false);
  f.advance(61000);const error=Error('Подождите');error.retryAfter=120;f.responses.push(error);
  await assert.rejects(f.controller.send({...payload,Phone:'+79990000002'},true));
  assert.equal(f.nodes.get('phone-resend').disabled,true);assert.equal(f.nodes.get('phone-code').disabled,undefined);
  f.controller.invalidate();assert.equal(f.controller.challenge.verified,false);
  f.controller.reset();assert.equal(f.controller.challenge,null);assert.equal(f.nodes.get('phone-code').value,'');
});

test('the full test form preserves fields with necessary-only cookies and sends registration only after verification',async()=>{
  // The browser lazily imports this module only in the phone-enabled build.
  // Keep that asynchronous boundary while injecting the real controller with inert timers.
  const source=(await readFile(new URL('../hosting/legacy-public/registration.js',import.meta.url),'utf8'))
    .replace(/^import .*;\r?\n/gm,'').replace(/\bimport\(/g,'loadModule(');
  const nodes=new Map(),calls=[],responses=[];let resets=0,reloads=0;
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',checked:false,hidden:false,dataset:{},handlers:{},textContent:'',addEventListener(event,fn){this.handlers[event]=fn;},focus(){},setAttribute(){},removeAttribute(){},setCustomValidity(){},setSelectionRange(){},querySelector:selector=>node(id+selector),classList:{toggle(){}},reportValidity:()=>true});return nodes.get(id);};
  const form=node('registration-form');form.dataset={phoneVerification:'true',phoneTest:'true'};
  form.elements={namedItem:name=>node(name)};form.reset=()=>resets++;
  for(const [name,value]of Object.entries({LastName:'Тестов',FirstName:'Тест',BirthDate:'1990-01-01',ConsentVersion:'2026-10-02-reg7'}))node(name).value=value;
  node('Consent').checked=true;node('phone-consent').checked=true;node('phone').value='+79990000001';
  const session={csrf:'fixture-csrf',recaptchaRequired:false,phoneVerificationRequired:true,phoneTestMode:true,consentVersion:'2026-10-02-reg7'};
  responses.push({IsSuccess:false,Message:'На сервере не найден закрытый файл ucaller-config.json.'},session,{IsSuccess:true,connection:{message:'Соединение работает. Звонок не запускался.'}},session,{IsSuccess:true,phoneVerification:state});
  const context={document:{getElementById:node,querySelector:node},PhoneVerification:class extends PhoneVerification{constructor(args){super({...args,setTimer:()=>1,clearTimer(){}});}},
    cookieConsent:{allowed:()=>false,subscribe(){},request(){throw Error('Test must not request Google consent');}},
    FormData:class {get(name){return name==='Consent'?'on':node(name).value;}},Date,URL,AbortController,setTimeout,clearTimeout,
    location:{href:'http://localhost/registration.html',replace(){reloads++;}},fetch:async(url,options)=>{calls.push({url,body:options.body?JSON.parse(options.body):null});assert.ok(responses.length,'Unexpected request');const data=responses.shift();return {ok:data.IsSuccess!==false,status:data.IsSuccess===false?503:200,json:async()=>data};},window:{}};
  const imports=[];
  context.loadModule=async specifier=>{
    assert.match(specifier,/^\.\/phone-verification\.js(?:\?v=[\w-]+)?$/);
    imports.push(specifier);
    return {PhoneVerification:context.PhoneVerification};
  };
  await vm.runInNewContext(`(async()=>{${source}\n})()`,context);
  assert.equal(imports.length,1,'The enabled form loads the phone controller once');
  assert.equal(node('captcha-privacy').hidden,true,'Test mode never advertises Google verification');
  await form.handlers.submit({preventDefault(){}});
  assert.match(node('form-message').textContent,/ucaller-config\.json/,'Server configuration error is shown instead of a generic failure');
  assert.equal(resets,0);assert.equal(reloads,0);assert.equal(calls.length,1,'Invalid configuration cannot start a call');
  await node('phone-check').handlers.click();
  assert.equal(calls.at(-1).body.Action,'phone-check');assert.equal(calls.at(-1).body.Phone,undefined,'The diagnostic does not transmit a phone');
  assert.match(node('phone-check-result').textContent,/Звонок не запускался/);
  await form.handlers.submit({preventDefault(){}});
  assert.equal(resets,0);assert.equal(reloads,0);assert.equal(node('LastName').value,'Тестов');
  assert.equal(calls.at(-1).body.Action,'phone-start');assert.equal(node('phone-verification').hidden,false);
  assert.equal(node('submit-button').textContent,'Подтвердить и зарегистрироваться');
  node('phone-code').value='0123';responses.push(session,{IsSuccess:true,phoneVerification:{...state,verified:true}},{IsSuccess:true,TestMode:true});
  await form.handlers.submit({preventDefault(){}});
  assert.equal(calls.at(-2).body.Action,'phone-verify');assert.equal(calls.at(-1).body.Phone,'+79990000001');assert.equal(calls.at(-1).body.Action,undefined);
  assert.equal(reloads,0);assert.equal(resets,1);assert.equal(form.hidden,true);
  assert.match(node('registration-successp').textContent,/не отправлена в FlexBonus/);
});
