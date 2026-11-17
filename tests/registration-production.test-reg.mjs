import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { phpBinary, phpEnvironment } from '../scripts/php-runtime.mjs';

test('production FlashCall registration enforces proof and prevents cross-session duplicate or uncertain sends', { timeout: 30000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cafe-production-registration-'));
  const privateDir = path.join(temp, 'vosem-utra-private'), site = path.join(temp, 'site');
  const fixtureFile = path.join(privateDir, 'fixture-provider.json');
  const socket = net.createServer().listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  let server, log = '';
  const state = async () => JSON.parse(await readFile(fixtureFile, 'utf8'));
  const patchState = async patch => writeFile(fixtureFile, JSON.stringify({ ...await state(), ...patch }));
  async function request(client, body, overrides = {}) {
    const response = await fetch(`http://127.0.0.1:${port}/api/register.php`, {
      method: body ? 'POST' : 'GET', headers: {
        Origin: 'https://vosem-utra.ru', Cookie: client.cookie || '', 'X-CSRF-Token': client.csrf || '',
        'Content-Type': 'application/json', ...overrides,
      }, body: body ? JSON.stringify(body) : undefined,
    });
    if (response.headers.get('set-cookie')) client.cookie = response.headers.get('set-cookie').split(';')[0];
    const text = await response.text(); let data;
    try { data = JSON.parse(text); } catch { assert.fail(text + log); }
    if (data.csrf) client.csrf = data.csrf;
    return { status: response.status, data, text };
  }
  async function verifiedClient(payload) {
    const client = {}; assert.equal((await request(client)).status, 200);
    const started = await request(client, { ...payload, Action: 'phone-start' });
    assert.equal(started.status, 200, started.text);
    assert.equal(started.data.phoneVerification.state, 'waiting');
    const proof = await request(client, { ...payload, Action: 'phone-status', ChallengeId: started.data.phoneVerification.challengeId });
    assert.equal(proof.status, 200, proof.text); assert.equal(proof.data.phoneVerification.verified, true);
    return client;
  }
  try {
    await cp(path.resolve('dist-reg'), temp, { recursive: true });
    await mkdir(path.join(temp, 'sessions'));
    await writeFile(fixtureFile, JSON.stringify({ now: 100000, next: 0, calls: [], phones: {}, sends: [], outcome: 'success' }));
    await writeFile(path.join(privateDir, 'flashcall-config.json'), JSON.stringify({ apiKey: 'fixture-flashcall-only', publicOrigin: 'https://vosem-utra.ru', dailyCallLimit: 0 }));
    await writeFile(path.join(privateDir, 'loyalty.php'), "<?php return ['api_key'=>'fixture-flex-only'];");
    // Replace transports only in this disposable package. Disable curl_exec below
    // as an additional guard: a missed mock cannot call a real external service.
    await writeFile(path.join(site, 'api/recaptcha.php'), "<?php function captcha_config():array{return ['site_key'=>'fixture-site','secret_key'=>'fixture-secret','mode'=>'checkbox'];} function captcha_verify($token):bool{return $token==='fixture-captcha';}");
    const phonePath = path.join(privateDir, 'app/loyalty-phone.php');
    const phoneSource = await readFile(phonePath, 'utf8');
    const transportStart = phoneSource.indexOf('function loyalty_flashcall_request(');
    const transportEnd = phoneSource.indexOf('final class LoyaltyPhone {', transportStart);
    assert.ok(transportStart > 0 && transportEnd > transportStart);
    const phoneMock = `function fixture_phone_now(): int { return json_decode(file_get_contents(dirname(__DIR__).'/fixture-provider.json'),true)['now']; }
function loyalty_flashcall_request(array $config,string $method,array $body=[]):array {
  $file=dirname(__DIR__).'/fixture-provider.json'; $state=json_decode(file_get_contents($file),true);
  $state['calls'][]=[$method,$body];
  if($method==='get-phone') { $id='fixture-'.++$state['next']; $state['phones'][$id]=$body['phone']; $result=['id'=>$id,'phone'=>'+70000000002','expiresIn'=>60]; }
  elseif($method==='status') { $result=['id'=>$body['id'],'callerPhone'=>$state['phones'][$body['id']],'status'=>'CONFIRMED','expiresIn'=>60]; }
  else throw new RuntimeException('Unexpected mocked method');
  file_put_contents($file,json_encode($state)); return $result;
}
`;
    const instrumented = phoneSource.slice(0, transportStart) + phoneMock + phoneSource.slice(transportEnd);
    assert.ok(instrumented.includes("$clock ?? 'time'"));
    await writeFile(phonePath, instrumented.replace("$clock ?? 'time'", "$clock ?? 'fixture_phone_now'"));
    const core = await readFile(path.join(site, 'api/loyalty-core.php'), 'utf8');
    const send = core.indexOf('function loyalty_send('); assert.ok(send > 0);
    await writeFile(path.join(site, 'api/loyalty-core.php'), core.slice(0, send) + `function loyalty_send(array $payload,string $apiKey):array {
      $file=__DIR__.'/../../vosem-utra-private/fixture-provider.json'; $state=json_decode(file_get_contents($file),true);
      $state['sends'][]=$payload; file_put_contents($file,json_encode($state));
      if($state['outcome']==='unknown') throw new RuntimeException('fixture uncertain upstream');
      return ['IsSuccess'=>true];
    }`);
    const router = path.join(temp, 'router.php');
    await writeFile(router, "<?php $_SERVER['HTTPS']='on'; $_SERVER['HTTP_HOST']='vosem-utra.ru'; require __DIR__.'/site/api/register.php';");
    server = spawn(phpBinary, ['-d', 'disable_functions=curl_exec', '-d', `session.save_path=${path.join(temp, 'sessions')}`, '-S', `127.0.0.1:${port}`, '-t', site, router], {
      windowsHide: true, env: { ...phpEnvironment, FLEXBONUS_API_KEY: '' }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    server.stderr.on('data', chunk => log += chunk);
    const client = {}; let ready;
    for (let i = 0; i < 60; i++) {
      try { ready = await request(client); break; }
      catch (error) { if (i === 59) throw error; await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.equal(ready.status, 200, ready.text + log);
    assert.equal(ready.data.phoneVerificationRequired, true); assert.equal(ready.data.phoneTestMode, false);
    assert.equal(ready.data.phoneVerificationMethod, 'incoming'); assert.equal(ready.data.phoneVerificationProvider, 'flashcall');
    assert.equal(ready.data.recaptchaRequired, true);
    const payload = { FirstName: 'Тест', LastName: 'Тестов', BirthDate: '1990-01-01', Phone: '+70000000001', Consent: true,
      PhoneConsent: true, ConsentVersion: ready.data.consentVersion, CaptchaConsent: true, RecaptchaToken: 'fixture-captcha' };
    const start = { ...payload, Action: 'phone-start' };
    assert.equal((await request(client, start, { Origin: 'https://foreign.invalid' })).status, 403);
    assert.equal((await request(client, start, { 'X-CSRF-Token': 'wrong' })).status, 403);
    for (const key of ['Consent', 'PhoneConsent', 'CaptchaConsent']) assert.equal((await request(client, { ...start, [key]: false })).status, 422);
    assert.equal((await request(client, { ...start, RecaptchaToken: 'wrong' })).status, 422);
    assert.equal((await request(client, { ...start, ConsentVersion: 'obsolete' })).status, 409);
    assert.equal((await request(client, payload)).data.Code, 'phone_confirmation_required');
    for (const Action of ['phone-verify', 'phone-check']) assert.equal((await request(client, { ...payload, Action, Code: '1234' })).status, 400);
    assert.deepEqual((await state()).calls, []); assert.deepEqual((await state()).sends, []);
    const started = await request(client, start); assert.equal(started.status, 200, started.text);
    const challenge = started.data.phoneVerification;
    assert.equal(challenge.phoneToCall, '+70000000002'); assert.equal(challenge.method, 'incoming'); assert.equal(challenge.verified, false);
    assert.equal(challenge.code, undefined); assert.equal(challenge.providerId, undefined);
    assert.deepEqual((await request(client, { ...start, Action: 'phone-resend' })).data, started.data);
    assert.equal((await state()).calls.length, 1);
    const stranger = {}; await request(stranger);
    assert.equal((await request(stranger, { ...payload, Action: 'phone-status', ChallengeId: challenge.challengeId })).data.Code, 'phone_session');
    const checked = await request(client, { ...payload, Action: 'phone-status', ChallengeId: challenge.challengeId, RecaptchaToken: '' });
    assert.equal(checked.data.phoneVerification.verified, true);
    assert.equal((await request(client, { ...payload, RecaptchaToken: '' })).status, 422, 'Final submit needs fresh CAPTCHA');
    assert.equal((await state()).sends.length, 0);
    const done = await request(client, payload); assert.equal(done.status, 200, done.text + log);
    assert.equal(done.data.IsSuccess, true); assert.equal(done.data.TestMode, undefined); assert.match(done.data.Receipt, /^[a-f0-9]{32}$/);
    assert.deepEqual((await request(client, payload)).data, done.data, 'Same-session retry reuses receipt');
    assert.equal((await state()).sends.length, 1); assert.equal((await state()).sends[0].Phone, payload.Phone);
    assert.equal((await request(stranger, payload)).data.Code, 'phone_confirmation_required', 'Existing registration remains private before proof');
    await patchState({ now: 100061 });
    const another = await verifiedClient(payload);
    const duplicate = await request(another, { ...payload, FirstName: 'Другой тест' });
    assert.equal(duplicate.data.IsSuccess, true); assert.equal(duplicate.data.AlreadyRegistered, true);
    assert.equal(duplicate.data.Receipt, done.data.Receipt); assert.equal((await state()).sends.length, 1, 'Ledger prevents a second FlexBonus send across sessions');
    const uncertainPayload = { ...payload, Phone: '+70000000003' };
    await patchState({ outcome: 'unknown' });
    const uncertainClient = await verifiedClient(uncertainPayload);
    const uncertain = await request(uncertainClient, uncertainPayload);
    assert.equal(uncertain.status, 502); assert.equal(uncertain.data.Outcome, 'unknown'); assert.equal((await state()).sends.length, 2);
    await patchState({ now: 100122, outcome: 'success' });
    const retryClient = await verifiedClient(uncertainPayload);
    const blocked = await request(retryClient, uncertainPayload);
    assert.equal(blocked.data.IsSuccess, false); assert.equal(blocked.data.Outcome, 'unknown');
    assert.equal(blocked.data.Receipt, uncertain.data.Receipt); assert.equal((await state()).sends.length, 2, 'Uncertain outcomes never retry automatically, even in a fresh session');
    for (const filename of (await readdir(path.join(privateDir, 'consents'))).filter(name => name.endsWith('.json'))) {
      const text = await readFile(path.join(privateDir, 'consents', filename), 'utf8');
      assert.doesNotMatch(text, /70000000001|70000000003|Тестов|1990-01-01|fixture-captcha/);
      assert.equal(JSON.parse(text).registration_guard, 'phone-v1');
    }
    assert.doesNotMatch((await readFile(path.join(privateDir, 'registration-data/ledger.sqlite'))).toString('latin1'), /70000000001|70000000003/);
    assert.doesNotMatch(log, /Warning|Fatal error|undefined function|fixture-flashcall-only|fixture-flex-only/);
  } finally {
    if (server?.exitCode === null) { const done = once(server, 'exit'); server.kill(); await done; }
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir())); assert.ok(path.basename(temp).startsWith('cafe-production-registration-'));
    await rm(temp, { recursive: true, force: true });
  }
});

test('registration browser waits for incoming confirmation and rejects a changed provider profile', async () => {
  const source = (await readFile('dist-reg/site/registration.js', 'utf8')).replace(/^import .*;\r?$/gm, '')
    .replace(/await import\('\.\/phone-verification\.js[^']*'\)/, '__phoneModule');
  assert.doesNotMatch(source, /await import\(/);
  for (const mismatched of [false, true]) {
    const listeners = new Map(), elements = new Map(), requests = []; let phoneCheck;
    const element = () => ({ value: '', checked: true, hidden: false, textContent: '', dataset: {}, addEventListener() {}, setCustomValidity() {}, setAttribute() {}, removeAttribute() {}, focus() {} });
    for (const id of ['registration-form', 'submit-button', 'form-message', 'birth-date', 'phone', 'phone-consent', 'captcha-status', 'captcha-privacy', 'captcha-notice', 'registration-success']) elements.set(id, element());
    const fields = new Map(['ConsentVersion', 'Consent', 'FirstName', 'LastName', 'MiddleName', 'BirthDate', 'Comment'].map(name => [name, element()]));
    fields.get('ConsentVersion').value = 'fixture-version'; fields.get('FirstName').value = 'Тест'; fields.get('LastName').value = 'Тестов'; fields.get('BirthDate').value = '1990-01-01';
    const form = elements.get('registration-form'); form.elements = { namedItem: name => fields.get(name) };
    form.dataset = { phoneVerification: 'true', phoneProvider: 'flashcall', phonePresentation: 'guest' };
    form.addEventListener = (type, callback) => listeners.set(type, callback); form.reportValidity = () => true; form.reset = () => {}; form.classList = { toggle() {} };
    elements.get('phone').value = '+70000000001';
    const window = { grecaptcha: { render: () => 0, getResponse: () => 'fixture-captcha', reset() {} } };
    const document = { getElementById: id => elements.get(id) ?? null, querySelector: () => element(), createElement: () => element(), head: { appendChild() { window.onLoyaltyCaptchaLoad(); } } };
    const cookieConsent = { allowed: () => true, request: async () => true, subscribe() {} };
    const fetch = async (url, options) => {
      assert.equal(url, 'api/register.php'); requests.push(options);
      const body = options.body ? JSON.parse(options.body) : null;
      const data = body ? body.Action === 'phone-start' ? { IsSuccess: true, phoneVerification: { challengeId: 'a'.repeat(32), verified: false } } : { IsSuccess: true }
        : { csrf: 'fixture-csrf', consentVersion: 'fixture-version', recaptchaRequired: true, recaptchaSiteKey: 'fixture-site', recaptchaMode: 'checkbox', phoneVerificationRequired: true, phoneTestMode: false, phoneVerificationProvider: mismatched ? 'old-provider' : 'flashcall', phoneVerificationMethod: 'incoming' };
      return { ok: true, status: 200, json: async () => data };
    };
    class MockPhoneVerification {
      constructor(options) { this.options = options; this.challenge = null; this.number = ''; phoneCheck = this; }
      configure(required, test) { this.required = required; this.test = test; }
      async confirm(payload) {
        if (this.challenge?.verified) return true;
        const data = await this.options.request({ ...payload, Action: 'phone-start' });
        this.number = payload.Phone; this.challenge = { id: data.phoneVerification.challengeId, verified: false }; this.options.onChange(); return false;
      }
      reset() { this.challenge = null; }
      dispose() { this.disposed = true; }
    }
    class FormData { get(name) { return name === 'Consent' ? 'on' : fields.get(name)?.value; } }
    const attachBirthDateInput = () => ({ validate() {}, value: () => fields.get('BirthDate').value });
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction('document', 'window', 'cookieConsent', 'fetch', 'FormData', 'location', 'attachBirthDateInput', '__phoneModule', source)(
      document, window, cookieConsent, fetch, FormData, { href: 'https://vosem-utra.ru/registration.html' }, attachBirthDateInput,
      { PhoneVerification: MockPhoneVerification, phoneErrorMessage: data => data.Message });
    assert.equal(requests.length, 0, 'Loading the page never starts a call, server session or CAPTCHA request');
    assert.equal(elements.get('submit-button').textContent, 'Подтвердить номер');
    await listeners.get('submit')({ preventDefault() {} });
    const posts = () => requests.filter(request => request.method === 'POST').map(request => JSON.parse(request.body));
    if (mismatched) {
      assert.equal(posts().length, 0); assert.match(elements.get('form-message').textContent, /Способ подтверждения изменился/);
    } else {
      assert.deepEqual(posts().map(body => body.Action), ['phone-start']);
      assert.equal(form.hidden, false); assert.equal(elements.get('submit-button').hidden, true);
      phoneCheck.challenge.verified = true;
      await listeners.get('submit')({ preventDefault() {} });
      const sent = posts(); assert.equal(sent.length, 2); assert.equal(sent[1].Action, undefined);
      assert.equal(sent[1].Phone, '+70000000001'); assert.equal(sent[1].PhoneConsent, true);
      assert.equal(sent[1].RecaptchaToken, 'fixture-captcha'); assert.equal(sent[1].Code, undefined);
      assert.equal(form.hidden, true); assert.equal(elements.get('registration-success').hidden, false); assert.equal(phoneCheck.disposed, true);
    }
  }
});
