import test from 'node:test';
import assert from 'node:assert/strict';
import { PhoneVerification, isPhoneDevice, phoneErrorMessage } from '../hosting/legacy-public/phone-verification.js';
import { attachBirthDateInput, formatBirthDate, parseBirthDate } from '../birth-date.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

function nodeFactory() {
  const nodes=new Map();
  const node=id=>{
    if(!nodes.has(id)) nodes.set(id,{
      value:'',checked:false,hidden:false,dataset:{},handlers:{},textContent:'',clicks:0,
      addEventListener(type,fn){this.handlers[type]=fn;},focus(){this.focused=true;},
      setAttribute(name,value){this[name]=value;},removeAttribute(name){delete this[name];},
      setCustomValidity(value){this.validityMessage=value;},setSelectionRange(){},
      click(){this.clicks++;},querySelector:selector=>node(id+selector),
      classList:{toggle(){}},reportValidity:()=>true,
    });
    return nodes.get(id);
  };
  return {nodes,node};
}
function fixture({mobilePhone=false}={}) {
  const {nodes,node}=nodeFactory(),requests=[],responses=[]; let now=0;
  const document={getElementById:node,visibilityState:'visible'};
  const controller=new PhoneVerification({document,mobilePhone,now:()=>now,setTimer:()=>1,clearTimer(){},
    request:async payload=>{requests.push(payload);assert.ok(responses.length,'Unexpected mock request');const response=responses.shift();if(response instanceof Error)throw response;return await response;}});
  controller.configure(true,true);
  return {controller,nodes,node,requests,responses,advance(ms){now+=ms;controller.renderTime();}};
}
const payload={Phone:'+79990000001',Consent:true,PhoneConsent:true};
const state={challengeId:'a'.repeat(32),method:'incoming',state:'waiting',phoneMask:'+7 *** ***-00-01',
  phoneToCall:'+79990000099',expiresIn:60,retryAfter:60,verified:false,proofExpiresIn:300,testMode:true};

test('incoming verification starts once and requires a server status before registration, never a typed code',async()=>{
  const f=fixture();f.responses.push({phoneVerification:state});
  assert.equal(await f.controller.confirm(payload),false);
  assert.equal(f.requests[0].Action,'phone-start');
  assert.equal(f.node('phone-consent').required,true);
  assert.equal(f.node('phone-verification').hidden,false);
  assert.equal(f.node('phone-resend').disabled,true);
  assert.equal(f.node('phone-call-number').hidden,false);
  assert.equal(f.node('phone-call-link').href,undefined,'Desktop must not launch a dialler');
  f.responses.push({phoneVerification:{...state,state:'verified',verified:true}});
  assert.equal(await f.controller.confirm(payload),true);
  assert.equal(f.requests[1].Action,'phone-status');
  assert.equal(f.requests[1].ChallengeId,state.challengeId);
  assert.ok(!f.requests.some(request=>Object.hasOwn(request,'Code')));
  assert.equal(f.requests.length,2);
});

test('uncertain final polling never buys another call and expired proof cannot register',async()=>{
  const f=fixture();f.responses.push({phoneVerification:state});await f.controller.confirm(payload);
  f.advance(61000);f.responses.push(Error('Нет связи с сервером'));
  assert.equal(await f.controller.confirm(payload),false);
  assert.equal(f.controller.challenge.state,'failed');
  assert.equal(f.requests.length,2);
  assert.equal(await f.controller.confirm(payload),false);
  assert.equal(f.requests.length,2,'No automatic paid restart after expiry');
  assert.match(f.node('phone-error').textContent,/Нет связи/);
  f.controller.accept({...state,state:'verified',verified:true,proofExpiresIn:1},payload.Phone);
  f.advance(1100);
  assert.equal(f.controller.challenge.verified,false);
  assert.equal(f.controller.challenge.state,'expired');
});

