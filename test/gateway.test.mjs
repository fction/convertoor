import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {handleGateway} from '../api/gateway.mjs';
import {lifetime,newAccount} from '../lib/account.mjs';
import {createLoginThrottle} from '../lib/login-throttle.mjs';
import {createBlobSessions} from '../lib/sessions.mjs';

test('a full throttle still serves known addresses and expires only elapsed windows', () => {
  const throttle = createLoginThrottle(2);
  assert.equal(throttle.reserve('first',0),0);
  assert.equal(throttle.reserve('second',15000),0);
  for (let i=0; i<5; i++) assert.equal(throttle.reserve('first',40000),0);
  assert.equal(throttle.reserve('first',40000),560);
  assert.equal(throttle.reserve('third',599000),1);
  assert.equal(throttle.reserve('third',600000),0);
  assert.equal(throttle.reserve('second',600000),0);
  throttle.clear('third');
  assert.equal(throttle.reserve('first',600000),0);
});

test('independent gateways revoke the same ticket immediately and fail closed during storage outages', async t => {
  const account = await newAccount('reader','sample password');
  const previous = process.env.CONVERTOOR_ACCOUNT;
  process.env.CONVERTOOR_ACCOUNT = JSON.stringify(account);
  t.after(() => {
    if (previous === undefined) delete process.env.CONVERTOOR_ACCOUNT;
    else process.env.CONVERTOOR_ACCOUNT = previous;
  });
  const records = new Map();
  let unavailable = false;
  const storage = {
    async put(path, body, options) {
      if (unavailable) throw Error('test outage');
      assert.match(path,/^sessions\/v2\/[\da-f]{64}$/);
      assert.equal(options.access,'private');
      assert.equal(options.ttlDays,1);
      assert.equal(options.allowOverwrite,body === 'revoked');
      records.set(path,body);
    },
    async get(path, options) {
      if (unavailable) throw Error('test outage');
      assert.equal(options.useCache,false);
      assert.equal(options.access,'private');
      return records.has(path) ? {statusCode:200,stream:new Response(records.get(path)).body} : null;
    }
  };
  async function startInstance() {
    const store = createBlobSessions(storage);
    const server = http.createServer((req,res) => handleGateway(req,res,store));
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    return 'http://127.0.0.1:' + server.address().port;
  }

  const origin = await startInstance();
  const second = await startInstance() + '/api/gateway?view=';
  const endpoint = origin + '/api/gateway?view=';
  const guest = await fetch(endpoint + 'webp-frame');
  assert.equal(guest.status,401);
  assert.match(guest.headers.get('Cache-Control'),/no-store/);

  const publicOrigin = process.env.VERCEL || process.env.NODE_ENV === 'production' ? origin.replace('http:', 'https:') : origin;
  const login = () => fetch(endpoint + 'login',{
    method:'POST', headers:{Origin:publicOrigin,'Content-Type':'application/json'},
    body:JSON.stringify({login:'reader',password:'sample password'})
  });
  const signedIn = await login();
  assert.equal(signedIn.status,200);
  const cookie = signedIn.headers.get('Set-Cookie').split(';')[0];
  const session = await (await fetch(second + 'session',{headers:{Cookie:cookie}})).json();
  assert.equal(session.login,'reader');
  assert.ok(session.remainingMs > 0 && session.remainingMs <= lifetime * 1000);
  assert.ok(Math.abs(session.expires - session.remainingMs - Date.now()) < 5000);
  const module = await fetch(endpoint + 'webp-frame',{headers:{Cookie:cookie}});
  assert.equal(module.status,200);
  assert.match(module.headers.get('Content-Type'),/javascript/);
  const independentCookie = (await login()).headers.get('Set-Cookie').split(';')[0];
  const logout = () => fetch(endpoint + 'logout',{method:'POST',
    headers:{Cookie:cookie,Origin:publicOrigin,'Content-Type':'application/json'},body:'{}'});
  unavailable = true;
  assert.equal((await fetch(second+'session',{headers:{Cookie:cookie}})).status,503);
  const failedLogout = await logout();
  assert.equal(failedLogout.status,503);
  assert.equal(failedLogout.headers.has('Set-Cookie'),false);
  const failedLogin = await login();
  assert.equal(failedLogin.status,503);
  assert.equal(failedLogin.headers.has('Set-Cookie'),false);
  unavailable = false;
  const signedOut = await logout();
  assert.equal(signedOut.status,200);
  assert.match(signedOut.headers.get('Set-Cookie'),/Max-Age=0/);
  for (const route of ['session','client','disk-output','engine-worker','download-worker']) {
    assert.equal((await fetch(second+route,{headers:{Cookie:cookie}})).status,401);
  }
  assert.equal((await fetch(second+'studio',{headers:{Cookie:cookie},redirect:'manual'})).status,303);
  assert.equal((await fetch(second+'session',{headers:{Cookie:independentCookie}})).status,200);
  assert.equal((await logout()).status,200);
});
