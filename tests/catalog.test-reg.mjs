import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createDecipheriv } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { phpBinary, phpEnvironment } from '../scripts/php-runtime.mjs';
import { profileHtml } from '../scripts/site-profile.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('catalog packages exclude delivery assets and keep a versioned privacy archive', async () => {
  for (const folder of ['dist-reg', 'dist-reg-test']) {
    const dir = path.join(root, folder), app = path.join(dir,'vosem-utra-private/app');
    const files = await readdir(app);
    assert.ok(!files.some(name => /^(?:orders\.php|kds-|staff-|telegram)/.test(name)));
    assert.deepEqual((await readdir(path.join(app,'templates'))).sort(), ['admin.html','consent.html','index.html','privacy.html','registration.html']);
    const assets = await readdir(path.join(dir,'site/assets'));
    assert.ok(!assets.some(name => /^(?:cart|checkout|staff|kds-status|order-client)[-.]/.test(name)));
    const home = await readFile(path.join(app,'templates/index.html'),'utf8');
    assert.doesNotMatch(home,/data-cart-|dish-cart-actions|В корзину|checkout\.html/);
    const registration = await readFile(path.join(app,'templates/registration.html'),'utf8');
    const sourceRegistration = await readFile(path.join(root,'registration.html'),'utf8');
    const panel = /<aside\b[^>]*class="brand-panel"[^>]*>[\s\S]*?<\/aside>/;
    assert.equal(registration.match(panel)?.[0], sourceRegistration.match(panel)?.[0], 'The actual hosting form uses the current club benefits');
    assert.match(registration,/500 ₽/);
    assert.doesNotMatch(registration,/data-preview="true"|Регистрация скоро откроется/);
    assert.match(registration,/name="ConsentVersion"|id="recaptcha-widget"/);
    assert.match(registration,/href="registration\.css\?v=[a-f0-9]{12}"/);
    assert.deepEqual(await readFile(path.join(dir,'site/registration.css')), await readFile(path.join(root,'registration.css')));
    const privacy = await readFile(path.join(app,'templates/privacy.html'),'utf8');
    assert.doesNotMatch(privacy,/vosem_cart_v1|vosem_order_guest|оформления заказа|отправка заказов/);
    assert.match(privacy,/vosem_admin/);
    const consent = await readFile(path.join(dir,'site/api/consent-log.php'),'utf8');
    const phoneBuild = /data-phone-verification="true"/.test(registration);
    const version = phoneBuild ? '2026-10-02-reg7' : '2026-10-01-reg6';
    assert.ok(consent.includes(version));
    for (const page of ['privacy','consent']) {
      assert.deepEqual(await readFile(path.join(app,'templates',`${page}.html`)), await readFile(path.join(dir,`vosem-utra-private/legal-versions/${version}`,`${page}.html`)));
    }
  }
  const source = await readFile(path.join(root,'index.html'),'utf8');
  assert.match(profileHtml(source,true),/data-cart-open/);
  assert.doesNotMatch(profileHtml(source,false),/data-cart-open|src="cart.js"/);
});