test('changing number invalidates old proof and reset ignores an in-flight reply',async()=>{
  const f=fixture();f.responses.push({phoneVerification:{...state,state:'verified',verified:true}});
  await f.controller.confirm(payload);
  f.responses.push({phoneVerification:{...state,challengeId:'b'.repeat(32)}});
  assert.equal(await f.controller.confirm({...payload,Phone:'+79990000002'}),false);
  assert.equal(f.controller.number,'+79990000002');
  f.controller.invalidate();assert.equal(f.controller.challenge.verified,false);
  f.controller.reset();
  let resolve;
  f.responses.push(new Promise(done=>resolve=done));
  const pending=f.controller.send(payload);
  f.controller.reset();resolve({phoneVerification:state});await pending;
  assert.equal(f.controller.challenge,null);
});

test('only a mobile phone may open the dialler, once per user-started challenge',async()=>{
  assert.equal(isPhoneDevice({userAgent:'Mozilla/5.0 (iPhone)'}),true);
  assert.equal(isPhoneDevice({userAgent:'Mozilla/5.0 (iPad)'}),false);
  assert.equal(isPhoneDevice({userAgent:'Mozilla/5.0 (Macintosh)',maxTouchPoints:5}),false);
  assert.equal(isPhoneDevice({userAgent:'Mozilla/5.0 (Windows NT 10.0)'}),false);
  const f=fixture({mobilePhone:true});
  f.responses.push({phoneVerification:state});await f.controller.confirm(payload);
  assert.equal(f.node('phone-call-link').clicks,1);
  assert.equal(f.node('phone-call-link').href,'tel:'+state.phoneToCall);
  assert.equal(f.node('phone-call-number').hidden,true);
  f.responses.push({phoneVerification:state});await f.controller.poll();
  assert.equal(f.node('phone-call-link').clicks,1,'Polling must not reopen the phone app');
});

test('invalid server proof and provider errors fail safely',async()=>{
  const f=fixture();
  assert.throws(()=>f.controller.accept({...state,expiresIn:300},payload.Phone),/Некорректный ответ/);
  assert.throws(()=>f.controller.accept({...state,phoneToCall:'javascript:alert(1)'},payload.Phone),/проверочный номер/);
  assert.match(phoneErrorMessage({Message:'Подождите',retryAfter:90}),/2 мин/);
  assert.equal(phoneErrorMessage({Message:'Лимит',Code:'phone_budget_exhausted',retryAfter:90}),'Лимит');
});

async function formFixture({preview=false}={}) {
  const filename=preview ? '../registration.js' : '../hosting/legacy-public/registration.js';
  const source=(await readFile(new URL(filename,import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/\bimport\(/g,'loadModule(');
  const {nodes,node}=nodeFactory(),calls=[],responses=[];let resets=0,reloads=0,googleLoads=0,consentRequests=0;
  const form=node('registration-form');
  form.dataset={phoneVerification:'true',phoneProvider:'flashcall',phoneTest:preview?'false':'true',...(preview?{preview:'true'}:{})};
  form.elements={namedItem:name=>node(name)};form.reset=()=>resets++;
  for(const [name,value]of Object.entries({LastName:'Тестов',FirstName:'Тест',ConsentVersion:'2026-10-19-reg13'}))node(name).value=value;
  node('birth-date').value='1990-01-01';node('Consent').checked=true;node('phone-consent').checked=true;node('phone').value=payload.Phone;
  const pending=[];
  form.requestSubmit=()=>pending.push(form.handlers.submit({preventDefault(){}}));
  const context={document:{getElementById:node,querySelector:node,visibilityState:'visible',addEventListener(){},head:{appendChild(){googleLoads++;throw Error('Google must never load in this test');}}},
    attachBirthDateInput,PhoneVerification:class extends PhoneVerification{constructor(args){super({...args,mobilePhone:false,setTimer:()=>1,clearTimer(){}});}},
    cookieConsent:{allowed:()=>true,subscribe(){},request(){consentRequests++;throw Error('Test must not request Google');}},
    FormData:class {get(name){return name==='Consent'?'on':name==='BirthDate'?node('birth-date').value:node(name).value;}},
    Date,URL,AbortController,setTimeout,clearTimeout,
    location:{href:'http://localhost/registration.html',replace(){reloads++;}},fetch:async(url,options)=>{
      calls.push({url,body:options.body?JSON.parse(options.body):null});
      assert.ok(responses.length,'Unexpected mock network request');
      const data=responses.shift();return {ok:data.IsSuccess!==false,status:data.IsSuccess===false?503:200,json:async()=>data};
    },window:{}};
  context.loadModule=async specifier=>{
    assert.match(specifier,/^\.\/phone-verification\.js(?:\?v=[\w-]+)?$/);
    return {PhoneVerification:context.PhoneVerification,phoneErrorMessage};
  };
  await vm.runInNewContext('(async()=>{'+source+'\n})()',context);
  return {form,nodes,node,calls,responses,pending,summary:()=>({resets,reloads,googleLoads,consentRequests})};
}
const session={csrf:'fixture-csrf',recaptchaRequired:false,phoneVerificationRequired:true,
  phoneVerificationProvider:'flashcall',phoneVerificationMethod:'incoming',phoneTestMode:true,consentVersion:'2026-10-19-reg13'};

test('full form retains fields and submits only after incoming-call verification with ISO birth date',async()=>{
  const f=await formFixture();
  f.responses.push({IsSuccess:false,Message:'Настройки FlashCall недоступны'});
  await f.form.handlers.submit({preventDefault(){}});
  assert.match(f.node('form-message').textContent,/Настройки FlashCall/);
  assert.equal(f.summary().resets,0);assert.equal(f.calls.length,1);
  f.responses.push(session,{IsSuccess:true,phoneVerification:state});
  await f.form.handlers.submit({preventDefault(){}});
  assert.equal(f.calls.at(-1).body.Action,'phone-start');
  assert.equal(f.node('LastName').value,'Тестов');
  assert.equal(f.node('submit-button').hidden,true,'The incoming-call action replaces the submit button while waiting');
  f.responses.push(session,{IsSuccess:true,phoneVerification:{...state,state:'verified',verified:true}},{IsSuccess:true,TestMode:true});
  await f.form.handlers.submit({preventDefault(){}});
  await Promise.all(f.pending);
  assert.equal(f.calls.at(-2).body.Action,'phone-status');
  assert.equal(f.calls.at(-1).body.Action,undefined);
  assert.equal(f.calls.at(-1).body.BirthDate,'1990-01-01');
  assert.equal(f.form.hidden,true);
  assert.equal(f.summary().resets,1);
  assert.equal(f.summary().googleLoads,0);
  assert.match(f.node('registration-successp').textContent,/не отправлена в FlexBonus/);
});

test('editable preview blocks requests before CAPTCHA, phone calls or registration',async()=>{
  const html=await readFile(new URL('../registration.html',import.meta.url),'utf8');
  assert.match(html,/<form[^>]*data-preview="true"/);
  assert.match(html,/id="submit-button"[^>]*disabled/);
  const f=await formFixture({preview:true});
  await f.form.handlers.submit({preventDefault(){}});
  assert.equal(f.calls.length,0);
  assert.deepEqual(f.summary(),{resets:0,reloads:0,googleLoads:0,consentRequests:0});
  assert.match(f.node('form-message').textContent,/предпросмотре.*отключены/);
  assert.equal(f.node('LastName').value,'Тестов');
  assert.equal(f.form.hidden,false);
  assert.equal(f.node('submit-button').disabled,true);
});

test('imported birth-date input accepts numeric typing but rejects impossible dates',()=>{
  assert.equal(formatBirthDate('14111990'),'14.11.1990');
  assert.equal(parseBirthDate('14.11.1990').value,'1990-11-14');
  assert.equal(parseBirthDate('31.02.2000').value,null);
  assert.equal(parseBirthDate('01.01.2999').value,null);
});