test('catalog update disables old delivery configuration and supports authenticated manual dish CRUD', { timeout: 60000 }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(),'cafe-catalog-'));
  const privateDir = path.join(temp,'vosem-utra-private'), site = path.join(temp,'site');
  const socket = net.createServer().listen(0,'127.0.0.1'); await once(socket,'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const password = 'catalog-fixture-' + randomBytes(16).toString('hex');
  const hash = spawnSync(phpBinary,['-r','echo password_hash(stream_get_contents(STDIN), PASSWORD_ARGON2ID);'], { input:password, encoding:'utf8', env:phpEnvironment });
  assert.equal(hash.status,0,hash.stderr);
  let server, log='', cookie='', csrf='';
  async function request(url,{ method='GET', body, authorized=false, headers={} }={}) {
    const response = await fetch(origin+url,{method,headers:{Origin:origin,...(authorized?{Cookie:cookie,'X-CSRF-Token':csrf}:{}),...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});
    const text = await response.text(); let json; try{json=JSON.parse(text);}catch{}
    return {status:response.status,text,json,response};
  }
  try {
    await cp(path.join(root,'dist-reg'),temp,{recursive:true});
    const config={ publicOrigin:'https://vosem-utra.ru',username:'owner@example.test',passwordHash:hash.stdout,encryptionKey:randomBytes(32).toString('hex'),delivery_enabled:true,keeper_enabled:true,telegram_enabled:true };
    await writeFile(path.join(privateDir,'admin-config.php'),`<?php return json_decode('${JSON.stringify(config)}',true);`);
    // Simulate an update over an older fully enabled installation.
    await writeFile(path.join(privateDir,'kds-config.json'),'{ deliberately invalid old configuration');
    await writeFile(path.join(privateDir,'orders-config.php'),"<?php throw new RuntimeException('Old orders config must not be loaded');");
    await writeFile(path.join(privateDir,'app/orders.php'),"<?php throw new RuntimeException('Excluded old module must not be loaded');");
    await mkdir(path.join(privateDir,'orders-data'),{recursive:true});
    const history = path.join(privateDir,'orders-data/history.fixture'); await writeFile(history,'preserved-order-history');
    server=spawn(phpBinary,['-S',`127.0.0.1:${port}`,'-t',site,path.join(root,'hosting/dev-router.php')],{windowsHide:true,env:{...phpEnvironment,CAFE_ENV:'development'},stdio:['ignore','ignore','pipe']});
    server.stderr.on('data',chunk=>{log+=chunk;});
    for(let i=0;i<60;i++){try{await fetch(origin+'/robots.txt');break;}catch{await pause(50);}}
    await t.test('old order pages and APIs are blocked; menu, registration and admin remain available',async()=>{
      for(const url of ['/checkout.html','/order-terms.html','/staff.html','/staff-demo.html','/api/ordering','/api/orders','/api/staff/session','/api/telegram/webhook','/api/admin/sync-availability']) {
        for(const method of ['GET','POST']) assert.equal((await request(url,{method,body:method==='POST'?{}:undefined})).status,404,url);
      }
      for(const url of ['/','/admin.html','/registration.html','/privacy.html','/consent.html','/api/menu']) assert.equal((await request(url)).status,200,url+log);
      const home=await request('/'); assert.doesNotMatch(home.text,/data-cart-|В корзину|Оформить заказ/);
      assert.match(home.text,/dish-card/); assert.match(home.response.headers.get('X-Robots-Tag'),/noindex/);
    });
    await t.test('password protects manual edits and obsolete MFA endpoints are disabled',async()=>{
      assert.equal((await request('/api/admin/menu',{method:'PUT',body:{items:[],revision:1}})).status,401);
      const status=(await request('/api/admin/session')).json;assert.equal(status.authMode,'password');assert.equal(status.mfaRequired,false);
      for(const route of ['verify','resume','enroll/start','enroll/confirm']) assert.equal((await request('/api/admin/'+route,{method:'POST',body:{}})).status,404);
      assert.equal((await request('/api/admin/login',{method:'POST',body:{username:'owner@example.test',password:'incorrect'}})).status,401);
      const login=await request('/api/admin/login',{method:'POST',body:{username:'owner@example.test',password}});
      assert.equal(login.status,200,login.text);assert.equal(login.json.authMode,'password');
      csrf=login.json.csrfToken;cookie=login.response.headers.get('Set-Cookie').split(';')[0];
      const menu=(await request('/api/admin/menu',{authorized:true})).json;
      const dish={id:'manual-catalog-fixture',name:'Тост <script>alert(1)</script>',description:'Яйцо, авокадо',price:420,category:menu.categories[0].id,image:'',order:300,published:true,availableForOrder:true};
      const payload={...menu,items:[...menu.items,dish]};
      assert.equal((await request('/api/admin/menu',{method:'PUT',authorized:true,headers:{'X-CSRF-Token':''},body:payload})).status,403);
      assert.equal((await request('/api/admin/menu',{method:'PUT',authorized:true,headers:{Origin:'https://foreign.invalid'},body:payload})).status,403);
      const forged={...payload,items:[...menu.items,{...dish,source:{provider:'kds',organizationId:'forged',externalId:'1'}}]};
      assert.equal((await request('/api/admin/menu',{method:'PUT',authorized:true,body:forged})).status,400);
      const created=await request('/api/admin/menu',{method:'PUT',authorized:true,body:payload});assert.equal(created.status,200,created.text);
      assert.ok(created.json.items.some(item=>item.id===dish.id));
      assert.equal((await request('/api/admin/menu',{method:'PUT',authorized:true,body:payload})).status,409);
      let home=await request('/');assert.match(home.text,/Тост &lt;script&gt;/);assert.doesNotMatch(home.text,/<script>alert\(1\)/);
      const edited=await request('/api/admin/menu',{method:'PUT',authorized:true,body:{...created.json,items:created.json.items.map(item=>item.id===dish.id?{...item,name:'Новый тост',price:440}:item)}});assert.equal(edited.status,200,edited.text);
      assert.match((await request('/')).text,/Новый тост/);
      const hidden=await request('/api/admin/menu',{method:'PUT',authorized:true,body:{...edited.json,items:edited.json.items.map(item=>item.id===dish.id?{...item,hiddenOnSite:true}:item)}});
      assert.equal(hidden.status,200,hidden.text);
      const hiddenDish=hidden.json.items.find(item=>item.id===dish.id);
      assert.equal(hiddenDish.hiddenOnSite,true);assert.equal(hiddenDish.category,dish.category);assert.equal(hiddenDish.published,false);assert.equal(hiddenDish.availableForOrder,false);
      for(const url of ['/api/menu','/data/menu.json']) assert.ok(!(await request(url)).json.items.some(item=>item.id===dish.id),url);
      assert.doesNotMatch((await request('/')).text,/Новый тост/,'Hidden dishes must not leak through SSR or structured data');
      const reloaded=(await request('/api/admin/menu',{authorized:true})).json;
      assert.deepEqual(reloaded.items.find(item=>item.id===dish.id),hiddenDish);
      for(const hiddenOnSite of [null,'true',1]) {
        assert.equal((await request('/api/admin/menu',{method:'PUT',authorized:true,body:{...reloaded,items:reloaded.items.map(item=>item.id===dish.id?{...item,hiddenOnSite}:item)}})).status,400);
      }
      const shown=await request('/api/admin/menu',{method:'PUT',authorized:true,body:{...reloaded,items:reloaded.items.map(item=>item.id===dish.id?{...item,hiddenOnSite:false}:item)}});
      assert.equal(shown.status,200,shown.text);assert.match((await request('/')).text,/Новый тост/);
      const removed=await request('/api/admin/menu',{method:'PUT',authorized:true,body:{...shown.json,items:shown.json.items.filter(item=>item.id!==dish.id)}});assert.equal(removed.status,200,removed.text);
      assert.doesNotMatch((await request('/')).text,/Новый тост/);
    });
    await t.test('email recovery HTTP routes enforce origin, single-use codes and password login after reset', async()=>{
      const endpoint='/api/admin/password-reset/';
      assert.equal((await request(endpoint+'request',{method:'POST',body:{email:'owner@example.test'}})).status,503);
      const before=JSON.parse(await readFile(path.join(privateDir,'admin-data/auth-state.json'),'utf8'));
      await writeFile(path.join(privateDir,'password-reset-mail.json'), JSON.stringify({enabled:true,transport:'smtp',host:'smtp.example.test',port:465,encryption:'smtps',from:'sender@example.test',username:'sender',password:'fake-test-only'}));
      // REG.RU cron starts in the hosting home, which contains both site/private directories.
      // CLI DOCUMENT_ROOT is empty; this must not be confused with its working directory.
      const worker = spawnSync(phpBinary,[path.join(privateDir,'auth-mail-worker.php')],{cwd:temp,env:{...phpEnvironment,CAFE_ENV:'production'},encoding:'utf8'});
      assert.equal(worker.status,0,worker.stdout+worker.stderr);
      const report=JSON.parse(await readFile(path.join(privateDir,'auth-mail-status.json'),'utf8'));
      assert.equal(report.status,'ok');assert.equal(report.sent,0);assert.equal(report.failed,0);
      assert.doesNotMatch(JSON.stringify(report),/fake-test-only|owner@example/);
      assert.ok(!JSON.stringify(report).includes(config.encryptionKey));
      assert.equal((await request(endpoint+'request',{method:'POST',headers:{Origin:'https://foreign.invalid'},body:{email:'owner@example.test'}})).status,403);
      const reset=await request(endpoint+'request',{method:'POST',body:{email:'owner@example.test'}});
      assert.equal(reset.status,202,reset.text); assert.match(reset.json.resetToken,/^[a-f0-9]{64}$/); assert.equal(reset.json.code,undefined);
      assert.match(reset.response.headers.get('Cache-Control'),/no-store/);
      const unknown=await request(endpoint+'request',{method:'POST',body:{email:'unknown@example.test'}});
      assert.equal(unknown.status,202); assert.equal(unknown.json.message,reset.json.message);
      const queue=path.join(privateDir,'admin-data/reset-mail');
      const jobs=(await readdir(queue)).filter(x=>x.endsWith('.json'));assert.equal(jobs.length,1);
      const job=JSON.parse(await readFile(path.join(queue,jobs[0]),'utf8'));
      const decipher=createDecipheriv('aes-256-gcm',Buffer.from(config.encryptionKey,'hex'),Buffer.from(job.iv,'hex'));
      decipher.setAAD(Buffer.from('cafe-reset-mail:'+job.id));decipher.setAuthTag(Buffer.from(job.tag,'hex'));
      const mail=JSON.parse(Buffer.concat([decipher.update(Buffer.from(job.ciphertext,'base64')),decipher.final()]).toString('utf8'));
      const code=mail.body.match(/пароля: ([0-9]{8})/)[1];assert.equal(mail.to,'owner@example.test');
      const resend=await request(endpoint+'request',{method:'POST',body:{email:'owner@example.test'}});
      assert.equal(resend.status,429);assert.ok(Number(resend.response.headers.get('Retry-After'))<=60);
      assert.equal((await request(endpoint+'verify',{method:'POST',headers:{Origin:'https://foreign.invalid'},body:{email:'owner@example.test',code}})).status,403);
      const verified=await request(endpoint+'verify',{method:'POST',body:{email:'owner@example.test',code}});
      assert.equal(verified.status,200,verified.text);assert.equal(verified.response.headers.get('Set-Cookie'),null);
      assert.equal((await readdir(queue)).filter(x=>x.endsWith('.json')).length,1);
      assert.equal((await request(endpoint+'verify',{method:'POST',body:{resetToken:reset.json.resetToken,code}})).status,400);
      assert.equal((await request(endpoint+'complete',{method:'POST',headers:{Origin:'https://foreign.invalid'},body:{passwordToken:verified.json.passwordToken,password:'changed-test-password'}})).status,403);
      const completed=await request(endpoint+'complete',{method:'POST',body:{passwordToken:verified.json.passwordToken,password:'changed-test-password'}});
      assert.equal(completed.status,200,completed.text);assert.deepEqual(completed.json,{passwordChanged:true});assert.equal(completed.response.headers.get('Set-Cookie'),null);
      assert.equal((await request('/api/admin/menu',{authorized:true})).status,401);
      const after=JSON.parse(await readFile(path.join(privateDir,'admin-data/auth-state.json'),'utf8'));
      assert.deepEqual(after.account.totp,before.account.totp);assert.deepEqual(after.account.recovery,before.account.recovery);
      const login=await request('/api/admin/login',{method:'POST',body:{username:'owner@example.test',password:'changed-test-password'}});
      assert.equal(login.status,200,login.text);assert.equal(login.json.authMode,'password');assert.equal(login.json.authenticated,true);
      assert.equal((await request(endpoint+'complete',{method:'POST',body:{passwordToken:verified.json.passwordToken,password:'another-test-password'}})).status,400);
    });
    await t.test('scheduled delivery entry points are inert and history is retained',async()=>{
      for(const worker of ['kds-worker.php','telegram-worker.php']) {
        const result=spawnSync(phpBinary,[path.join(privateDir,worker),`--private-dir=${privateDir}`],{encoding:'utf8',env:phpEnvironment});
        assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/disabled/);
      }
      assert.equal(await readFile(history,'utf8'),'preserved-order-history');
      assert.match(await readFile(path.join(privateDir,'kds-config.json'),'utf8'),/deliberately invalid/);
    });
  } finally {
    if(server?.exitCode===null){const done=once(server,'exit');server.kill();await done;}
    assert.equal(path.dirname(temp),path.resolve(os.tmpdir())); assert.ok(path.basename(temp).startsWith('cafe-catalog-'));
    await rm(temp,{recursive:true,force:true});
  }
});
